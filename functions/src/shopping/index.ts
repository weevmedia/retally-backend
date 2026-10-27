/**
 * AI shopping list (signed-in users only).
 *
 *   onReceiptWrittenForShoppingList  Firestore trigger: a synced receipt marks the user's list stale
 *   processShoppingLists             every 15 min: rebuild stale lists (debounced) + the 7am local refresh
 *   getShoppingList                  callable: rebuild now, for one store or the user's top stores
 *
 * Flow per user: receipts (last 180 days) -> string/partial-match grouping (itemGrouping) -> AI naming
 * of unresolved lines (naming, cached) -> per-item and per-store stats (features) -> Gemini decision
 * per store (decide) -> /users/{uid}/insights/shopping_list_{store}.
 *
 * Job state lives in /shoppingListJobs/{uid} (function-only; closed to clients by the default rule).
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { groupItems } from "./itemGrouping";
import { loadAliases, nameUnresolved } from "./naming";
import { PurchaseLine, StoreProfile, buildItemStats, buildStoreProfiles } from "./features";
import { PROMPT_VERSION, decideShoppingList } from "./decide";
import { DuplicateFact, NudgeDto, ReceiptFact, computeNudges } from "../nudges/compute";
import { priceDropNudges } from "../priceDrops";

const JOBS = "shoppingListJobs";
const HISTORY_DAYS = 180;
const ACTIVE_STORE_DAYS = 90;
const TOP_STORES = 3;
const DEBOUNCE_MS = 3 * 60_000;
const MORNING_HOUR = 7;
const LIST_TTL_MS = 2 * 86_400_000;
const DEFAULT_TZ = "America/New_York";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Same rule as the app's FirestoreReceiptMapper.normalizeMerchant. */
export const normalizeMerchant = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const insightId = (storeKey: string): string =>
  `shopping_list_${storeKey.replace(/\s+/g, "-").slice(0, 80) || "store"}`;

// ---------- time zone helpers ----------

function localDate(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function tzOffsetMs(date: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - date.getTime();
}

/** Next MORNING_HOUR:00 in [tz], strictly after [now]. */
function nextMorning(now: Date, tz: string): Date {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const [y, m, d] = localDate(new Date(now.getTime() + addDays * 86_400_000), tz).split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d, MORNING_HOUR);
    const at = new Date(guess - tzOffsetMs(new Date(guess), tz));
    if (at.getTime() > now.getTime()) return at;
  }
  return new Date(now.getTime() + 86_400_000);
}

// ---------- core ----------

export interface ShoppingListResult {
  status: "ok" | "guest" | "no-history";
  lists: Array<{ insightId: string; storeKey: string; storeName: string; dueCount: number; alsoCount: number }>;
}

/** Rebuilds the user's shopping lists. [storeKeys] limits it to those stores; default = top active stores. */
export async function rebuildShoppingLists(uid: string, storeKeys?: string[]): Promise<ShoppingListResult> {
  const db = getFirestore();
  const now = new Date();

  // Signed-in users only. Email-OTP users sign in with a custom token, so they have no
  // providerData — but their Firebase user carries the email. Guests have neither.
  const authUser = await getAuth().getUser(uid).catch(() => null);
  const isGuest = !authUser || (!authUser.email && authUser.providerData.length === 0);
  if (isGuest) {
    logger.info(`rebuildShoppingLists: uid=${uid} treated as guest (email=${!!authUser?.email}, providers=${authUser?.providerData.length ?? 0})`);
    await db.collection(JOBS).doc(uid).set({ stale: false, skippedReason: "guest", updatedAt: now }, { merge: true });
    return { status: "guest", lists: [] };
  }

  const userSnap = await db.doc(`users/${uid}`).get();
  // Personalization consent will move to the purchase tier; not enforced for now.
  // if (userSnap.get("settings.aiPersonalization") !== true) return { status: "guest", lists: [] };
  const tz: string = userSnap.get("timeZone") || DEFAULT_TZ;
  const todayLocal = localDate(now, tz);
  const weekdayName = WEEKDAYS[new Date(`${todayLocal}T00:00:00Z`).getUTCDay()];
  const cutoff = Timestamp.fromMillis(now.getTime() - HISTORY_DAYS * 86_400_000);

  const [receiptsSnap, linesSnap] = await Promise.all([
    db.collection(`users/${uid}/receipts`)
      .where("deletedAt", "==", null).where("purchaseDate", ">=", cutoff).orderBy("purchaseDate", "desc").get(),
    db.collectionGroup("lineItems")
      .where("uid", "==", uid).where("purchaseDate", ">=", cutoff).orderBy("purchaseDate", "desc").get(),
  ]);

  const receipts = new Map<string, { storeKey: string; storeName: string; localDate: string; total: number }>();
  for (const doc of receiptsSnap.docs) {
    const storeName = String(doc.get("storeName") ?? "").trim();
    const storeKey = String(doc.get("merchantNameNormalized") ?? "") || normalizeMerchant(storeName);
    if (!storeKey) continue;
    const date = (doc.get("purchaseDate") as Timestamp).toDate();
    receipts.set(doc.id, {
      storeKey, storeName,
      localDate: String(doc.get("purchaseDateLocal") ?? "") || localDate(date, tz),
      total: Number(doc.get("total") ?? 0) || 0,
    });
  }

  const raw: Array<{ raw: string; receiptId: string; unitPrice: number; category: string }> = [];
  // Lines flagged as charged twice: the double-charge nudge (they're left out of the stats).
  const duplicates: DuplicateFact[] = [];
  for (const doc of linesSnap.docs) {
    const receiptId = String(doc.get("receiptId") ?? "");
    const receipt = receipts.get(receiptId);
    if (receipt && doc.get("isDuplicate") === true) {
      duplicates.push({
        receiptId, storeName: receipt.storeName, localDate: receipt.localDate,
        item: String(doc.get("rawDescription") ?? "").trim() || "An item",
        price: Number(doc.get("unitPrice") ?? doc.get("lineTotal") ?? 0) || 0,
      });
    }
    if (!receipts.has(receiptId) || doc.get("isDuplicate") === true) continue;
    const description = String(doc.get("rawDescription") ?? "").trim();
    if (!description) continue;
    raw.push({ raw: description, receiptId, unitPrice: Number(doc.get("unitPrice") ?? 0), category: String(doc.get("category") ?? "other") });
  }
  if (raw.length === 0) {
    // Nothing to predict from (e.g. every receipt was deleted): drop lists built earlier, or
    // getShoppingList would keep serving them until they expire.
    await deleteShoppingLists(uid, new Set());
    await db.doc(nudgesPath(uid)).delete();
    await db.collection(JOBS).doc(uid).set({ stale: false, lastRunAt: now, nextMorningRunAt: nextMorning(now, tz) }, { merge: true });
    return { status: "no-history", lists: [] };
  }

  // 1) string + partial match, 2) cached AI names, 3) AI naming for what is still unresolved.
  const rawNames = raw.map((r) => r.raw);
  const aliases = await loadAliases(rawNames);
  let grouping = groupItems(rawNames, aliases);
  const toName = grouping.unresolved.filter((r) => !aliases.has(r.toLowerCase()));
  if (toName.length > 0) {
    const named = await nameUnresolved(toName);
    if (named.size > 0) {
      for (const [k, v] of named) aliases.set(k, v);
      grouping = groupItems(rawNames, aliases);
    }
  }
  const nonProduct = (r: string): boolean => aliases.get(r.toLowerCase()) === "";

  const lines: PurchaseLine[] = [];
  for (const r of raw) {
    if (nonProduct(r.raw)) continue;
    const receipt = receipts.get(r.receiptId)!;
    lines.push({
      itemKey: grouping.keyByRaw.get(r.raw) ?? r.raw.toLowerCase(),
      storeKey: receipt.storeKey, localDate: receipt.localDate, unitPrice: r.unitPrice, category: r.category,
    });
  }
  const items = buildItemStats(lines, todayLocal);
  const stores = buildStoreProfiles(lines, [...receipts.values()]);

  // Home nudges from the same history (all stores, whatever [storeKeys] the lists are for).
  try {
    const receiptFacts: ReceiptFact[] = [...receipts.entries()].map(([id, r]) => ({ id, ...r }));
    const nudges = computeNudges({
      items, lines, stores, displayName: grouping.displayName, todayLocal,
      receipts: receiptFacts, duplicates,
    });
    await writeNudges(uid, nudges, now);
  } catch (e) {
    logger.error(`nudges failed for uid=${uid}`, e); // never block the shopping list
  }

  const activeSince = localDate(new Date(now.getTime() - ACTIVE_STORE_DAYS * 86_400_000), tz);
  const targets: StoreProfile[] = storeKeys && storeKeys.length > 0
    ? storeKeys.map((k) => stores.get(k)).filter((s): s is StoreProfile => !!s)
    : [...stores.values()].filter((s) => s.lastTripDate >= activeSince)
      .sort((a, b) => b.tripCount - a.tripCount).slice(0, TOP_STORES);

  const result: ShoppingListResult = { status: "ok", lists: [] };
  for (const store of targets) {
    const decision = await decideShoppingList(items, grouping.displayName, store, stores, todayLocal, weekdayName);
    const id = insightId(store.key);
    await db.doc(`users/${uid}/insights/${id}`).set({
      type: "shopping_list",
      title: `Shopping list for ${store.name}`,
      body: `${decision.dueHere.length} due here · ${decision.alsoHere.length} you usually get elsewhere`,
      payload: {
        storeKey: store.key,
        storeName: store.name,
        dueHere: decision.dueHere,
        alsoHere: decision.alsoHere,
        frequent: decision.frequent,
        usualShoppingDay: decision.usualShoppingDay,
        decidedBy: decision.decidedBy,
      },
      model: decision.model ?? "fallback",
      promptVersion: PROMPT_VERSION,
      inputWindow: { from: cutoff, to: Timestamp.fromDate(now) },
      status: "new",
      feedback: null,
      generatedAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromMillis(now.getTime() + LIST_TTL_MS),
      updatedAt: FieldValue.serverTimestamp(),
    });
    result.lists.push({
      insightId: id, storeKey: store.key, storeName: store.name,
      dueCount: decision.dueHere.length, alsoCount: decision.alsoHere.length,
    });
  }

  // Drop lists for stores that no longer qualify: on a full rebuild, every store not rebuilt
  // (no recent receipts there anymore); on a per-store rebuild, the asked-for stores that had
  // nothing to build from.
  const rebuilt = new Set(result.lists.map((l) => l.insightId));
  if (storeKeys && storeKeys.length > 0) {
    const gone = storeKeys.map(insightId).filter((id) => !rebuilt.has(id));
    await Promise.all(gone.map((id) => db.doc(`users/${uid}/insights/${id}`).delete()));
  } else {
    await deleteShoppingLists(uid, rebuilt);
  }

  await db.collection(JOBS).doc(uid).set({
    stale: false, lastRunAt: now, nextMorningRunAt: nextMorning(now, tz), timeZone: tz, skippedReason: null,
  }, { merge: true });
  return result;
}

// ---------- nudges ----------

/** One doc per user holding the current Home nudges. */
const nudgesPath = (uid: string): string => `users/${uid}/insights/nudges`;
const NUDGE_TTL_MS = 2 * 86_400_000;

async function writeNudges(uid: string, nudges: NudgeDto[], now: Date): Promise<void> {
  await getFirestore().doc(nudgesPath(uid)).set({
    type: "nudges",
    items: nudges,
    generatedAt: Timestamp.fromDate(now),
    expiresAt: Timestamp.fromMillis(now.getTime() + NUDGE_TTL_MS),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Callable: `getNudges({ refresh? })` -> `{ status, nudges: NudgeDto[], generatedAt }`.
 * Serves the saved nudges; rebuilds (lists + nudges, same pass) when there are none, they're
 * over a day old, or [refresh]. Signed-in users only, like the Smart List.
 */
export const getNudges = onCall(
  { region: REGION, secrets: ["GEMINI_API_KEY"], timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "sign-in-required");
    if (request.auth.token.firebase?.sign_in_provider === "anonymous") {
      throw new HttpsError("permission-denied", "sign-in-required");
    }
    const uid = request.auth.uid;
    const ref = getFirestore().doc(nudgesPath(uid));
    let snap = await ref.get();
    const generated = (snap.get("generatedAt") as Timestamp | undefined)?.toMillis() ?? 0;
    let status: ShoppingListResult["status"] = "ok";
    if (request.data?.refresh === true || !snap.exists || Date.now() - generated > STALE_FOR_APP_MS) {
      status = (await rebuildShoppingLists(uid)).status;
      snap = await ref.get();
    }
    const history = status === "no-history" || !snap.exists ? [] : ((snap.get("items") ?? []) as NudgeDto[]);
    // Price drops come from the daily cross-shopper scan, not this user's rebuild.
    const drops = await priceDropNudges(uid).catch((e) => {
      logger.error(`price-drop nudges failed for uid=${uid}`, e);
      return [] as NudgeDto[];
    });
    const nudges = [...drops, ...history].sort((a, b) => b.priority - a.priority);
    const at = (snap.get("generatedAt") as Timestamp | undefined)?.toDate().toISOString() ?? null;
    return { status, nudges, generatedAt: at };
  },
);

/** Deletes the user's shopping-list insights except [keep] (insight ids). */
async function deleteShoppingLists(uid: string, keep: Set<string>): Promise<void> {
  const db = getFirestore();
  const snap = await db.collection(`users/${uid}/insights`).where("type", "==", "shopping_list").get();
  const stale = snap.docs.filter((d) => !keep.has(d.id));
  if (stale.length === 0) return;
  const batch = db.batch();
  for (const d of stale) batch.delete(d.ref);
  await batch.commit();
  logger.info(`deleteShoppingLists: uid=${uid} removed ${stale.length} list(s)`);
}

// ---------- triggers ----------

/** A synced receipt (create/update/soft-delete) makes the list stale; the scheduler debounces. */
export const onReceiptWrittenForShoppingList = onDocumentWritten(
  { document: "users/{uid}/receipts/{receiptId}", region: REGION },
  async (event) => {
    await getFirestore().collection(JOBS).doc(event.params.uid).set(
      { stale: true, staleSince: FieldValue.serverTimestamp() }, { merge: true },
    );
  },
);

/** Every 15 min: stale lists older than the debounce window, plus each user's 7am local refresh. */
export const processShoppingLists = onSchedule(
  { schedule: "every 15 minutes", region: REGION, secrets: ["GEMINI_API_KEY"], timeoutSeconds: 540, memory: "512MiB" },
  async () => {
    const db = getFirestore();
    const now = Date.now();
    const [stale, morning] = await Promise.all([
      db.collection(JOBS).where("stale", "==", true).limit(25).get(),
      db.collection(JOBS).where("nextMorningRunAt", "<=", new Date(now)).limit(25).get(),
    ]);
    const due = new Set<string>();
    for (const doc of stale.docs) {
      const since = (doc.get("staleSince") as Timestamp | undefined)?.toMillis() ?? 0;
      if (now - since >= DEBOUNCE_MS) due.add(doc.id);
    }
    for (const doc of morning.docs) due.add(doc.id);
    for (const uid of due) {
      try {
        await rebuildShoppingLists(uid);
      } catch (e) {
        console.error(`processShoppingLists: rebuild failed for ${uid}`, e);
      }
    }
  },
);

/** Shape returned to the app for one store (mirrors the insight doc's payload). */
export interface ShoppingListDto {
  insightId: string;
  storeKey: string;
  storeName: string;
  dueHere: unknown[];
  alsoHere: unknown[];
  frequent: unknown[];
  usualShoppingDay: string | null;
  decidedBy: string;
  generatedAt: string;
}

/** Reads the user's current (unexpired) shopping-list insights. */
export async function readShoppingLists(uid: string): Promise<ShoppingListDto[]> {
  const snap = await getFirestore().collection(`users/${uid}/insights`).where("type", "==", "shopping_list").get();
  const now = Date.now();
  return snap.docs
    .filter((d) => ((d.get("expiresAt") as Timestamp | undefined)?.toMillis() ?? 0) > now)
    .map((d) => {
      const p = (d.get("payload") ?? {}) as Record<string, unknown>;
      return {
        insightId: d.id,
        storeKey: String(p.storeKey ?? ""),
        storeName: String(p.storeName ?? ""),
        dueHere: Array.isArray(p.dueHere) ? p.dueHere : [],
        alsoHere: Array.isArray(p.alsoHere) ? p.alsoHere : [],
        frequent: Array.isArray(p.frequent) ? p.frequent : [],
        usualShoppingDay: typeof p.usualShoppingDay === "string" ? p.usualShoppingDay : null,
        decidedBy: String(p.decidedBy ?? "gemini"),
        generatedAt: ((d.get("generatedAt") as Timestamp | undefined)?.toDate() ?? new Date(0)).toISOString(),
      };
    })
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

const STALE_FOR_APP_MS = 24 * 3_600_000;

/**
 * Callable: `getShoppingList({ storeName?, refresh? })` -> `{ status, lists: ShoppingListDto[] }`.
 *
 * - refresh = false (default): returns the saved lists; rebuilds first only when there are none,
 *   they are older than a day, or [storeName] has no list yet.
 * - refresh = true: rebuilds now (for [storeName] if given, else the user's top stores).
 *
 * Guests (anonymous auth) get `permission-denied` with reason "sign-in-required".
 */
export const getShoppingList = onCall(
  { region: REGION, secrets: ["GEMINI_API_KEY"], timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      logger.warn("getShoppingList: no auth on request");
      throw new HttpsError("unauthenticated", "sign-in-required");
    }
    if (request.auth.token.firebase?.sign_in_provider === "anonymous") {
      logger.info(`getShoppingList: anonymous uid=${request.auth.uid}`);
      throw new HttpsError("permission-denied", "sign-in-required");
    }
    const uid = request.auth.uid;
    const storeName = typeof request.data?.storeName === "string" ? request.data.storeName : "";
    const storeKey = storeName ? normalizeMerchant(storeName) : "";
    const forceRefresh = request.data?.refresh === true;

    let lists = forceRefresh ? [] : await readShoppingLists(uid);
    const newest = lists[0] ? Date.parse(lists[0].generatedAt) : 0;
    const missingStore = storeKey !== "" && !lists.some((l) => l.storeKey === storeKey);
    let status: ShoppingListResult["status"] = "ok";
    if (forceRefresh || lists.length === 0 || Date.now() - newest > STALE_FOR_APP_MS || missingStore) {
      const result = await rebuildShoppingLists(uid, storeKey ? [storeKey] : undefined);
      status = result.status;
      // "no-history" means there is nothing to predict from: never serve leftover lists with it.
      lists = status === "no-history" ? [] : await readShoppingLists(uid);
    }
    return { status, lists };
  },
);
