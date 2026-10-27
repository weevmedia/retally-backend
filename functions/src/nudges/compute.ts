/**
 * Home nudges, computed from the same purchase history the Smart List uses (items grouped
 * across stores and receipts, so "MLK 2% GAL" and "Milk 2%" are one item).
 *
 * Every figure in a nudge comes from plain arithmetic here — never from the model — so the
 * copy can be trusted. Candidates are ranked by `priority`; the app shows them as a carousel.
 */
import { ItemStats, PurchaseLine, StoreProfile, epochDay } from "../shopping/features";

export type NudgeKind =
  | "cheaper_elsewhere"
  | "price_creep"
  | "running_low"
  | "double_charge"
  | "spending_pace"
  | "price_drop";

export interface NudgeAction {
  /** What a tap opens in the app. */
  type: "shopping_list" | "receipt" | "budget";
  /** Store to open the Smart List on, for shopping_list. */
  storeName?: string;
  /** Receipt to open, for receipt. */
  receiptId?: string;
}

export interface NudgeDto {
  /** Stable across rebuilds while the same fact holds, so "seen" tracking survives. */
  id: string;
  kind: NudgeKind;
  title: string;
  body: string;
  /** The key figure, shown large on the card ("$1.80 cheaper", "+22%"). */
  highlight: string | null;
  action: NudgeAction | null;
  priority: number;
}

export interface ReceiptFact {
  id: string;
  storeKey: string;
  storeName: string;
  localDate: string;
  total: number;
}

export interface DuplicateFact {
  receiptId: string;
  storeName: string;
  item: string;
  price: number;
  localDate: string;
}

export interface NudgeInput {
  items: Map<string, ItemStats>;
  lines: PurchaseLine[];
  stores: Map<string, StoreProfile>;
  displayName: Map<string, string>;
  todayLocal: string;
  receipts: ReceiptFact[];
  duplicates: DuplicateFact[];
}

/** Most nudges kept per user (the carousel never needs more). */
export const MAX_NUDGES = 6;

const money = (n: number): string => `$${n.toFixed(2)}`;
const titleCase = (s: string): string => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

export function computeNudges(input: NudgeInput): NudgeDto[] {
  const all = [
    ...cheaperElsewhere(input),
    ...priceCreep(input),
    ...runningLow(input),
    ...doubleCharges(input),
    ...spendingPace(input),
  ];
  // One nudge per item at most (the highest-priority fact about it), then the top N.
  const seenItems = new Set<string>();
  return all
    .sort((a, b) => b.priority - a.priority)
    .filter((n) => {
      const item = n.id.split(":")[1];
      if (!item || n.kind === "spending_pace" || n.kind === "double_charge") return true;
      if (seenItems.has(item)) return false;
      seenItems.add(item);
      return true;
    })
    .slice(0, MAX_NUDGES);
}

/**
 * Same item noticeably cheaper at another store the shopper already visits:
 * at least 15% and $0.50 apart, both prices from 2+ purchases or a recent one.
 */
function cheaperElsewhere({ items, stores, displayName }: NudgeInput): NudgeDto[] {
  const out: NudgeDto[] = [];
  for (const item of items.values()) {
    const prices = Object.entries(item.avgPriceByStore).filter(([, p]) => p > 0);
    if (prices.length < 2) continue;
    const usual = item.lastStoreKey;
    const usualPrice = item.avgPriceByStore[usual];
    if (!usualPrice) continue;
    const [cheapKey, cheapPrice] = prices.sort((a, b) => a[1] - b[1])[0];
    if (cheapKey === usual) continue;
    const saving = usualPrice - cheapPrice;
    if (saving < 0.5 || saving / usualPrice < 0.15) continue;
    const name = titleCase(displayName.get(item.key) ?? item.key);
    const cheapStore = stores.get(cheapKey)?.name ?? cheapKey;
    const usualStore = stores.get(usual)?.name ?? usual;
    out.push({
      id: `cheaper_elsewhere:${slug(item.key)}:${slug(cheapKey)}`,
      kind: "cheaper_elsewhere",
      title: `Cheaper at ${cheapStore}`,
      body: `${name}: about ${money(cheapPrice)} at ${cheapStore} vs ${money(usualPrice)} at ${usualStore}.`,
      highlight: `${money(saving)} less`,
      action: { type: "shopping_list", storeName: cheapStore },
      priority: 50 + Math.min(30, Math.round((saving / usualPrice) * 100)),
    });
  }
  return out;
}

/**
 * The shopper's own price for an item crept up: last 30 days vs 60–180 days ago,
 * at least 15% higher, with 2+ purchases in each window.
 */
function priceCreep({ lines, displayName, todayLocal }: NudgeInput): NudgeDto[] {
  const today = epochDay(todayLocal);
  const byItem = new Map<string, { recent: number[]; before: number[] }>();
  for (const l of lines) {
    if (!(l.unitPrice > 0)) continue;
    const age = today - epochDay(l.localDate);
    const bucket = byItem.get(l.itemKey) ?? { recent: [], before: [] };
    if (age <= 30) bucket.recent.push(l.unitPrice);
    else if (age >= 60) bucket.before.push(l.unitPrice);
    byItem.set(l.itemKey, bucket);
  }
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const out: NudgeDto[] = [];
  for (const [key, { recent, before }] of byItem) {
    if (recent.length < 2 || before.length < 2) continue;
    const now = avg(recent);
    const then = avg(before);
    const pct = Math.round(((now - then) / then) * 100);
    if (pct < 15 || now - then < 0.3) continue;
    const name = titleCase(displayName.get(key) ?? key);
    out.push({
      id: `price_creep:${slug(key)}`,
      kind: "price_creep",
      title: "Price going up",
      body: `${name}: about ${money(now)} lately, up from ${money(then)} a few months ago.`,
      highlight: `+${pct}%`,
      action: null,
      priority: 40 + Math.min(30, pct),
    });
  }
  return out;
}

/** A regular item is due by its usual interval; suggests the store it's usually bought at. */
function runningLow({ items, stores, displayName }: NudgeInput): NudgeDto[] {
  const out: NudgeDto[] = [];
  for (const item of items.values()) {
    if (item.dayCount < 3 || item.intervalDays === null || item.dueRatio === null) continue;
    if (item.dueRatio < 1 || item.dueRatio > 3) continue; // > 3× late: probably stopped buying it
    const [storeKey] = Object.entries(item.storeCounts).sort((a, b) => b[1] - a[1])[0];
    const store = stores.get(storeKey);
    const storeName = store?.name ?? storeKey;
    const name = titleCase(displayName.get(item.key) ?? item.key);
    const every = Math.round(item.intervalDays);
    const when = store?.usualWeekday ? ` You usually shop there on ${store.usualWeekday}s.` : "";
    out.push({
      id: `running_low:${slug(item.key)}`,
      kind: "running_low",
      title: "Time to restock?",
      body: `${name}: you buy it about every ${every} days and it's been ${item.daysSinceLast}. Usually from ${storeName}.${when}`,
      highlight: `${item.daysSinceLast} days`,
      action: { type: "shopping_list", storeName },
      priority: 30 + Math.min(25, Math.round((item.dueRatio - 1) * 25) + item.dayCount),
    });
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, 3);
}

/** Double charges from the last 30 days the shopper may still get refunded. */
function doubleCharges({ duplicates, todayLocal }: NudgeInput): NudgeDto[] {
  const today = epochDay(todayLocal);
  const recent = duplicates.filter((d) => today - epochDay(d.localDate) <= 30 && d.price > 0);
  if (recent.length === 0) return [];
  const total = recent.reduce((a, d) => a + d.price, 0);
  const first = recent.sort((a, b) => b.price - a.price)[0];
  const others = recent.length - 1;
  return [{
    id: `double_charge:${slug(first.receiptId)}`,
    kind: "double_charge",
    title: others > 0 ? `${recent.length} double charges` : "Double charge found",
    body: others > 0
      ? `Including ${titleCase(first.item)} at ${first.storeName}. Most stores refund within 30 days — show the receipt at customer service.`
      : `${titleCase(first.item)} was charged twice. Most stores refund within 30 days — show the receipt at customer service.`,
    highlight: money(total),
    action: { type: "receipt", receiptId: first.receiptId },
    priority: 90,
  }];
}

/**
 * This month vs the shopper's usual month (average of the last 3 full months with receipts),
 * projected to month end at the current daily pace. Fires when ±15% off.
 */
function spendingPace({ receipts, todayLocal }: NudgeInput): NudgeDto[] {
  const [y, m, d] = todayLocal.split("-").map(Number);
  if (d < 7) return []; // too early in the month to say anything useful
  const monthKey = (date: string): string => date.slice(0, 7);
  const current = `${y}-${String(m).padStart(2, "0")}`;
  const byMonth = new Map<string, number>();
  for (const r of receipts) byMonth.set(monthKey(r.localDate), (byMonth.get(monthKey(r.localDate)) ?? 0) + r.total);
  const past = [...byMonth.entries()].filter(([k, v]) => k < current && v > 0).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 3);
  if (past.length < 2) return [];
  const usual = past.reduce((a, [, v]) => a + v, 0) / past.length;
  const spent = byMonth.get(current) ?? 0;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const projected = (spent / d) * daysInMonth;
  const diff = projected - usual;
  if (Math.abs(diff) / usual < 0.15) return [];
  const over = diff > 0;
  return [{
    id: `spending_pace:${current}:${over ? "over" : "under"}`,
    kind: "spending_pace",
    title: over ? "Spending is up" : "Spending is down",
    body: `${money(spent)} so far. At this pace you'll end near ${money(projected)}, vs your usual ${money(usual)}.`,
    highlight: `${over ? "+" : "−"}${money(Math.abs(diff))}`,
    action: { type: "budget" },
    priority: over ? 70 : 45,
  }];
}
