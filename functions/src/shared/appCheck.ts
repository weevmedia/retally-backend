/**
 * Firebase App Check for the plain HTTPS (`onRequest`) functions.
 *
 * `onCall` functions get this for free with `enforceAppCheck: true`; these read the same
 * `X-Firebase-AppCheck` header and verify it with the Admin SDK. A token proves the call came
 * from a genuine ReTally build (Play Integrity / App Attest) or the admin site (reCAPTCHA
 * Enterprise) — a script, curl, or a repackaged app has none and is refused before any work
 * (email, Gemini, Auth lookups) is done.
 *
 * Rollout: `APP_CHECK_ENFORCE=false` logs missing/invalid tokens and lets the call through, so
 * the backend can deploy before every installed app carries a token; flip it to true once the
 * App Check–enabled apps are out (the "unverified requests" graph in the console shows when).
 */
import { getAppCheck } from "firebase-admin/app-check";
import { defineBoolean } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";

export const APP_CHECK_ENFORCE = defineBoolean("APP_CHECK_ENFORCE", {
  description: "Reject HTTPS function calls without a valid Firebase App Check token (true once the App Check apps are released)",
  default: true,
});

/** The ReTally client apps and the admin site; a token minted for another Firebase app is refused. */
const ALLOWED_APP_ID_SUFFIXES = [":android:", ":ios:", ":web:"];

/**
 * True when the request carries a valid App Check token (or enforcement is off). On false the
 * 401 has already been written — the caller just returns.
 */
export async function requireAppCheck(req: Request, res: Response, fn: string): Promise<boolean> {
  const token = String(req.header("X-Firebase-AppCheck") ?? "");
  const enforce = APP_CHECK_ENFORCE.value();
  if (!token) {
    logger.warn(`${fn}: App Check token missing (enforce=${enforce}) ip=${clientIp(req)}`);
    if (enforce) res.status(401).json({ error: "app-check-required" });
    return !enforce;
  }
  try {
    const claims = await getAppCheck().verifyToken(token);
    if (!ALLOWED_APP_ID_SUFFIXES.some((s) => claims.appId.includes(s))) {
      throw new Error(`unexpected appId ${claims.appId}`);
    }
    return true;
  } catch (e) {
    logger.warn(`${fn}: App Check token rejected (enforce=${enforce}) ip=${clientIp(req)}: ${(e as Error).message}`);
    if (enforce) res.status(401).json({ error: "app-check-invalid" });
    return !enforce;
  }
}

/** Caller IP as Cloud Functions' front end reports it (first hop of X-Forwarded-For). */
export function clientIp(req: Request): string {
  const forwarded = String(req.header("x-forwarded-for") ?? "");
  return forwarded.split(",")[0].trim() || req.ip || "unknown";
}
