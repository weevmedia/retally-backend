/**
 * AI naming for receipt lines the string matcher could not resolve (e.g. "KS TP 30R").
 * Each raw text is sent to Gemini at most once; answers are cached in /itemAliases
 * (function-only collection) and reused for every user.
 */
import { getFirestore } from "firebase-admin/firestore";
import { sha256 } from "../shared/crypto";
import { GEMINI_LITE_MODEL, generateJson } from "../shared/gemini";

const COLLECTION = "itemAliases";
const MAX_PER_RUN = 50;

const NAMING_PROMPT = `You name grocery receipt lines. For each line, return the generic product a shopper
would write on a shopping list: lower-case, singular, no brand, no size, no "organic"/"fresh".
Examples: "KS TP 30R" -> "toilet paper", "ORG BNNA" -> "banana", "GV 2% MLK" -> "milk".
If a line is not a product (fees, deposits, coupons, bag charges), return null for it.

Return ONLY JSON: {"items":[{"raw":"<exact input>","name":"<generic name or null>"}]}

Lines:
`;

/**
 * raw (lower-cased) -> cached generic name for every raw in [raws] already named.
 * An empty string means "not a product" (fee, deposit, coupon): callers drop those lines.
 */
export async function loadAliases(raws: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(raws.map((r) => r.trim().toLowerCase()))].filter((r) => r.length > 0);
  const db = getFirestore();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const snaps = await db.getAll(...chunk.map((r) => db.collection(COLLECTION).doc(sha256(r))));
    snaps.forEach((snap, idx) => {
      if (!snap.exists) return;
      const name = snap.get("name");
      out.set(chunk[idx], typeof name === "string" ? name : "");
    });
  }
  return out;
}

/**
 * Asks Gemini to name up to [MAX_PER_RUN] unresolved lines, caches the answers and returns
 * them (raw lower-cased -> name, "" for non-products). Failures are logged and return an empty map: naming is a
 * quality boost, never a requirement.
 */
export async function nameUnresolved(raws: string[]): Promise<Map<string, string>> {
  const pending = [...new Set(raws.map((r) => r.trim()))].filter((r) => r.length > 0).slice(0, MAX_PER_RUN);
  const out = new Map<string, string>();
  if (pending.length === 0) return out;
  try {
    const res = await generateJson<{ items?: Array<{ raw?: string; name?: string | null }> }>(
      GEMINI_LITE_MODEL,
      NAMING_PROMPT + pending.map((r) => `- ${r}`).join("\n"),
      { temperature: 0, maxOutputTokens: 2048 },
    );
    const allowed = new Set(pending.map((r) => r.toLowerCase()));
    const db = getFirestore();
    const batch = db.batch();
    for (const item of res.items ?? []) {
      const raw = (item.raw ?? "").trim().toLowerCase();
      if (!allowed.has(raw)) continue; // ignore anything the model invented
      const name = typeof item.name === "string" ? item.name.trim().toLowerCase().slice(0, 60) : "";
      // Merge: keeps the category the categorizeItems call may have cached for this line.
      batch.set(db.collection(COLLECTION).doc(sha256(raw)), {
        raw, name: name || null, model: GEMINI_LITE_MODEL, createdAt: new Date(),
      }, { merge: true });
      out.set(raw, name);
    }
    await batch.commit();
  } catch (e) {
    console.error("nameUnresolved failed", e);
  }
  return out;
}
