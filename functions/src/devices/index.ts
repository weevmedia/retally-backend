/**
 * Device list per user: `users/{uid}/devices/{installationId}`.
 *
 * The app calls `registerDevice` after sign-in (guests too) and at most once a day after that.
 * One install belongs to one account at a time: `deviceOwners/{installationId}` remembers the
 * current owner, so when someone signs into another account on the same phone the device moves
 * (the old account's entry is deleted). A reinstall gets a new installationId and shows up as a
 * new device; old entries just stop updating `lastSeenAt`.
 *
 * Written only here (Admin SDK); clients can read their own list, admins read everyone's through
 * adminListUsers.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PLATFORMS = ["android", "ios"];

export const DEVICES = "devices";
export const DEVICE_OWNERS = "deviceOwners";

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpsError("invalid-argument", `${field} is required.`);
  return v.trim().slice(0, max);
}

export const registerDevice = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = request.auth.uid;
  const d = (request.data ?? {}) as Record<string, unknown>;
  const installationId = str(d.installationId, "installationId", 64);
  if (!ID_RE.test(installationId)) throw new HttpsError("invalid-argument", "Bad installationId.");
  const platform = str(d.platform, "platform", 16).toLowerCase();
  if (!PLATFORMS.includes(platform)) throw new HttpsError("invalid-argument", "Unknown platform.");
  const info = {
    uid,
    installationId,
    platform,
    model: str(d.model ?? "unknown", "model", 80),
    osVersion: str(d.osVersion ?? "unknown", "osVersion", 40),
    appVersion: str(d.appVersion ?? "unknown", "appVersion", 40),
  };

  const db = getFirestore();
  const ownerRef = db.collection(DEVICE_OWNERS).doc(installationId);
  const deviceRef = db.doc(`users/${uid}/${DEVICES}/${installationId}`);
  await db.runTransaction(async (tx) => {
    const [owner, device] = await Promise.all([tx.get(ownerRef), tx.get(deviceRef)]);
    const previousUid = owner.exists ? (owner.get("uid") as string | undefined) : undefined;
    if (previousUid && previousUid !== uid) {
      // Same phone, different account: the device now belongs to the new one only.
      tx.delete(db.doc(`users/${previousUid}/${DEVICES}/${installationId}`));
    }
    tx.set(ownerRef, { uid, updatedAt: FieldValue.serverTimestamp() });
    tx.set(deviceRef, {
      ...info,
      lastSeenAt: FieldValue.serverTimestamp(),
      ...(device.exists ? {} : { firstSeenAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
  });
  return { ok: true };
});
