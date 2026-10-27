/**
 * Price drops after purchase (v1): items a user bought in the last 30 days that newer
 * ReTally receipts — from any user — show cheaper at the same store chain.
 *
 * Pure logic, no Firestore: the scheduler in ./index.ts loads observations and writes results.
 * Every figure comes from receipts; nothing is guessed. The app always tells the user to
 * check with the store first — stores' price-adjustment rules vary.
 */

/** How long after purchase an item is watched (v1: one bucket for every store). */
export const WATCH_DAYS = 30;
/** The cheaper price must have been seen this recently to count as "now". */
export const CURRENT_DAYS = 7;
/** Items cheaper than this aren't worth a trip. */
export const MIN_PAID = 5;
/** A drop must be at least this much… */
export const MIN_DROP = 2;
/** …and at least this share of what was paid. */
export const MIN_DROP_RATIO = 0.05;
/** Prices under this share of what was paid are treated as misreads (or per-lb lines). */
export const MIN_CURRENT_RATIO = 0.3;
/** Most drops kept per user. */
export const MAX_DROPS_PER_USER = 5;

const DAY_MS = 86_400_000;

/** One priced line from a synced receipt. */
export interface PriceObservation {
  uid: string;
  receiptId: string;
  /** Store chain (store-table key, aliases resolved). */
  storeKey: string;
  storeName: string;
  /** Printed item code when the receipt has one, else the printed description. */
  itemNumber: string | null;
  description: string;
  price: number;
  /** Purchase time (ms). */
  at: number;
}

export interface PriceDrop {
  /** Stable while the same purchase is the subject, so "seen" survives rebuilds. */
  id: string;
  receiptId: string;
  storeName: string;
  item: string;
  paid: number;
  current: number;
  drop: number;
  /** Purchase time (ms). */
  purchasedAt: number;
  /** When the lower price was last seen (ms). */
  seenAt: number;
}

const NON_PRODUCT = /\b(sub ?total|total|tax|change|cash|visa|mastercard|amex|debit|credit|balance|coupon|discount|savings|you saved|bag fee|bottle deposit|deposit|tip|refund|return)\b/i;

/** How the same product is recognised across receipts of one chain. */
export function identityOf(o: Pick<PriceObservation, "itemNumber" | "description">): string | null {
  const num = (o.itemNumber ?? "").replace(/\D/g, "");
  if (num.length >= 4) return `n:${num}`;
  const desc = o.description.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // Very short descriptions ("MILK", "BAG") are too ambiguous to compare across shoppers.
  if (desc.length < 6 || !/[a-z]/.test(desc)) return null;
  return `d:${desc}`;
}

export function isProductLine(description: string, price: number): boolean {
  return price > 0 && !NON_PRODUCT.test(description);
}

/** "SONY 55IN 4K TV" -> "Sony 55in 4k Tv": receipt text, made readable. */
export function readableItem(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Finds each user's price drops. [now] is the run time (ms).
 * A drop needs: purchase within [WATCH_DAYS]; a lower price for the same item at the same chain
 * on a later receipt seen within [CURRENT_DAYS]; and the latest price seen being that lower one
 * (if the price went back up, there's nothing to claim).
 */
export function findPriceDrops(observations: PriceObservation[], now: number): Map<string, PriceDrop[]> {
  // Group every valid line by chain + product.
  const groups = new Map<string, PriceObservation[]>();
  for (const o of observations) {
    if (!o.storeKey || !isProductLine(o.description, o.price)) continue;
    const identity = identityOf(o);
    if (!identity) continue;
    const key = `${o.storeKey}|${identity}`;
    const list = groups.get(key);
    if (list) list.push(o); else groups.set(key, [o]);
  }

  const byUser = new Map<string, Map<string, PriceDrop>>();
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    // "Now" = the most recent day this product was seen; the lowest price on that day.
    const latestAt = Math.max(...list.map((o) => o.at));
    if (now - latestAt > CURRENT_DAYS * DAY_MS) continue;
    const latestDay = Math.floor(latestAt / DAY_MS);
    const latest = list.filter((o) => Math.floor(o.at / DAY_MS) === latestDay);
    const current = Math.min(...latest.map((o) => o.price));

    for (const bought of list) {
      if (now - bought.at > WATCH_DAYS * DAY_MS) continue;
      if (bought.at >= latestAt) continue; // the cheaper price must come after the purchase
      if (bought.price < MIN_PAID) continue;
      const drop = round2(bought.price - current);
      if (drop < MIN_DROP || drop < bought.price * MIN_DROP_RATIO) continue;
      if (current < bought.price * MIN_CURRENT_RATIO) continue;

      const mine = byUser.get(bought.uid) ?? new Map<string, PriceDrop>();
      // One drop per product per user: the most recent purchase of it.
      const existing = mine.get(key);
      if (existing && existing.purchasedAt >= bought.at) continue;
      mine.set(key, {
        id: `price_drop:${bought.receiptId}:${key.split("|")[1]}`.slice(0, 200),
        receiptId: bought.receiptId,
        storeName: bought.storeName,
        item: readableItem(bought.description),
        paid: round2(bought.price),
        current: round2(current),
        drop,
        purchasedAt: bought.at,
        seenAt: latestAt,
      });
      byUser.set(bought.uid, mine);
    }
  }

  const result = new Map<string, PriceDrop[]>();
  for (const [uid, drops] of byUser) {
    result.set(uid, [...drops.values()].sort((a, b) => b.drop - a.drop).slice(0, MAX_DROPS_PER_USER));
  }
  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
