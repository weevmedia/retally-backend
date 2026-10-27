/**
 * Admin review of the AI's item categories (`itemAliases`, shared by every user): list the
 * cached answers and override a wrong one. An override wins for everyone from then on —
 * `categorizeItems` reads the cache before asking Gemini, so it's never re-asked.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { sha256 } from "../shared/crypto";
import { AI_CATEGORIES } from "../categories";
import { audit, requireAdmin, text } from "./common";

const COLLECTION = "itemAliases";
const PAGE = 50;
const IDS = new Set(AI_CATEGORIES.map((c) => c.id).filter((id) => id !== "uncategorized"));

interface AliasRow {
  raw: string;
  name: string | null;
  category: string | null;
  overridden: boolean;
  overriddenBy: string | null;
  categorizedAt: string | null;
}

function toRow(data: FirebaseFirestore.DocumentData): AliasRow {
  const at = data.categoryOverriddenAt ?? data.categorizedAt;
  return {
    raw: String(data.raw ?? ""),
    name: typeof data.name === "string" ? data.name : null,
    category: typeof data.category === "string" ? data.category : null,
    overridden: data.categoryOverride === true,
    overriddenBy: typeof data.categoryOverriddenBy === "string" ? data.categoryOverriddenBy : null,
    categorizedAt: at instanceof Timestamp ? at.toDate().toISOString() : at instanceof Date ? at.toISOString() : null,
  };
}

/**
 * `adminListItemAliases({ search?, category?, after? })` → `{ rows, next }`.
 * - search: receipt text prefix (case-insensitive), ordered by text;
 * - category: only lines the AI put in that category;
 * - neither: most recently categorised first.
 * `next` is an opaque cursor for the following page (null at the end).
 */
export const adminListItemAliases = onCall({ region: REGION }, async (request) => {
  await requireAdmin(request);
  const d = (request.data ?? {}) as Record<string, unknown>;
  const search = typeof d.search === "string" ? d.search.trim().toLowerCase().slice(0, 100) : "";
  const category = typeof d.category === "string" && IDS.has(d.category) ? d.category : "";
  const after = typeof d.after === "string" ? d.after : "";
  const col = getFirestore().collection(COLLECTION);

  let q: FirebaseFirestore.Query;
  if (search) {
    q = col.where("raw", ">=", search).where("raw", "<", search + "").orderBy("raw");
  } else if (category) {
    q = col.where("category", "==", category).orderBy("raw");
  } else {
    q = col.orderBy("categorizedAt", "desc");
  }
  if (after) {
    const cursor = await col.doc(after).get();
    if (cursor.exists) q = q.startAfter(cursor);
  }
  const snap = await q.limit(PAGE + 1).get();
  const docs = snap.docs.slice(0, PAGE);
  let rows = docs.map((doc) => toRow(doc.data()));
  // Search + category: filter the search page by category.
  if (search && category) rows = rows.filter((r) => r.category === category);
  return { rows, next: snap.docs.length > PAGE ? docs[docs.length - 1].id : null };
});

/** `adminSetItemCategory({ raw, category })`: overrides the AI's answer for one receipt text. */
export const adminSetItemCategory = onCall({ region: REGION }, async (request) => {
  const admin = await requireAdmin(request);
  const d = (request.data ?? {}) as Record<string, unknown>;
  const raw = text(d.raw, "raw", 200).toLowerCase();
  const category = text(d.category, "category", 32);
  if (!IDS.has(category)) throw new HttpsError("invalid-argument", "Unknown category.");
  const ref = getFirestore().collection(COLLECTION).doc(sha256(raw));
  const before = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    tx.set(ref, {
      raw,
      category,
      categoryOverride: true,
      categoryOverriddenBy: admin.email,
      categoryOverriddenAt: FieldValue.serverTimestamp(),
      // Keeps it in the "recent" list's ordering.
      categorizedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return snap.exists ? { category: snap.get("category") ?? null } : null;
  });
  await audit(admin, "itemAlias.category", `${COLLECTION}/${raw}`, before, { category });
  return { ok: true };
});
