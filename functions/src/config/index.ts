/**
 * Server-driven config endpoints — the app reads these at launch so lists can
 * evolve without an app release.
 *
 *   GET /getCategories -> 200 { ok: true, categories: [{ id, name, keywords[] }] }
 *   GET /getStoreIcons -> 200 { ok: true, icons: [{ key, name, iconUrl }] }
 */

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";

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

const DEFAULT_CATEGORIES: ItemCategoryDto[] = [
  { id: "grocery", name: "Grocery", keywords: [] },
  { id: "misc", name: "Miscellaneous", keywords: [] },
];

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
    res.status(200).json({ ok: true, categories: fromDoc ?? DEFAULT_CATEGORIES });
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
 * `traderjoes`, `7eleven`), each doc holding `{ name, iconUrl }`.
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
  iconUrl: string;
}

export const getStoreIcons = onRequest({ region: REGION }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  try {
    const snap = await getFirestore().collection("store_icons").get();
    const icons: StoreIconDto[] = snap.docs
      .map((doc) => {
        const data = doc.data() as { name?: unknown; iconUrl?: unknown };
        return {
          key: doc.id.trim().toLowerCase().slice(0, 64),
          name: typeof data.name === "string" ? data.name.trim().slice(0, 64) : doc.id,
          iconUrl: typeof data.iconUrl === "string" ? data.iconUrl.trim() : "",
        };
      })
      .filter((icon) => icon.key.length > 0 && icon.iconUrl.length > 0);
    res.status(200).json({ ok: true, icons });
  } catch (e) {
    console.error("getStoreIcons failed", e);
    res.status(200).json({ ok: true, icons: [] });
  }
});
