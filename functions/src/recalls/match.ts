/**
 * "You may have bought this": compares recall text with the generic item names from the
 * shopper's own receipts (the same names SmartList uses, e.g. "Greek Yogurt", "Chicken
 * Breast"). Receipts rarely carry brand or lot numbers, so a match is a hint, not a verdict.
 */
import { singularize } from "../shopping/itemGrouping";

export interface PurchasedItem {
  name: string;
  /** YYYY-MM-DD of the most recent purchase. */
  lastBought: string;
}

export interface RecallMatch {
  item: string;
  lastBought: string;
}

/** Words too vague to tie a recall to a purchase on their own. */
const VAGUE = new Set([
  "product", "food", "item", "pack", "brand", "fresh", "original", "mix", "meal", "snack", "organic",
  "natural", "classic", "large", "small", "family", "value", "frozen", "assorted", "variety", "style",
]);

export function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 3) continue;
    out.add(w);
    out.add(singularize(w));
  }
  return out;
}

/**
 * Keeps only the "what product" part of recall text. The reason clause is dropped so an
 * allergen recall ("cookies … due to undeclared milk") does not match a shopper's milk.
 */
export function productPart(text: string): string {
  return text
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.split(/\b(?:due to|because|for (?:possible|potential)|over (?:possible|potential)|after|following|may contain|contains?|undeclared|allerg\w*|which (?:may|could))\b/i)[0])
    .join(" ");
}

/** Best (most specific) purchased item whose every meaningful word appears in the recall. */
export function matchRecall(recallText: string, items: PurchasedItem[]): RecallMatch | null {
  const words = wordsOf(productPart(recallText));
  let best: { item: PurchasedItem; score: number } | null = null;
  for (const item of items) {
    const tokens = [...wordsOf(item.name)].filter((t) => !VAGUE.has(t));
    const unique = [...new Set(tokens.map(singularize))];
    if (unique.length === 0) continue;
    if (!unique.every((t) => words.has(t))) continue;
    const score = unique.length * 10 + unique.join("").length;
    if (!best || score > best.score || (score === best.score && item.lastBought > best.item.lastBought)) {
      best = { item, score };
    }
  }
  return best ? { item: best.item.name, lastBought: best.item.lastBought } : null;
}
