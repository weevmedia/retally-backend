/**
 * Collapses raw receipt lines into generic items with plain string matching — no AI.
 *
 *   "ORG BNNA 2LB", "BANANAS", "Organic Bananas"  ->  "banana"
 *   "GV WHL MLK 1GAL", "Whole Milk"               ->  "milk"
 *
 * Pipeline per line: clean (case, punctuation, sizes/units) -> drop modifiers and store-brand
 * prefixes -> expand abbreviations (dictionary, then partial match against a vocabulary) ->
 * singularize. A final pass merges near-duplicate keys that share the same head noun.
 *
 * Lines that still don't resolve to a known word (e.g. "KS TP 30R") are reported as
 * unresolved so the caller can ask Gemini to name them once and cache the answer.
 */

/** Units and size tokens — dropped. */
const UNITS = new Set([
  "lb", "lbs", "oz", "fl", "floz", "gal", "gallon", "qt", "pt", "ct", "cnt", "pk", "pkg", "pc", "pcs",
  "kg", "g", "gr", "ml", "l", "ltr", "ea", "each", "dz", "doz", "dozen", "ct.", "x",
]);

/**
 * Modifiers that don't change *what* the item is for a shopping list (organic banana is still
 * banana). Store-brand prefixes are included here.
 */
const MODIFIERS = new Set([
  // quality / variety
  "organic", "org", "og", "orgnc", "fresh", "frsh", "natural", "nat", "premium", "select", "choice",
  "classic", "original", "orig", "regular", "reg", "plain", "pure", "real", "simply", "homestyle",
  "whole", "whl", "boneless", "bnls", "skinless", "sknls", "lean", "lowfat", "nonfat", "fat", "free",
  "reduced", "light", "lite", "frozen", "frz", "fz", "loose", "bunch", "bag", "bagged", "family",
  "value", "size", "pack", "multipack", "variety", "assorted", "asst",
  // sizes
  "large", "lg", "lrg", "small", "sm", "medium", "med", "md", "xl", "jumbo", "mini", "big",
  // store brands
  "gv", "great", "ks", "kirkland", "signature", "sig", "365", "wf", "kroger", "kgr", "mm", "members",
  "mark", "good", "gather", "up", "market", "pantry", "essentials", "store", "brand", "sb", "hb", "pc",
  "wegmans", "publix", "aldi", "trader", "joes", "tj", "target", "walmart",
]);

/** Common receipt abbreviations -> word. */
const ABBREVIATIONS: Record<string, string> = {
  bnna: "banana", bnn: "banana", banan: "banana",
  mlk: "milk",
  chkn: "chicken", chk: "chicken", chik: "chicken", ckn: "chicken",
  brst: "breast", brsts: "breast", thgh: "thigh", thghs: "thigh",
  grnd: "ground",
  bf: "beef", trky: "turkey", trk: "turkey", prk: "pork",
  brd: "bread", bgl: "bagel", bgls: "bagel",
  egs: "egg",
  yog: "yogurt", ygrt: "yogurt", yogrt: "yogurt", ygt: "yogurt",
  chs: "cheese", chse: "cheese", ches: "cheese",
  bttr: "butter", btr: "butter",
  tom: "tomato", tmto: "tomato", tmt: "tomato", toms: "tomato",
  pot: "potato", ptato: "potato", pots: "potato", ptt: "potato",
  onn: "onion", onio: "onion",
  appl: "apple", aple: "apple", apls: "apple",
  strwb: "strawberry", strwbry: "strawberry", straw: "strawberry",
  blubry: "blueberry", blueb: "blueberry", rasp: "raspberry",
  avo: "avocado", avoc: "avocado", avcdo: "avocado",
  lett: "lettuce", lettc: "lettuce", rom: "romaine",
  spnch: "spinach", brcl: "broccoli", broc: "broccoli",
  cuc: "cucumber", cucmbr: "cucumber", crrt: "carrot", crt: "carrot",
  ppr: "pepper", pepr: "pepper", grlc: "garlic",
  crm: "cream", oj: "orange juice", jce: "juice", wtr: "water",
  cof: "coffee", cofe: "coffee", cff: "coffee",
  tp: "toilet paper", bth: "bath", tssu: "tissue", twl: "towel", twls: "towel",
  dtrgnt: "detergent", det: "detergent", shmp: "shampoo", tthpst: "toothpaste",
  sau: "sauce", sce: "sauce", ssg: "sausage", bcn: "bacon",
  slmn: "salmon", shrmp: "shrimp", tna: "tuna",
  crckr: "cracker", crkr: "cracker", chp: "chip", chps: "chip", ckie: "cookie", cke: "cookie",
  cer: "cereal", crl: "cereal", oatml: "oatmeal", choc: "chocolate", chc: "chocolate",
};

/** Seed vocabulary of generic grocery words, used for partial matching. */
export const SEED_VOCABULARY = [
  "banana", "apple", "orange", "lemon", "lime", "grape", "strawberry", "blueberry", "raspberry",
  "avocado", "tomato", "potato", "onion", "garlic", "carrot", "celery", "lettuce", "romaine",
  "spinach", "broccoli", "cucumber", "pepper", "mushroom", "corn", "bean", "pea", "zucchini",
  "rice", "pasta", "spaghetti", "noodle", "bread", "bagel", "tortilla", "cereal", "oatmeal", "flour",
  "sugar", "salt", "oil", "butter", "milk", "cream", "cheese", "yogurt", "egg", "chicken", "breast",
  "thigh", "beef", "ground", "steak", "pork", "turkey", "bacon", "sausage", "ham", "fish", "salmon",
  "shrimp", "tuna", "coffee", "tea", "juice", "water", "soda", "beer", "wine", "chip", "cracker",
  "cookie", "chocolate", "candy", "almond", "peanut", "walnut", "soup", "sauce", "ketchup",
  "mustard", "mayonnaise", "honey", "jam", "jelly", "towel", "paper", "toilet", "tissue",
  "detergent", "soap", "shampoo", "conditioner", "toothpaste", "diaper", "wipe", "foil", "trash",
  "dog", "cat", "food", "salsa", "hummus", "granola", "pretzel", "popcorn", "cake", "muffin",
  "donut", "pizza", "ice", "berry", "melon", "watermelon", "pineapple", "mango", "peach", "pear",
  "cherry", "kiwi", "cabbage", "kale", "asparagus", "cilantro", "parsley", "basil", "ginger",
];

export interface GroupingResult {
  /** raw line (as printed) -> generic item key, e.g. "ORG BNNA 2LB" -> "banana" */
  keyByRaw: Map<string, string>;
  /** generic key -> display name, e.g. "banana" -> "Banana" */
  displayName: Map<string, string>;
  /** raw lines that did not resolve to any known word — candidates for AI naming */
  unresolved: string[];
}

/** Lower-case, strip punctuation and size/price tokens. */
export function cleanTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/(\d+(\.\d+)?)(lb|lbs|oz|ct|pk|gal|kg|g|ml|l|qt|dz)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^\d/.test(t) && !UNITS.has(t));
}

/** Words whose singular ends in "ie" rather than "y". */
const IE_WORDS = new Set(["cookie", "brownie", "pie", "veggie", "smoothie", "rotisserie", "hoagie", "calorie"]);

/** Rough English singular: berries->berry, tomatoes->tomato, peaches->peach, eggs->egg. */
export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) {
    // cookies -> cookie (not "cooky"); berries -> berry.
    return IE_WORDS.has(word.slice(0, -1)) ? word.slice(0, -1) : word.slice(0, -3) + "y";
  }
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (/(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

/** Consonant skeleton: "banana" -> "bnn", "bnna" -> "bnn". */
function skeleton(word: string): string {
  return word.replace(/[aeiou]/g, "").replace(/(.)\1+/g, "$1");
}

/**
 * Partial match of one token against the vocabulary: prefix of 3+ letters ("bana" -> banana)
 * or same consonant skeleton ("bnna" -> banana). Shortest match wins; null when none.
 */
export function partialMatch(token: string, vocabulary: Iterable<string>): string | null {
  if (token.length < 3) return null;
  const tokenSkel = skeleton(token);
  let best: string | null = null;
  for (const word of vocabulary) {
    if (word === token) return word;
    // Prefix must cover most of the word: "bana" -> banana, but not "roma" -> romaine.
    const prefix = word.startsWith(token) && token.length / word.length >= 0.6;
    const skelMatch = tokenSkel.length >= 3 && (skeleton(word) === tokenSkel ||
      (skeleton(word).startsWith(tokenSkel) && tokenSkel.length >= skeleton(word).length - 1));
    if ((prefix || skelMatch) && (best === null || word.length < best.length)) best = word;
  }
  return best;
}

interface Resolved { tokens: string[]; known: boolean }

function resolveLine(raw: string, vocabulary: Set<string>): Resolved {
  const out: string[] = [];
  let known = false;
  for (const token of cleanTokens(raw)) {
    if (MODIFIERS.has(token)) continue;
    const abbr = ABBREVIATIONS[token];
    if (abbr) {
      for (const w of abbr.split(" ")) out.push(w);
      known = true;
      continue;
    }
    const single = singularize(token);
    if (vocabulary.has(single)) {
      out.push(single);
      known = true;
      continue;
    }
    const partial = partialMatch(single, vocabulary);
    if (partial) {
      out.push(partial);
      known = true;
      continue;
    }
    out.push(single);
  }
  return { tokens: [...new Set(out)], known };
}

/** Head noun = last token ("banana bread" is bread, "chicken breast" is breast). */
const head = (key: string): string => key.split(" ").slice(-1)[0];

/**
 * Groups raw lines into generic items.
 *
 * @param rawNames every line description seen for the user (duplicates fine)
 * @param aliases cached raw -> canonical names (from earlier AI naming); applied first
 */
export function groupItems(rawNames: string[], aliases: Map<string, string> = new Map()): GroupingResult {
  const unique = [...new Set(rawNames.map((r) => r.trim()).filter((r) => r.length > 0))];

  // Vocabulary = seed words + longer words from this user's own history (their spelling wins).
  const vocabulary = new Set(SEED_VOCABULARY);
  for (const raw of unique) {
    for (const t of cleanTokens(raw)) {
      const s = singularize(t);
      if (s.length >= 5 && !MODIFIERS.has(s) && !ABBREVIATIONS[s]) vocabulary.add(s);
    }
  }

  const keyByRaw = new Map<string, string>();
  const unresolved: string[] = [];
  for (const raw of unique) {
    const cached = aliases.get(raw.toLowerCase());
    if (cached) {
      keyByRaw.set(raw, resolveLine(cached, vocabulary).tokens.join(" ") || cached.toLowerCase());
      continue;
    }
    const { tokens, known } = resolveLine(raw, vocabulary);
    const key = tokens.join(" ") || cleanTokens(raw).join(" ") || raw.toLowerCase();
    keyByRaw.set(raw, key);
    if (!known) unresolved.push(raw);
  }

  // Merge near-duplicates that share a head noun: "milk" absorbs "chocolate milk"? No — only
  // when the shorter key's tokens are all inside the longer one AND the heads match, or the
  // token overlap is >= 50% with the same head. Generic (shorter) key wins.
  const keys = [...new Set(keyByRaw.values())].sort((a, b) => a.split(" ").length - b.split(" ").length || a.localeCompare(b));
  const canonical = new Map<string, string>();
  for (const key of keys) {
    const tokens = new Set(key.split(" "));
    let target = key;
    for (const other of keys) {
      if (other === key || canonical.has(other) && canonical.get(other) !== other) continue;
      if (other.split(" ").length > key.split(" ").length) continue;
      const otherTokens = other.split(" ");
      const sameSet = otherTokens.length === tokens.size && otherTokens.every((t) => tokens.has(t));
      if (sameSet) {
        // "yogurt greek" and "greek yogurt": same item, word order differs.
        if (other < target) target = other;
        continue;
      }
      if (head(other) !== head(key)) continue;
      const inter = otherTokens.filter((t) => tokens.has(t)).length;
      const union = new Set([...otherTokens, ...tokens]).size;
      const subset = inter === otherTokens.length;
      if ((subset || inter / union >= 0.5) && other.length < target.length) target = other;
    }
    canonical.set(key, target);
  }
  for (const [raw, key] of keyByRaw) keyByRaw.set(raw, canonical.get(key) ?? key);

  const displayName = new Map<string, string>();
  for (const key of new Set(keyByRaw.values())) {
    displayName.set(key, key.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return { keyByRaw, displayName, unresolved };
}
