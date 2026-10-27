/**
 * Food recall alerts — fetched live, nothing stored in Firestore.
 *
 *  - `getRecalls` (callable) returns the latest FDA + USDA FSIS food recalls for the app's
 *    Recalls screen. For signed-in shoppers it also flags recalls that mention something they
 *    bought recently ("You may have bought this"), using the same item names as SmartList.
 *
 * Recalls are public data, so there's no reason to keep a copy: each function instance fetches
 * both sources at most every 6 hours (pull-to-refresh: at most every 30 minutes) and keeps the
 * result in memory. A cold instance fetches on
 * its first call; a failed fetch keeps serving the last good list. The app never calls the
 * government APIs directly.
 */
import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getAuth } from "firebase-admin/auth";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { groupItems } from "../shopping/itemGrouping";
import { loadAliases } from "../shopping/naming";
import { Recall, fetchFdaRecalls, fetchFsisRecalls } from "./sources";
import { PurchasedItem, RecallMatch, matchRecall } from "./match";

const KEEP_DAYS = 60;
const MATCH_HISTORY_DAYS = 45;
const MAX_RESULTS = 50;
/** How long a fetched list is reused before fetching again. */
const CACHE_MS = 6 * 3_600_000;
/** After a failed or empty fetch, wait this long before trying the sources again. */
const RETRY_GAP_MS = 10 * 60_000;
/** Minimum gap between fetches forced by pull-to-refresh. */
const REFRESH_GAP_MS = 60_000;
/**
 * Pull-to-refresh only refetches a list at least this old. FDA and USDA publish a handful of
 * recalls a day, so fresher data isn't worth the calls — and openFDA/FSIS may throttle heavy
 * users. Everyone's refresh within this window is served from memory.
 */
const REFRESH_MIN_AGE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;

export interface RecallDto {
  id: string;
  source: "FDA" | "USDA";
  title: string;
  excerpt: string;
  url: string;
  publishedAt: string;
  classification: string | null;
  /** Set when the recall mentions an item from the shopper's recent receipts. */
  match: RecallMatch | null;
}

// ---------- in-memory cache (per function instance) ----------

let cached: { recalls: Recall[]; fetchedAt: number } | null = null;
let lastAttemptAt = 0;
let inFlight: Promise<Recall[]> | null = null;

/** Fetches both sources: last KEEP_DAYS days, newest first, capped at MAX_RESULTS. */
async function fetchRecalls(): Promise<Recall[]> {
  const since = Date.now() - KEEP_DAYS * DAY_MS;
  const [fda, usda] = await Promise.all([
    fetchFdaRecalls().catch((e) => { logger.warn("recalls: FDA fetch failed", e); return [] as Recall[]; }),
    fetchFsisRecalls(since).catch((e) => { logger.warn("recalls: USDA fetch failed", e); return [] as Recall[]; }),
  ]);
  const byId = new Map<string, Recall>();
  for (const r of [...fda, ...usda]) {
    if (Date.parse(r.publishedAt) >= since && !byId.has(r.id)) byId.set(r.id, r);
  }
  const recalls = [...byId.values()]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MAX_RESULTS);
  logger.info(`recalls: fetched fda=${fda.length} usda=${usda.length} kept=${recalls.length}`);
  return recalls;
}

/** The cached list, refetched when stale (or on refresh), never hammering a failing source. */
async function currentRecalls(requestedRefresh: boolean): Promise<Recall[]> {
  const now = Date.now();
  const refresh = requestedRefresh && (cached === null || now - cached.fetchedAt >= REFRESH_MIN_AGE_MS);
  const fresh = cached !== null && cached.recalls.length > 0 && now - cached.fetchedAt < CACHE_MS;
  const gap = refresh ? REFRESH_GAP_MS : RETRY_GAP_MS;
  if ((fresh && !refresh) || now - lastAttemptAt < gap) return cached?.recalls ?? [];

  // One fetch at a time per instance; concurrent callers share it.
  inFlight ??= (async () => {
    lastAttemptAt = Date.now();
    try {
      const recalls = await fetchRecalls();
      if (recalls.length > 0) cached = { recalls, fetchedAt: Date.now() };
      // An empty result keeps the last good list: the sources are flaky behind bot protection.
      return cached?.recalls ?? recalls;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Generic names of what the shopper bought recently, with the latest purchase date. */
async function purchasedItems(uid: string): Promise<PurchasedItem[]> {
  const db = getFirestore();
  const cutoff = Timestamp.fromMillis(Date.now() - MATCH_HISTORY_DAYS * DAY_MS);
  const [receiptsSnap, linesSnap] = await Promise.all([
    db.collection(`users/${uid}/receipts`)
      .where("deletedAt", "==", null).where("purchaseDate", ">=", cutoff).orderBy("purchaseDate", "desc").get(),
    db.collectionGroup("lineItems")
      .where("uid", "==", uid).where("purchaseDate", ">=", cutoff).orderBy("purchaseDate", "desc").get(),
  ]);
  const live = new Set(receiptsSnap.docs.map((d) => d.id));
  const lines: Array<{ raw: string; date: string }> = [];
  for (const doc of linesSnap.docs) {
    if (!live.has(String(doc.get("receiptId") ?? "")) || doc.get("isDuplicate") === true) continue;
    const raw = String(doc.get("rawDescription") ?? "").trim();
    const ts = doc.get("purchaseDate") as Timestamp | undefined;
    if (raw && ts) lines.push({ raw, date: ts.toDate().toISOString().slice(0, 10) });
  }
  if (lines.length === 0) return [];

  const rawNames = lines.map((l) => l.raw);
  const aliases = await loadAliases(rawNames);
  const grouping = groupItems(rawNames, aliases);
  const latest = new Map<string, string>();
  for (const l of lines) {
    if (aliases.get(l.raw.toLowerCase()) === "") continue; // known non-product (tax, bag fee…)
    const key = grouping.keyByRaw.get(l.raw);
    if (!key) continue; // unresolved abbreviations: too unreliable to match on
    if ((latest.get(key) ?? "") < l.date) latest.set(key, l.date);
  }
  return [...latest].map(([key, lastBought]) => ({ name: grouping.displayName.get(key) ?? key, lastBought }));
}

export const getRecalls = onCall(
  // A few instances are plenty for a list that changes a few times a day; capping them also caps
  // how often the government sources get called (each instance keeps its own copy).
  { region: REGION, timeoutSeconds: 60, memory: "512MiB", maxInstances: 5 },
  async (request) => {
    // Recalls are public; matching needs the shopper's synced receipts, so signed-in only.
    const uid = request.auth?.uid;
    let signedIn = false;
    if (uid && request.auth?.token.firebase?.sign_in_provider !== "anonymous") {
      const user = await getAuth().getUser(uid).catch(() => null);
      signedIn = !!user && (!!user.email || user.providerData.length > 0);
    }

    const refresh = request.data?.refresh === true;
    const recalls = await currentRecalls(refresh);
    logger.info(`getRecalls: returning ${recalls.length} recalls (signedIn=${signedIn})`);

    const items = signedIn && uid ? await purchasedItems(uid).catch((e) => {
      logger.warn(`getRecalls: purchase history failed for ${uid}`, e);
      return [] as PurchasedItem[];
    }) : [];

    const out: RecallDto[] = recalls.map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      excerpt: r.excerpt,
      url: r.url,
      publishedAt: r.publishedAt,
      classification: r.classification ?? null,
      match: items.length > 0 ? matchRecall(r.matchText || r.title, items) : null,
    }));
    return { signedIn, recalls: out, matchedCount: out.filter((r) => r.match).length };
  },
);
