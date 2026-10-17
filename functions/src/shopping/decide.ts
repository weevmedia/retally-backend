/**
 * Builds one store's shopping list. Gemini makes the decisions from compact per-item
 * stats; every answer is validated against the input, and an arithmetic fallback is used
 * when Gemini fails, so the list never disappears.
 */
import { GEMINI_DECISION_MODEL, generateJson } from "../shared/gemini";
import { ItemStats, StoreProfile } from "./features";

export const PROMPT_VERSION = "sl-v1";
const MAX_CANDIDATES = 60;
const MAX_DUE = 15;
const MAX_ALSO = 8;
const MAX_FREQUENT = 8;

export interface DueItem { item: string; reason: string; confidence: number }
export interface AlsoHereItem { item: string; usualStore: string; reason: string; confidence: number }
export interface FrequentItem { item: string; reason: string }

export interface ShoppingListDecision {
  dueHere: DueItem[];
  alsoHere: AlsoHereItem[];
  frequent: FrequentItem[];
  usualShoppingDay: string | null;
  /** "gemini" or "fallback" — stored so the app/analytics can tell them apart */
  decidedBy: "gemini" | "fallback";
  model: string | null;
}

interface CandidateRow {
  item: string;
  timesBought: number;
  everyDays: number | null;
  daysSinceLast: number;
  dueRatio: number | null;
  shareHere: number;
  boughtHereEver: boolean;
  usualStore: string;
  avgPriceHere: number | null;
  lowestAvgPriceElsewhere: { store: string; price: number } | null;
  category: string;
}

function candidates(
  items: Map<string, ItemStats>,
  displayName: Map<string, string>,
  store: StoreProfile,
  stores: Map<string, StoreProfile>,
): CandidateRow[] {
  const rows: CandidateRow[] = [];
  for (const s of items.values()) {
    const total = Object.values(s.storeCounts).reduce((a, b) => a + b, 0);
    const here = s.storeCounts[store.key] ?? 0;
    const usual = Object.entries(s.storeCounts).sort((a, b) => b[1] - a[1])[0][0];
    const elsewhere = Object.entries(s.avgPriceByStore)
      .filter(([k]) => k !== store.key)
      .sort((a, b) => a[1] - b[1])[0];
    rows.push({
      item: displayName.get(s.key) ?? s.key,
      timesBought: s.purchaseCount,
      everyDays: s.intervalDays,
      daysSinceLast: s.daysSinceLast,
      dueRatio: s.dueRatio,
      shareHere: Math.round((here / total) * 100) / 100,
      boughtHereEver: here > 0,
      usualStore: stores.get(usual)?.name ?? usual,
      avgPriceHere: s.avgPriceByStore[store.key] ?? null,
      lowestAvgPriceElsewhere: elsewhere ? { store: stores.get(elsewhere[0])?.name ?? elsewhere[0], price: elsewhere[1] } : null,
      category: s.category,
    });
  }
  // Most due first, then most frequent; one-off purchases are kept only if bought here recently.
  return rows
    .filter((r) => r.timesBought >= 2 || (r.boughtHereEver && r.daysSinceLast <= 30))
    .sort((a, b) => (b.dueRatio ?? 0) - (a.dueRatio ?? 0) || b.timesBought - a.timesBought)
    .slice(0, MAX_CANDIDATES);
}

function prompt(rows: CandidateRow[], store: StoreProfile, todayLocal: string, weekdayName: string): string {
  const topCategories = Object.entries(store.categoryCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
  return `You build a personal grocery shopping list for one shopper who is at, or about to visit, a store.
Decide from their purchase history below. Today is ${weekdayName} ${todayLocal}.

Store: "${store.name}" (${store.tripCount} past trips; categories they buy here: ${topCategories.join(", ") || "unknown"}).

Each candidate row: item, timesBought, everyDays (learned interval between purchases), daysSinceLast,
dueRatio (daysSinceLast / everyDays; >= 1 means due), shareHere (fraction of purchases made at this store),
boughtHereEver, usualStore, avgPriceHere, lowestAvgPriceElsewhere, category.

Candidates:
${JSON.stringify(rows)}

Return three lists:
1. "dueHere": items they normally buy at THIS store (shareHere >= 0.3 or boughtHereEver with recent purchases)
   that are due or nearly due (dueRatio >= 0.8). Most due first.
2. "alsoHere": items that are due or nearly due but usually bought at ANOTHER store, which this store very likely
   sells (judge from the store's name/type and the categories they buy here). Include "usualStore".
   Mention a price difference in the reason when the data shows one.
3. "frequent": staples bought often that are not due yet and that they buy here (or this store clearly sells),
   worth a glance.

Rules:
- Use ONLY item names from the candidates, spelled exactly as given. Never invent items.
- An item appears in at most one list.
- "reason" is one short, factual sentence from the data (e.g. "Every ~6 days; last bought 7 days ago").
- "confidence" is 0.0-1.0: how sure you are the shopper needs it on this trip.
- Up to ${MAX_DUE} dueHere, ${MAX_ALSO} alsoHere, ${MAX_FREQUENT} frequent. Empty lists are fine.

Return ONLY JSON:
{"dueHere":[{"item":"","reason":"","confidence":0.0}],
 "alsoHere":[{"item":"","usualStore":"","reason":"","confidence":0.0}],
 "frequent":[{"item":"","reason":""}]}`;
}

const clamp01 = (v: unknown): number => Math.min(1, Math.max(0, typeof v === "number" && isFinite(v) ? v : 0));
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Keeps only items that exist in the input, once each, within the caps. */
function validate(raw: unknown, rows: CandidateRow[]): Omit<ShoppingListDecision, "usualShoppingDay" | "decidedBy" | "model"> {
  const byName = new Map(rows.map((r) => [r.item.toLowerCase(), r]));
  const used = new Set<string>();
  const take = (name: unknown): CandidateRow | null => {
    const row = byName.get(text(name, 80).toLowerCase());
    if (!row || used.has(row.item)) return null;
    used.add(row.item);
    return row;
  };
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

  const dueHere: DueItem[] = [];
  for (const d of list(r.dueHere)) {
    const row = take(d.item);
    if (row && dueHere.length < MAX_DUE) dueHere.push({ item: row.item, reason: text(d.reason, 140), confidence: clamp01(d.confidence) });
  }
  const alsoHere: AlsoHereItem[] = [];
  for (const d of list(r.alsoHere)) {
    const row = take(d.item);
    if (row && alsoHere.length < MAX_ALSO) {
      alsoHere.push({ item: row.item, usualStore: row.usualStore, reason: text(d.reason, 160), confidence: clamp01(d.confidence) });
    }
  }
  const frequent: FrequentItem[] = [];
  for (const d of list(r.frequent)) {
    const row = take(d.item);
    if (row && frequent.length < MAX_FREQUENT) frequent.push({ item: row.item, reason: text(d.reason, 140) });
  }
  return { dueHere, alsoHere, frequent };
}

/** Arithmetic-only list, used when Gemini is unavailable. */
function fallback(rows: CandidateRow[], store: StoreProfile): Omit<ShoppingListDecision, "usualShoppingDay" | "decidedBy" | "model"> {
  const categoriesHere = new Set(Object.entries(store.categoryCounts).filter(([, n]) => n >= 2).map(([c]) => c));
  const used = new Set<string>();
  const reason = (r: CandidateRow): string =>
    r.everyDays ? `Every ~${Math.round(r.everyDays)} days; last bought ${r.daysSinceLast} days ago` : `Bought ${r.timesBought} times`;

  const dueHere = rows
    .filter((r) => (r.dueRatio ?? 0) >= 0.8 && (r.shareHere >= 0.3 || r.boughtHereEver))
    .slice(0, MAX_DUE)
    .map((r) => { used.add(r.item); return { item: r.item, reason: reason(r), confidence: Math.round(Math.min(1, (r.dueRatio ?? 0) / 1.5) * 100) / 100 }; });
  const alsoHere = rows
    .filter((r) => !used.has(r.item) && (r.dueRatio ?? 0) >= 0.7 && r.shareHere < 0.3 &&
      (r.boughtHereEver || categoriesHere.has(r.category)))
    .slice(0, MAX_ALSO)
    .map((r) => { used.add(r.item); return { item: r.item, usualStore: r.usualStore, reason: `${reason(r)}; usually from ${r.usualStore}`, confidence: 0.5 }; });
  const frequent = rows
    .filter((r) => !used.has(r.item) && r.timesBought >= 3 && (r.boughtHereEver || categoriesHere.has(r.category)))
    .sort((a, b) => b.timesBought - a.timesBought)
    .slice(0, MAX_FREQUENT)
    .map((r) => ({ item: r.item, reason: `Bought ${r.timesBought} times` }));
  return { dueHere, alsoHere, frequent };
}

export async function decideShoppingList(
  items: Map<string, ItemStats>,
  displayName: Map<string, string>,
  store: StoreProfile,
  stores: Map<string, StoreProfile>,
  todayLocal: string,
  weekdayName: string,
): Promise<ShoppingListDecision> {
  const rows = candidates(items, displayName, store, stores);
  if (rows.length === 0) {
    return { dueHere: [], alsoHere: [], frequent: [], usualShoppingDay: store.usualWeekday, decidedBy: "fallback", model: null };
  }
  try {
    const raw = await generateJson<unknown>(GEMINI_DECISION_MODEL, prompt(rows, store, todayLocal, weekdayName), {
      temperature: 0.2, maxOutputTokens: 4096,
    });
    return { ...validate(raw, rows), usualShoppingDay: store.usualWeekday, decidedBy: "gemini", model: GEMINI_DECISION_MODEL };
  } catch (e) {
    console.error(`decideShoppingList: Gemini failed for store ${store.key}, using fallback`, e);
    return { ...fallback(rows, store), usualShoppingDay: store.usualWeekday, decidedBy: "fallback", model: null };
  }
}
