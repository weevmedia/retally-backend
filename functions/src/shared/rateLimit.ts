/**
 * Per-caller rate limiting for the pre-auth HTTPS endpoints (OTP, account lookup, provider
 * sign-in). App Check keeps scripts out; this bounds what a genuine app — or a token that
 * leaked out of one — can do per address. Fixed windows in Firestore (`rateLimits/{key}`),
 * so the count survives across function instances; a stale window resets on the next hit.
 */
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { createHash } from "crypto";
import { clientIp } from "./appCheck";

export interface RateLimit {
  /** Hits allowed per window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Counts one hit for [bucket] + the caller's IP; true when within [limit]. On false a 429 has
 * already been written. Fails open (true) if Firestore itself errors, so an outage never
 * locks every user out of sign-in.
 */
export async function limitByIp(req: Request, res: Response, bucket: string, limit: RateLimit): Promise<boolean> {
  const ip = clientIp(req);
  const key = createHash("sha256").update(`${bucket}:${ip}`).digest("hex").slice(0, 40);
  const ref = getFirestore().collection("rateLimits").doc(key);
  try {
    const allowed = await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Timestamp.now();
      const data = snap.data();
      const windowStart = data?.windowStart as Timestamp | undefined;
      const fresh = !windowStart || now.seconds - windowStart.seconds >= limit.windowSeconds;
      const count = fresh ? 0 : Number(data?.count ?? 0);
      if (count >= limit.max) return false;
      tx.set(ref, {
        bucket,
        count: fresh ? 1 : FieldValue.increment(1),
        windowStart: fresh ? now : windowStart,
        // TTL field: enable a Firestore TTL policy on `expiresAt` to purge old buckets.
        expiresAt: Timestamp.fromMillis(now.toMillis() + limit.windowSeconds * 2 * 1000),
      }, { merge: true });
      return true;
    });
    if (!allowed) {
      logger.warn(`${bucket}: rate-limited ip=${ip}`);
      res.status(429).json({ error: "rate-limited" });
    }
    return allowed;
  } catch (e) {
    logger.error(`${bucket}: rate limit check failed, allowing`, (e as Error).message);
    return true;
  }
}
