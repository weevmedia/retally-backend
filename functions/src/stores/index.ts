/**
 * Store discovery: every receipt's store is matched to the `store_icons` master table. When no
 * store (by key, or by any alias) matches, a placeholder store is created with `status: "new"`
 * and no logo, so it shows at the top of the console's Stores page for an admin to review —
 * add a logo and save, map it onto an existing store, or delete it.
 *
 * Placeholders have an empty `iconUrl`, so `getStoreIcons` doesn't send them to the app (it keeps
 * showing its letter tile) until an admin uploads a logo.
 *
 * Each match also keeps `stats.receiptCount` / `stats.lastSeenAt` on the store, so the console can
 * show how often a store appears.
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { FieldValue, Firestore, Timestamp, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { displayNameOf, isPlausibleStoreName, storeKeyOf } from "../shared/storeKey";

export const STORES = "store_icons";
const CACHE_MS = 5 * 60 * 1000;

let cache: { at: number; byKey: Map<string, string> } | null = null;

/** Every key that should resolve to a store: its own key plus the key of each alias. */
export async function loadStoreKeyIndex(db: Firestore, force = false): Promise<Map<string, string>> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.byKey;
  const snap = await db.collection(STORES).select("aliases", "name").get();
  const byKey = new Map<string, string>();
  for (const doc of snap.docs) {
    byKey.set(doc.id, doc.id);
    const name = doc.get("name");
    if (typeof name === "string") {
      const k = storeKeyOf(name);
      if (!byKey.has(k)) byKey.set(k, doc.id);
    }
    const aliases = doc.get("aliases");
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        if (typeof a !== "string") continue;
        const k = storeKeyOf(a);
        if (!byKey.has(k)) byKey.set(k, doc.id);
      }
    }
  }
  cache = { at: Date.now(), byKey };
  return byKey;
}

export function forgetStoreKeyIndex(): void {
  cache = null;
}

export function newStoreDoc(storeName: string, receiptCount: number, seenAt: Timestamp | FieldValue) {
  return {
    name: displayNameOf(storeName) || storeName.trim().slice(0, 64),
    iconUrl: "",
    aliases: [storeName.trim().slice(0, 80)],
    category: null,
    status: "new",
    source: "receipt",
    stats: { receiptCount, firstSeenAt: seenAt, lastSeenAt: seenAt },
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: "auto (from a receipt)",
  };
}

/**
 * Records that a receipt mentioned [storeName]: bumps the matching store's stats, or creates a
 * `new` placeholder. Returns the store key used, or null when the name was skipped.
 */
export async function recordStoreSighting(storeName: string, delta: 1 | -1): Promise<string | null> {
  if (!isPlausibleStoreName(storeName)) return null;
  const db = getFirestore();
  const key = storeKeyOf(storeName);
  let index = await loadStoreKeyIndex(db);
  let target = index.get(key);
  if (!target) {
    index = await loadStoreKeyIndex(db, true); // an admin may have just added it
    target = index.get(key);
  }

  if (target) {
    await db.collection(STORES).doc(target).set(
      { stats: { receiptCount: FieldValue.increment(delta), ...(delta > 0 ? { lastSeenAt: FieldValue.serverTimestamp() } : {}) } },
      { merge: true },
    );
    return target;
  }
  if (delta < 0) return null;

  // Create-if-missing in a transaction so two receipts from the same new store make one record.
  const ref = db.collection(STORES).doc(key);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      tx.set(ref, { stats: { receiptCount: FieldValue.increment(1), lastSeenAt: FieldValue.serverTimestamp() } }, { merge: true });
    } else {
      tx.set(ref, newStoreDoc(storeName, 1, FieldValue.serverTimestamp()));
    }
  });
  cache?.byKey.set(key, key);
  logger.info(`store discovery: new store "${key}" from "${storeName}"`);
  return key;
}

/** A receipt was created, or its store name changed: register the store. */
export const onReceiptWrittenForStores = onDocumentWritten(
  { document: "users/{uid}/receipts/{receiptId}", region: REGION },
  async (event) => {
    const before = event.data?.before.exists ? (event.data.before.get("storeName") as unknown) : null;
    const after = event.data?.after.exists ? (event.data.after.get("storeName") as unknown) : null;
    const beforeKey = typeof before === "string" ? storeKeyOf(before) : null;
    const afterKey = typeof after === "string" ? storeKeyOf(after) : null;
    if (beforeKey === afterKey) return; // unrelated edit (or both missing)
    try {
      if (typeof after === "string") await recordStoreSighting(after, 1);
      if (typeof before === "string") await recordStoreSighting(before, -1);
    } catch (e) {
      logger.error("store discovery failed", e); // never block the receipt write path
    }
  },
);
