/**
 * Store-name normalisation shared by the backend. MUST match the app's `iconKeyOf`
 * (shared/.../domain/store/StoreIcon.kt) and the console's `storeKeyOf` — the store key is how a
 * printed name on a receipt finds its logo. "Trader Joe's #552" → "traderjoes".
 */
const SUFFIXES = new Set([
  "supercenter", "supermarket", "wholesale", "market", "markets",
  "store", "stores", "grocery", "groceries", "foods", "food",
]);

export function storeKeyOf(storeName: string): string {
  const key = storeName
    .toLowerCase()
    .replace(/#\d+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !SUFFIXES.has(w))
    .join("");
  return key || "unknown";
}

/** "COSTCO WHOLESALE #1234" → "Costco Wholesale" — a readable starting name for a new store. */
export function displayNameOf(storeName: string): string {
  return storeName
    .replace(/#\s*\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(^|[\s\-/&(])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase())
    .slice(0, 64);
}

/** Worth creating a store for? Skips empty / numeric / one-letter OCR noise. */
export function isPlausibleStoreName(storeName: string): boolean {
  const key = storeKeyOf(storeName);
  return key !== "unknown" && key.length >= 2 && key.length <= 64 && /[a-z]/.test(key);
}
