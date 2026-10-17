/**
 * Food recall alerts.
 *
 *  - `syncRecalls` (every 6 hours) pulls new FDA + USDA FSIS food recalls into `/recalls`.
 *  - `getRecalls` (callable) returns the latest recalls for the Alerts screen. For signed-in
 *    shoppers it also flags recalls that mention something they bought recently
 *    ("You may have bought this"), using the same item names as SmartList.
 *
 * The app never calls the government APIs directly: one server fetch serves every user.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getAuth } from "firebase-admin/auth";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { groupItems } from "../shopping/itemGrouping";
import { loadAliases } from "../shopping/naming";
import { Recall, fetchFdaRecalls, fetchFsisRecalls } from "./sources";
import { PurchasedItem, RecallMatch, matchRecall } from "./match";

const RECALLS = "recalls";
const META_DOC = "recallsMeta/sync";
const KEEP_DAYS = 60;
const MATCH_HISTORY_DAYS = 45;
const MAX_RESULTS = 50;
const SYNC_EVERY_MS = 6 * 3_600_000;
/** Minimum gap between inline sync attempts when the last one found nothing. */
const RETRY_GAP_MS = 10 * 60_000;
/** Same, for an explicit refresh from the app. */
const REFRESH_GAP_MS = 60_000;
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

/** Fetches both sources and upserts recent recalls. Returns how many were written. */
export async function syncRecallsNow(): Promise<number> {
  const db = getFirestore();
  const since = Date.now() - KEEP_DAYS * DAY_MS;
  const [fda, usda] = await Promise.all([fetchFdaRecalls(), fetchFsisRecalls(since)]);
  const fresh = [...fda, ...usda].filter((r) => Date.parse(r.publishedAt) >= since);
  const batch = db.batch();
  for (const r of fresh) {
    batch.set(db.collection(RECALLS).doc(r.id), {
      ...r,
      classification: r.classification ?? null,
      publishedAtTs: Timestamp.fromMillis(Date.parse(r.publishedAt)),
      updatedAt: Timestamp.now(),
    }, { merge: true });
  }
  // An empty fetch is treated as a failed sync, so the next app open retries instead of
  // waiting 12 hours behind an "up to date" timestamp.
  batch.set(db.doc(META_DOC), {
    lastAttemptAt: Timestamp.now(),
    ...(fresh.length > 0 ? { lastSyncAt: Timestamp.now() } : {}),
    fda: fda.length,
    usda: usda.length,
  }, { merge: true });
  await batch.commit();
  logger.info(`syncRecalls: fda=${fda.length} usda=${usda.length} written=${fresh.length}`);
  return fresh.length;
}

export const syncRecalls = onSchedule(
  { schedule: "every 6 hours", region: REGION, timeoutSeconds: 120 },
  async () => {
    await syncRecallsNow();
  },
);

async function readRecalls(): Promise<Array<Recall & { classification?: string }>> {
  const since = Timestamp.fromMillis(Date.now() - KEEP_DAYS * DAY_MS);
  const snap = await getFirestore().collection(RECALLS)
    .where("publishedAtTs", ">=", since)
    .orderBy("publishedAtTs", "desc")
    .limit(MAX_RESULTS)
    .get();
  return snap.docs.map((d) => d.data() as Recall);
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
  { region: REGION, timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    // Recalls are public; matching needs the shopper's synced receipts, so signed-in only.
    const uid = request.auth?.uid;
    let signedIn = false;
    if (uid && request.auth?.token.firebase?.sign_in_provider !== "anonymous") {
      const user = await getAuth().getUser(uid).catch(() => null);
      signedIn = !!user && (!!user.email || user.providerData.length > 0);
    }

    // Sync inline when there is nothing stored yet, the data is stale (stalled schedule), or the
    // user pulled to refresh. Attempts are spaced out so a blocked source isn't hammered.
    const refresh = request.data?.refresh === true;
    const meta = await getFirestore().doc(META_DOC).get();
    const last = (meta.get("lastSyncAt") as Timestamp | undefined)?.toMillis() ?? 0;
    const attempted = (meta.get("lastAttemptAt") as Timestamp | undefined)?.toMillis() ?? 0;
    let recalls = await readRecalls();
    const stale = recalls.length === 0 || Date.now() - last > SYNC_EVERY_MS * 2 || refresh;
    const gap = refresh ? REFRESH_GAP_MS : RETRY_GAP_MS;
    if (stale && Date.now() - attempted > gap) {
      logger.info(`getRecalls: syncing inline (stored=${recalls.length}, refresh=${refresh})`);
      await syncRecallsNow().catch((e) => logger.error("getRecalls: inline sync failed", e));
      recalls = await readRecalls();
    }
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
      match: items.length > 0 ? matchRecall(r.matchText ?? r.title, items) : null,
    }));
    return { signedIn, recalls: out, matchedCount: out.filter((r) => r.match).length };
  },
);
