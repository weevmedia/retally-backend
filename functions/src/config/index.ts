/**
 * Server-driven config endpoints — the app reads these at launch so lists can
 * evolve without an app release.
 *
 *   GET /getCategories -> 200 { ok: true, categories: [{ id, name, keywords[] }] }
 *   GET /getStoreIcons -> 200 { ok: true, icons: [{ key, name, iconUrl }] }
 *   GET /getStoreIcons?store=<printed name>
 *                      -> 200 { ok: true, lookup: true, icons: [], match: { key, name, iconUrl } | null }
 *   GET /getStoreIcons?stores=<name>&stores=<name>…   (batch, up to 50)
 *                      -> 200 { ok: true, lookup: true, icons: [], matches: { "<name>": {…} | null } }
 */

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { STORES, loadStoreKeyIndex } from "../stores";
import { AI_CATEGORIES } from "../categories";
import { storeKeyOf } from "../shared/storeKey";

// MARK: Categories

/**
 * Item categories, pushed from the server so the list (and the tagging keywords)
 * can evolve without an app release.
 *
 * Source of truth is the Firestore doc `config/itemCategories`:
 *   { categories: [{ id: "grocery", name: "Grocery", keywords: [] },
 *                   { id: "misc", name: "Miscellaneous",
 *                     keywords: ["paper towel", "detergent", ...] }] }
 * Edit it in the Firebase console — no redeploy needed. The FIRST category in
 * the list is the default: items matching no keyword land there. If the doc is
 * missing or empty, the bundled default below is returned so the app always
 * has something to work with (and works fully offline).
 */
interface ItemCategoryDto {
  id: string;
  name: string;
  keywords: string[];
}

const DEFAULT_CATEGORIES: ItemCategoryDto[] = AI_CATEGORIES.map((c) => ({ ...c, keywords: [] }));

/** The admin list plus any AI category it lacks, so every id the AI returns has a name. */
function withAiCategories(list: ItemCategoryDto[]): ItemCategoryDto[] {
  const have = new Set(list.map((c) => c.id));
  return [...list, ...AI_CATEGORIES.filter((c) => !have.has(c.id)).map((c) => ({ ...c, keywords: [] }))];
}

function sanitizeCategories(input: unknown): ItemCategoryDto[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const clean = (input as unknown[])
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === "object" && c !== null && typeof (c as Record<string, unknown>).id === "string" && typeof (c as Record<string, unknown>).name === "string"
    )
    .map((c) => ({
      id: String(c.id).trim().slice(0, 64),
      name: String(c.name).trim().slice(0, 64),
      keywords: Array.isArray(c.keywords)
        ? (c.keywords as unknown[]).filter((k): k is string => typeof k === "string").map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0).slice(0, 200)
        : [],
    }))
    .filter((c) => c.id.length > 0 && c.name.length > 0);
  return clean.length > 0 ? clean : null;
}

export const getCategories = onRequest({ region: REGION }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  try {
    const snap = await getFirestore().doc("config/itemCategories").get();
    const fromDoc = sanitizeCategories(snap.data()?.categories);
    res.status(200).json({ ok: true, categories: fromDoc ? withAiCategories(fromDoc) : DEFAULT_CATEGORIES });
  } catch (e) {
    console.error("getCategories failed", e);
    res.status(200).json({ ok: true, categories: DEFAULT_CATEGORIES });
  }
});

// MARK: Store icons

/**
 * Store logos, pushed from the server so new stores never need an app release.
 *
 * Backed by the Firestore collection `store_icons`: the document id is the
 * normalized store key (see the app's `iconKeyOf` — e.g. `walmart`, `costco`,
 * `traderjoes`, `7eleven`), each doc holding `{ name, iconUrl, weeklyAdUrl? }`.
 *
 * Setup (Firebase console, no code):
 *   1. Storage: upload each logo as `store-icons/<key>.png` (transparent PNG,
 *      ~256px), then copy its download URL.
 *   2. Firestore: create collection `store_icons`, add a doc per store with id
 *      `<key>` and fields `name` (display name) + `iconUrl` (the download URL).
 *
 * The app matches OCR store names to keys on-device and falls back to its
 * monogram tile when a store has no icon yet.
 */
interface StoreIconDto {
  key: string;
  name: string;
  /** "" when the store has no logo yet. */
  iconUrl: string;
  /** The store's weekly-ad page (admin console); omitted when none. */
  weeklyAdUrl?: string;
}

function strField(doc: FirebaseFirestore.DocumentSnapshot | null | undefined, field: string): string {
  const v = doc?.exists ? doc.get(field) : undefined;
  return typeof v === "string" ? v.trim() : "";
}

/** A store's answer for the app, or null when it has neither a logo nor a weekly ad. */
function storeAnswer(
  doc: FirebaseFirestore.DocumentSnapshot | null | undefined, key: string, fallbackName: string,
): StoreIconDto | null {
  if (!doc?.exists) return null;
  const iconUrl = strField(doc, "iconUrl");
  const weeklyAdUrl = strField(doc, "weeklyAdUrl");
  if (!iconUrl && !weeklyAdUrl) return null;
  return { key, name: strField(doc, "name") || fallbackName, iconUrl, ...(weeklyAdUrl ? { weeklyAdUrl } : {}) };
}

export const getStoreIcons = onRequest({ region: REGION }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  // Batch lookup: the app re-checks its "no logo" stores in one request (launch / Receipts).
  const raw = req.query.stores;
  const names = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim().slice(0, 128))
    .filter((n) => n.length > 0)
    .slice(0, 50);
  if (names.length > 0) {
    try {
      const db = getFirestore();
      const index = await loadStoreKeyIndex(db);
      const ids = [...new Set(names.map((n) => index.get(storeKeyOf(n))).filter((id): id is string => !!id))];
      const docs = ids.length ? await db.getAll(...ids.map((id) => db.collection(STORES).doc(id))) : [];
      const byId = new Map(docs.filter((d) => d.exists).map((d) => [d.id, d]));
      const matches: Record<string, StoreIconDto | null> = {};
      for (const n of names) {
        const doc = byId.get(index.get(storeKeyOf(n)) ?? "");
        matches[n] = storeAnswer(doc, storeKeyOf(n), doc?.id ?? n);
      }
      res.status(200).json({ ok: true, lookup: true, icons: [], matches });
    } catch (e) {
      console.error("getStoreIcons batch lookup failed", e);
      res.status(503).json({ ok: false, error: "lookup-failed" });
    }
    return;
  }

  // One-store lookup (what the app sends): resolve the printed name through the store-key
  // index, which also maps each store's display name and aliases ("PATEL BROS" → patelbrothers).
  const store = typeof req.query.store === "string" ? req.query.store.trim().slice(0, 128) : "";
  if (store) {
    try {
      const db = getFirestore();
      const docId = (await loadStoreKeyIndex(db)).get(storeKeyOf(store));
      const doc = docId ? await db.collection(STORES).doc(docId).get() : null;
      res.status(200).json({
        ok: true,
        lookup: true,
        icons: [],
        match: storeAnswer(doc, storeKeyOf(store), docId ?? store),
      });
    } catch (e) {
      // Not "no logo": a failed lookup must not be cached by the app as a miss.
      console.error("getStoreIcons lookup failed", e);
      res.status(503).json({ ok: false, error: "lookup-failed" });
    }
    return;
  }
  try {
    const snap = await getFirestore().collection("store_icons").get();
    const icons: StoreIconDto[] = snap.docs
      .map((doc) => {
        const data = doc.data() as { name?: unknown; iconUrl?: unknown; weeklyAdUrl?: unknown };
        const weeklyAdUrl = typeof data.weeklyAdUrl === "string" ? data.weeklyAdUrl.trim() : "";
        return {
          key: doc.id.trim().toLowerCase().slice(0, 64),
          name: typeof data.name === "string" ? data.name.trim().slice(0, 64) : doc.id,
          iconUrl: typeof data.iconUrl === "string" ? data.iconUrl.trim() : "",
          ...(weeklyAdUrl ? { weeklyAdUrl } : {}),
        };
      })
      .filter((icon) => icon.key.length > 0 && icon.iconUrl.length > 0);
    res.status(200).json({ ok: true, icons });
  } catch (e) {
    console.error("getStoreIcons failed", e);
    res.status(200).json({ ok: true, icons: [] });
  }
});
