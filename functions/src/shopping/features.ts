/**
 * Plain arithmetic over a user's purchase history: per generic item and per store.
 * These rows are what Gemini sees (never raw receipts), and what the fallback ranks.
 */

export interface PurchaseLine {
  /** generic item key from itemGrouping, e.g. "banana" */
  itemKey: string;
  storeKey: string;
  /** YYYY-MM-DD in the user's time zone */
  localDate: string;
  unitPrice: number;
  category: string;
}

export interface ItemStats {
  key: string;
  purchaseCount: number;
  /** distinct shopping days the item was bought on */
  dayCount: number;
  /** learned interval: weak 7-day prior blended with the observed gaps (same as the app's IntervalModel) */
  intervalDays: number | null;
  daysSinceLast: number;
  /** daysSinceLast / intervalDays; >= 1 means due */
  dueRatio: number | null;
  lastStoreKey: string;
  storeCounts: Record<string, number>;
  /** average unit price per store */
  avgPriceByStore: Record<string, number>;
  category: string;
}

export interface StoreProfile {
  key: string;
  name: string;
  tripCount: number;
  /** trips per weekday, 0 = Sunday */
  weekdayCounts: number[];
  /** weekday name when >= 40% of 3+ trips fall on it, else null */
  usualWeekday: string | null;
  /** how many lines per category were bought here */
  categoryCounts: Record<string, number>;
  lastTripDate: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PRIOR_DAYS = 7;
const PRIOR_WEIGHT = 1;

export const epochDay = (localDate: string): number => Math.floor(Date.parse(`${localDate}T00:00:00Z`) / 86_400_000);
const weekday = (localDate: string): number => new Date(`${localDate}T00:00:00Z`).getUTCDay();

export function buildItemStats(lines: PurchaseLine[], todayLocal: string): Map<string, ItemStats> {
  const today = epochDay(todayLocal);
  const byItem = new Map<string, PurchaseLine[]>();
  for (const line of lines) {
    const list = byItem.get(line.itemKey) ?? [];
    list.push(line);
    byItem.set(line.itemKey, list);
  }
  const out = new Map<string, ItemStats>();
  for (const [key, list] of byItem) {
    const days = [...new Set(list.map((l) => epochDay(l.localDate)))].sort((a, b) => a - b);
    const gaps = days.slice(1).map((d, i) => d - days[i]);
    const intervalDays = gaps.length > 0
      ? (PRIOR_WEIGHT * PRIOR_DAYS + gaps.reduce((a, b) => a + b, 0)) / (PRIOR_WEIGHT + gaps.length)
      : null;
    const daysSinceLast = today - days[days.length - 1];
    const latest = [...list].sort((a, b) => a.localDate.localeCompare(b.localDate)).slice(-1)[0];

    const storeCounts: Record<string, number> = {};
    const priceSums: Record<string, { sum: number; n: number }> = {};
    const categoryCounts: Record<string, number> = {};
    for (const l of list) {
      storeCounts[l.storeKey] = (storeCounts[l.storeKey] ?? 0) + 1;
      if (l.unitPrice > 0) {
        const p = priceSums[l.storeKey] ?? { sum: 0, n: 0 };
        p.sum += l.unitPrice; p.n += 1;
        priceSums[l.storeKey] = p;
      }
      categoryCounts[l.category] = (categoryCounts[l.category] ?? 0) + 1;
    }
    const avgPriceByStore: Record<string, number> = {};
    for (const [s, p] of Object.entries(priceSums)) avgPriceByStore[s] = Math.round((p.sum / p.n) * 100) / 100;

    out.set(key, {
      key,
      purchaseCount: list.length,
      dayCount: days.length,
      intervalDays: intervalDays === null ? null : Math.round(intervalDays * 10) / 10,
      daysSinceLast,
      dueRatio: intervalDays ? Math.round((daysSinceLast / intervalDays) * 100) / 100 : null,
      lastStoreKey: latest.storeKey,
      storeCounts,
      avgPriceByStore,
      category: Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0][0],
    });
  }
  return out;
}

export function buildStoreProfiles(
  lines: PurchaseLine[],
  trips: Array<{ storeKey: string; storeName: string; localDate: string }>,
): Map<string, StoreProfile> {
  const out = new Map<string, StoreProfile>();
  const tripDays = new Map<string, Set<string>>();
  for (const t of trips) {
    const p = out.get(t.storeKey) ?? {
      key: t.storeKey, name: t.storeName, tripCount: 0, weekdayCounts: [0, 0, 0, 0, 0, 0, 0],
      usualWeekday: null, categoryCounts: {}, lastTripDate: t.localDate,
    };
    const seen = tripDays.get(t.storeKey) ?? new Set<string>();
    if (!seen.has(t.localDate)) {
      seen.add(t.localDate);
      p.tripCount += 1;
      p.weekdayCounts[weekday(t.localDate)] += 1;
    }
    if (t.localDate > p.lastTripDate) p.lastTripDate = t.localDate;
    tripDays.set(t.storeKey, seen);
    out.set(t.storeKey, p);
  }
  for (const l of lines) {
    const p = out.get(l.storeKey);
    if (p) p.categoryCounts[l.category] = (p.categoryCounts[l.category] ?? 0) + 1;
  }
  for (const p of out.values()) {
    const max = Math.max(...p.weekdayCounts);
    if (p.tripCount >= 3 && max / p.tripCount >= 0.4) p.usualWeekday = WEEKDAYS[p.weekdayCounts.indexOf(max)];
  }
  return out;
}
