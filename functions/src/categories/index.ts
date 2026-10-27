/**
 * Item categories by AI (grocery vs household, personal care, …).
 *
 * The app tags items on-device first (keywords), then calls `categorizeItems` with the receipt's
 * lines. Each distinct receipt text is classified by Gemini once and cached in /itemAliases
 * (shared with Smart List naming), so the same "TIDE PDS 42CT" is never paid for twice — for
 * any user. Items the shopper re-categorised by hand are never sent (the app keeps those).
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { sha256 } from "../shared/crypto";
import { GEMINI_LITE_MODEL, generateJson } from "../shared/gemini";

/** The AI's categories. Ids are stable (stored on line items); names are display copy. */
export const AI_CATEGORIES: ReadonlyArray<{ id: string; name: string }> = [
  { id: "grocery", name: "Grocery" },
  { id: "household", name: "Household" },
  { id: "personal_care", name: "Personal care" },
  { id: "health", name: "Health & pharmacy" },
  { id: "baby", name: "Baby" },
  { id: "pet", name: "Pet" },
  { id: "alcohol", name: "Alcohol" },
  { id: "electronics", name: "Electronics" },
  { id: "clothing", name: "Clothing" },
  { id: "home", name: "Home & garden" },
  { id: "other", name: "Other" },
  { id: "uncategorized", name: "Uncategorized" },
];
const AI_IDS = new Set(AI_CATEGORIES.map((c) => c.id).filter((id) => id !== "uncategorized"));

const COLLECTION = "itemAliases";
/** Lines per Gemini request, and per app call. */
const CHUNK = 40;
const MAX_LINES = 120;

const PROMPT = `You read US store receipt lines (often abbreviated) and, for each, give:
- "name": the generic product a shopper would write on a list — lower-case, singular, no brand,
  no size ("KS TP 30R" -> "toilet paper", "GV 2% MLK" -> "milk"), or null if it is not a product
  (tax, fees, deposits, coupons, bag charges, totals);
- "category": exactly one of grocery, household, personal_care, health, baby, pet, alcohol,
  electronics, clothing, home, other.
  grocery = food and drinks you eat or drink at home (not alcohol). household = cleaning, paper
  goods, laundry, trash bags, storage. personal_care = toiletries, cosmetics, shaving, hair care.
  health = medicine, vitamins, first aid, pharmacy. home = furniture, decor, kitchenware, tools,
  garden, hardware. Use "other" for non-products and anything else.
The store is a hint only: a grocery store also sells detergent, a pharmacy also sells snacks.

Return ONLY JSON: {"items":[{"raw":"<exact input>","name":"<name or null>","category":"<id>"}]}
`;

export interface Classified {
  category: string;
  name: string | null;
}

/** raw (lower-cased) -> category for every line, cache first, Gemini for the rest. */
export async function classifyLines(raws: string[], storeName: string): Promise<Map<string, Classified>> {
  const unique = [...new Set(raws.map((r) => r.trim().toLowerCase()))].filter((r) => r.length > 0).slice(0, MAX_LINES);
  const out = new Map<string, Classified>();
  if (unique.length === 0) return out;
  const db = getFirestore();
  const snaps = await db.getAll(...unique.map((r) => db.collection(COLLECTION).doc(sha256(r))));
  const misses: string[] = [];
  /** Lines whose cached doc already has a Smart List name — never overwritten here. */
  const named = new Set<string>();
  snaps.forEach((snap, i) => {
    if (snap.exists && snap.get("name") !== undefined) named.add(unique[i]);
    const category = snap.exists ? snap.get("category") : undefined;
    if (typeof category === "string" && AI_IDS.has(category)) {
      const name = snap.get("name");
      out.set(unique[i], { category, name: typeof name === "string" ? name : null });
    } else {
      misses.push(unique[i]);
    }
  });

  for (let i = 0; i < misses.length; i += CHUNK) {
    const chunk = misses.slice(i, i + CHUNK);
    try {
      const res = await generateJson<{ items?: Array<{ raw?: string; name?: string | null; category?: string }> }>(
        GEMINI_LITE_MODEL,
        `${PROMPT}\nStore: ${storeName.slice(0, 80) || "unknown"}\nLines:\n${chunk.map((r) => `- ${r}`).join("\n")}`,
        { temperature: 0, maxOutputTokens: 4096 },
      );
      const allowed = new Set(chunk);
      const batch = db.batch();
      for (const item of res.items ?? []) {
        const raw = (item.raw ?? "").trim().toLowerCase();
        if (!allowed.has(raw) || out.has(raw)) continue; // ignore anything the model invented
        const category = typeof item.category === "string" && AI_IDS.has(item.category) ? item.category : "other";
        const name = typeof item.name === "string" ? item.name.trim().toLowerCase().slice(0, 60) || null : null;
        // Merge, and only set the name when none is cached: the Smart List reads it, and
        // a null name there means "not a product".
        batch.set(db.collection(COLLECTION).doc(sha256(raw)), {
          raw, category, ...(named.has(raw) ? {} : { name }), categoryModel: GEMINI_LITE_MODEL, categorizedAt: new Date(),
        }, { merge: true });
        out.set(raw, { category, name });
      }
      await batch.commit();
    } catch (e) {
      logger.error("classifyLines: Gemini chunk failed", e); // the app keeps its on-device guess
    }
  }
  return out;
}

/**
 * Callable: `categorizeItems({ store, items: ["TIDE PDS 42CT", …] })`
 *   -> `{ categories: { "<item as sent>": "<category id>" } }` (items it couldn't place are left out).
 * Any signed-in Firebase user, guests included (they scan too); at most 120 lines per call.
 */
export const categorizeItems = onCall(
  { region: REGION, secrets: ["GEMINI_API_KEY"], timeoutSeconds: 60, memory: "256MiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "sign-in-required");
    const d = (request.data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(d.items)
      ? (d.items as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, MAX_LINES)
      : [];
    if (items.length === 0) return { categories: {} };
    const store = typeof d.store === "string" ? d.store : "";
    const result = await classifyLines(items, store);
    const categories: Record<string, string> = {};
    for (const raw of items) {
      const hit = result.get(raw.trim().toLowerCase());
      if (hit) categories[raw] = hit.category;
    }
    return { categories };
  },
);
