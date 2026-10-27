/**
 * Admin console API (retally-webapp). Every write the console makes goes through here:
 *  - the caller must hold the `admin: true` custom claim (granted by scripts/set-admin.mjs),
 *  - input is validated server-side (the browser is never trusted),
 *  - each change is recorded in `/adminAudit` with before/after snapshots.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { audit, requireAdmin, text } from "./common";
import { forgetStoreKeyIndex, loadStoreKeyIndex, newStoreDoc } from "../stores";
import { isPlausibleStoreName, storeKeyOf } from "../shared/storeKey";

export { adminGetReceipt, adminSearchReceipts } from "./receipts";
export { adminInviteAdmin, adminListUsers, adminSetAdmin, adminSetUserDisabled } from "./users";
export { adminListItemAliases, adminSetItemCategory } from "./itemAliases";

const STORES = "store_icons";
const CATEGORIES_DOC = "config/itemCategories";
const CATEGORIES = ["grocery", "warehouse", "pharmacy", "department", "convenience", "specialty", "other"];
const KEY_RE = /^[a-z0-9]{1,64}$/;

function iconUrlOf(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  const url = text(v, "iconUrl", 2048);
  // Only our own Storage bucket: the app loads these URLs directly.
  if (!url.startsWith("https://firebasestorage.googleapis.com/")) {
    throw new HttpsError("invalid-argument", "iconUrl must be a Firebase Storage download URL.");
  }
  return url;
}

/** Optional https link to the store's weekly-ad page; "" clears it. */
function weeklyAdUrlOf(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  const url = text(v, "weeklyAdUrl", 2048);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpsError("invalid-argument", "Weekly ad link must be a full URL (https://…).");
  }
  if (parsed.protocol !== "https:") throw new HttpsError("invalid-argument", "Weekly ad link must start with https://.");
  return url;
}

function aliasesOf(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpsError("invalid-argument", "aliases must be a list.");
  const byLower = new Map<string, string>();
  for (const a of v) {
    if (typeof a !== "string" || a.trim().length === 0) continue;
    const alias = a.trim().slice(0, 80);
    if (!byLower.has(alias.toLowerCase())) byLower.set(alias.toLowerCase(), alias);
  }
  return [...byLower.values()].slice(0, 50);
}

// ---------- stores (`store_icons`, served to the app by getStoreIcons) ----------

export const adminUpsertStore = onCall({ region: REGION }, async (request) => {
  const admin = await requireAdmin(request);
  const d = (request.data ?? {}) as Record<string, unknown>;

  const key = text(d.key, "key", 64);
  if (!KEY_RE.test(key)) throw new HttpsError("invalid-argument", "key must be lowercase letters and digits.");
  const category = d.category === null || d.category === undefined ? null : text(d.category, "category", 32);
  if (category !== null && !CATEGORIES.includes(category)) throw new HttpsError("invalid-argument", "Unknown category.");
  const after = {
    name: text(d.name, "name", 64),
    iconUrl: iconUrlOf(d.iconUrl),
    weeklyAdUrl: weeklyAdUrlOf(d.weeklyAdUrl),
    aliases: aliasesOf(d.aliases),
    category,
  };
  const isNew = d.isNew === true;

  const db = getFirestore();
  const ref = db.collection(STORES).doc(key);
  const before = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (isNew && snap.exists) throw new HttpsError("already-exists", `A store with key "${key}" already exists.`);
    if (!isNew && !snap.exists) throw new HttpsError("not-found", `Store "${key}" no longer exists.`);
    // Saving from the console approves a store discovered from receipts (status "new" → "active").
    tx.set(ref, { ...after, status: "active", updatedAt: FieldValue.serverTimestamp(), updatedBy: admin.email }, { merge: true });
    return snap.exists ? snap.data() ?? null : null;
  });
  await audit(admin, isNew ? "store.create" : "store.update", `${STORES}/${key}`, before, after);
  forgetStoreKeyIndex();
  return { ok: true, key };
});

/**
 * Folds one store into another: the source's name and aliases become aliases of the target, its
 * receipt count is added, and the source is deleted. Used to map an OCR variant ("WF.OLESAL")
 * onto the real store.
 */
export const adminMergeStore = onCall({ region: REGION }, async (request) => {
  const admin = await requireAdmin(request);
  const d = (request.data ?? {}) as Record<string, unknown>;
  const fromKey = text(d.fromKey, "fromKey", 64);
  const intoKey = text(d.intoKey, "intoKey", 64);
  if (fromKey === intoKey) throw new HttpsError("invalid-argument", "Pick a different store to merge into.");

  const db = getFirestore();
  const fromRef = db.collection(STORES).doc(fromKey);
  const intoRef = db.collection(STORES).doc(intoKey);
  const result = await db.runTransaction(async (tx) => {
    const [from, into] = await Promise.all([tx.get(fromRef), tx.get(intoRef)]);
    if (!from.exists) throw new HttpsError("not-found", `Store "${fromKey}" no longer exists.`);
    if (!into.exists) throw new HttpsError("not-found", `Store "${intoKey}" no longer exists.`);
    const f = from.data() ?? {};
    const t = into.data() ?? {};
    const aliases = aliasesOf([...(Array.isArray(t.aliases) ? t.aliases : []), ...(Array.isArray(f.aliases) ? f.aliases : []), f.name]
      .filter((a) => typeof a === "string" && a.toLowerCase() !== String(t.name ?? "").toLowerCase()));
    const fromStats = (f.stats ?? {}) as Record<string, unknown>;
    const count = typeof fromStats.receiptCount === "number" ? fromStats.receiptCount : 0;
    tx.set(intoRef, {
      aliases,
      stats: { receiptCount: FieldValue.increment(count) },
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: admin.email,
    }, { merge: true });
    tx.delete(fromRef);
    return { before: { from: f, into: t }, aliases };
  });
  await audit(admin, "store.merge", `${STORES}/${fromKey} → ${STORES}/${intoKey}`, result.before, { aliases: result.aliases });
  forgetStoreKeyIndex();
  return { ok: true };
});

const DISCOVER_SCAN_LIMIT = 20000;

/**
 * Backfill: reads every receipt's store name, creates `new` placeholders for stores that aren't in
 * the table yet, and recounts `stats.receiptCount` on every matched store.
 */
export const adminDiscoverStores = onCall({ region: REGION, memory: "512MiB", timeoutSeconds: 300 }, async (request) => {
  const admin = await requireAdmin(request);
  const db = getFirestore();
  const receipts = await db.collectionGroup("receipts").select("storeName", "purchaseDate", "deletedAt").limit(DISCOVER_SCAN_LIMIT).get();
  const index = await loadStoreKeyIndex(db, true);

  // store key → { count, last seen, most common raw name }
  const seen = new Map<string, { count: number; last: Timestamp | null; names: Map<string, number>; existing: boolean }>();
  let skipped = 0;
  for (const doc of receipts.docs) {
    const name = doc.get("storeName");
    const deletedAt = doc.get("deletedAt");
    if (deletedAt !== undefined && deletedAt !== null) continue;
    if (typeof name !== "string" || !isPlausibleStoreName(name)) { skipped++; continue; }
    const key = storeKeyOf(name);
    const target = index.get(key) ?? key;
    const entry = seen.get(target) ?? { count: 0, last: null, names: new Map(), existing: index.has(key) };
    entry.count++;
    entry.names.set(name.trim(), (entry.names.get(name.trim()) ?? 0) + 1);
    const at = doc.get("purchaseDate");
    if (at instanceof Timestamp && (!entry.last || at.toMillis() > entry.last.toMillis())) entry.last = at;
    seen.set(target, entry);
  }

  const writer = db.bulkWriter();
  let created = 0;
  let updated = 0;
  for (const [key, e] of seen) {
    const ref = db.collection(STORES).doc(key);
    const lastSeenAt = e.last ?? FieldValue.serverTimestamp();
    if (e.existing) {
      void writer.set(ref, { stats: { receiptCount: e.count, lastSeenAt } }, { merge: true });
      updated++;
    } else {
      const commonest = [...e.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const doc = newStoreDoc(commonest, e.count, lastSeenAt);
      doc.aliases = [...e.names.keys()].slice(0, 50);
      void writer.create(ref, doc).catch(() => undefined); // a trigger may have created it meanwhile
      created++;
    }
  }
  await writer.close();
  forgetStoreKeyIndex();
  await audit(admin, "store.discover", STORES, null, { scanned: receipts.size, created, updated, skipped });
  return { ok: true, scanned: receipts.size, created, updated, skipped, truncated: receipts.size >= DISCOVER_SCAN_LIMIT };
});

export const adminDeleteStore = onCall({ region: REGION }, async (request) => {
  const admin = await requireAdmin(request);
  const key = text((request.data as Record<string, unknown> | undefined)?.key, "key", 64);
  const ref = getFirestore().collection(STORES).doc(key);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Store "${key}" not found.`);
  await ref.delete();
  await audit(admin, "store.delete", `${STORES}/${key}`, snap.data(), null);
  return { ok: true };
});

// ---------- item categories (`config/itemCategories`, served to the app by getCategories) ----------

const CATEGORY_ID_RE = /^[a-z0-9_-]{1,64}$/;
const MAX_CATEGORIES = 50;
const MAX_KEYWORDS = 200; // same cap getCategories applies

interface ItemCategory {
  id: string;
  name: string;
  keywords: string[];
}

function categoriesOf(v: unknown): ItemCategory[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpsError("invalid-argument", "At least one category is required.");
  if (v.length > MAX_CATEGORIES) throw new HttpsError("invalid-argument", `At most ${MAX_CATEGORIES} categories.`);
  const ids = new Set<string>();
  const names = new Set<string>();
  return v.map((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const id = text(c.id, `categories[${i}].id`, 64);
    if (!CATEGORY_ID_RE.test(id)) throw new HttpsError("invalid-argument", `Category id "${id}" must be lowercase letters, digits, - or _.`);
    if (ids.has(id)) throw new HttpsError("invalid-argument", `Duplicate category id "${id}".`);
    ids.add(id);
    const name = text(c.name, `categories[${i}].name`, 64);
    if (names.has(name.toLowerCase())) throw new HttpsError("invalid-argument", `Duplicate category name "${name}".`);
    names.add(name.toLowerCase());
    if (c.keywords !== undefined && !Array.isArray(c.keywords)) throw new HttpsError("invalid-argument", "keywords must be a list.");
    const keywords = [
      ...new Set(
        ((c.keywords as unknown[] | undefined) ?? [])
          .filter((k): k is string => typeof k === "string")
          .map((k) => k.trim().toLowerCase().slice(0, 80))
          .filter((k) => k.length > 0),
      ),
    ];
    if (keywords.length > MAX_KEYWORDS) throw new HttpsError("invalid-argument", `"${name}" has more than ${MAX_KEYWORDS} keywords.`);
    return { id, name, keywords };
  });
}

/** Replaces the whole category list (order matters: the first one is the app's default). */
export const adminSaveCategories = onCall({ region: REGION }, async (request) => {
  const admin = await requireAdmin(request);
  const categories = categoriesOf((request.data as Record<string, unknown> | undefined)?.categories);
  const ref = getFirestore().doc(CATEGORIES_DOC);
  const before = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    tx.set(ref, { categories, updatedAt: FieldValue.serverTimestamp(), updatedBy: admin.email });
    return snap.exists ? snap.data()?.categories ?? null : null;
  });
  await audit(admin, "categories.update", CATEGORIES_DOC, before, categories);
  return { ok: true, count: categories.length };
});
