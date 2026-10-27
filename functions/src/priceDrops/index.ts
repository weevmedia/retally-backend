/**
 * Daily price-drop scan (v1). See ./compute.ts for the rules.
 *
 * Reads the last 30 days of synced receipts from every user, finds items that newer receipts
 * show cheaper at the same store chain, and saves each affected user's drops to
 * `users/{uid}/insights/priceDrops`. getNudges turns them into Home cards. Other shoppers'
 * receipts only ever contribute a price — never who bought it or where they live.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { storeKeyOf } from "../shared/storeKey";
import { loadStoreKeyIndex } from "../stores";
import type { NudgeDto } from "../nudges/compute";
import { PriceDrop, PriceObservation, WATCH_DAYS, findPriceDrops } from "./compute";

const DAY_MS = 86_400_000;
/** Safety cap on lines read per run; raise (or shard by date) as ReTally grows. */
const MAX_LINES = 50_000;
/** Remembers who has drops, so users whose drops ended get their doc removed. */
const RUN_DOC = "system/priceDrops";
/** Drops saved longer ago than this are ignored (the scan stopped running). */
const DROPS_TTL_MS = 3 * DAY_MS;

export const priceDropsPath = (uid: string): string => `users/${uid}/insights/priceDrops`;

/** Runs the scan and writes results. Returns how many users have drops. */
export async function runPriceDropScan(now = Date.now()): Promise<number> {
  const db = getFirestore();
  const cutoff = Timestamp.fromMillis(now - WATCH_DAYS * DAY_MS);
  const [receiptsSnap, linesSnap, index] = await Promise.all([
    db.collectionGroup("receipts").where("purchaseDate", ">=", cutoff)
      .select("storeName", "merchantNameNormalized", "deletedAt").get(),
    db.collectionGroup("lineItems").where("purchaseDate", ">=", cutoff)
      .select("uid", "receiptId", "rawDescription", "itemNumber", "unitPrice", "isDuplicate", "purchaseDate")
      .limit(MAX_LINES).get(),
    loadStoreKeyIndex(db),
  ]);
  if (linesSnap.size >= MAX_LINES) logger.warn(`price drops: hit the ${MAX_LINES}-line cap; results are partial`);

  // uid/receiptId -> store chain, for receipts that aren't deleted.
  const stores = new Map<string, { storeKey: string; storeName: string }>();
  for (const doc of receiptsSnap.docs) {
    const deleted = doc.get("deletedAt");
    if (deleted !== undefined && deleted !== null) continue;
    const uid = doc.ref.parent.parent?.id;
    const storeName = String(doc.get("storeName") ?? "").trim();
    if (!uid || !storeName) continue;
    const key = storeKeyOf(storeName);
    stores.set(`${uid}/${doc.id}`, { storeKey: index.get(key) ?? key, storeName });
  }

  const observations: PriceObservation[] = [];
  for (const doc of linesSnap.docs) {
    if (doc.get("isDuplicate") === true) continue;
    const uid = String(doc.get("uid") ?? "");
    const receiptId = String(doc.get("receiptId") ?? "");
    const store = stores.get(`${uid}/${receiptId}`);
    const at = (doc.get("purchaseDate") as Timestamp | undefined)?.toMillis();
    if (!store || !at) continue;
    const itemNumber = doc.get("itemNumber");
    observations.push({
      uid, receiptId, ...store,
      itemNumber: typeof itemNumber === "string" ? itemNumber : null,
      description: String(doc.get("rawDescription") ?? "").trim(),
      price: Number(doc.get("unitPrice") ?? 0) || 0,
      at,
    });
  }

  const drops = findPriceDrops(observations, now);
  const previous = new Set<string>(((await db.doc(RUN_DOC).get()).get("uids") ?? []) as string[]);
  const writer = db.bulkWriter();
  for (const [uid, list] of drops) {
    writer.set(db.doc(priceDropsPath(uid)), { type: "price_drops", drops: list, generatedAt: Timestamp.fromMillis(now) });
    previous.delete(uid);
  }
  for (const uid of previous) writer.delete(db.doc(priceDropsPath(uid)));
  await writer.close();
  await db.doc(RUN_DOC).set({ uids: [...drops.keys()], ranAt: Timestamp.fromMillis(now), lines: observations.length });
  logger.info(`price drops: ${observations.length} lines, ${drops.size} user(s) with drops, ${previous.size} cleared`);
  return drops.size;
}

/** Daily, early morning US time, so cards are ready before shopping trips. */
export const processPriceDrops = onSchedule(
  { schedule: "every day 05:30", timeZone: "America/New_York", region: REGION, timeoutSeconds: 540, memory: "1GiB" },
  async () => {
    await runPriceDropScan();
  },
);

/** The user's current drops as Home nudges (still inside the 30-day window). */
export async function priceDropNudges(uid: string, now = Date.now()): Promise<NudgeDto[]> {
  const snap = await getFirestore().doc(priceDropsPath(uid)).get();
  if (!snap.exists) return [];
  const generated = (snap.get("generatedAt") as Timestamp | undefined)?.toMillis() ?? 0;
  if (now - generated > DROPS_TTL_MS) return [];
  const drops = (snap.get("drops") ?? []) as PriceDrop[];
  return drops
    .filter((d) => now - d.purchasedAt <= WATCH_DAYS * DAY_MS)
    .map((d) => toNudge(d, now));
}

export function toNudge(d: PriceDrop, now: number): NudgeDto {
  return {
    id: d.id,
    kind: "price_drop",
    title: "Price dropped",
    body: `${d.item} at ${d.storeName}: you paid ${money(d.paid)} ${ago(d.purchasedAt, now)}; it's now ${money(d.current)}. ` +
      `Many stores refund the difference — check with ${d.storeName} before you go.`,
    highlight: `${money(d.drop)} less`,
    action: { type: "receipt", receiptId: d.receiptId },
    priority: 85,
  };
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function ago(at: number, now: number): string {
  const days = Math.max(0, Math.floor((now - at) / DAY_MS));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
