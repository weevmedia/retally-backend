/**
 * Account deletion cleanup.
 *
 * When a Firebase Auth user is deleted, from the app (More → Account → Delete account), from the
 * Firebase console, or by an admin acting on an emailed request, this removes everything stored
 * for that user so "delete account" really deletes the account's data:
 *
 *   - Firestore `users/{uid}` and every subcollection (receipts, lineItems, devices,
 *     purchasePatterns, insights)
 *   - Firestore `accounts/{uid}`
 *   - Cloud Storage `users/{uid}/` (receipt photos)
 *   - `deviceOwners` entries that point at the user
 *   - the user's pending email code in `otpCodes`, if one is left over
 *
 * Shared, non-personal data stays: catalogs (merchants, products, store_icons, config), per-IP
 * rate-limit counters, and the admin audit log.
 *
 * Firebase Functions v2 has no "user deleted" trigger, so this uses the v1 Auth trigger. Every
 * step is idempotent, so a retry or a manual re-run is safe.
 *
 * The app deletes accounts through [deleteAccount] rather than the client SDK: the client SDK
 * refuses unless the user signed in recently, while the Admin SDK can always delete the caller's
 * own account. Deleting the Auth user then fires [onUserDeleted].
 */
import * as functionsV1 from "firebase-functions/v1";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { ENFORCE_APP_CHECK_ON_CALL, REGION } from "../shared/constants";
import { sha256 } from "../shared/crypto";
import { DEVICE_OWNERS } from "../devices";

/**
 * Deletes the caller's own account (More → Account → Delete account). Needs a signed-in caller
 * and App Check; no recent sign-in is required. Deleting the Auth user fires [onUserDeleted],
 * which removes the user's data.
 */
export const deleteAccount = onCall(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK_ON_CALL },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const uid = request.auth.uid;
    try {
      await getAuth().deleteUser(uid);
    } catch (e) {
      // Already gone (a retried request): the cleanup has run or is running.
      if ((e as { code?: string }).code !== "auth/user-not-found") {
        logger.error("deleteAccount: deleteUser failed", { uid, error: (e as Error).message });
        throw new HttpsError("internal", "Could not delete the account. Try again.");
      }
    }
    logger.info("deleteAccount: user deleted", { uid });
    return { ok: true };
  },
);

export const onUserDeleted = functionsV1
  .region(REGION)
  .auth.user()
  .onDelete(async (user) => {
    const uid = user.uid;
    const db = getFirestore();

    // Firestore: the user document with all of its subcollections, and the functions-only account doc.
    await db.recursiveDelete(db.doc(`users/${uid}`));
    await db.recursiveDelete(db.doc(`accounts/${uid}`));

    // A leftover sign-in code is keyed by a hash of the email, not the uid.
    const email = (user.email ?? "").trim().toLowerCase();
    if (email) {
      await db.collection("otpCodes").doc(sha256(`otp:${email}`)).delete();
    }

    // Device ownership records that point at this user.
    const owners = await db.collection(DEVICE_OWNERS).where("uid", "==", uid).get();
    await Promise.all(owners.docs.map((d) => d.ref.delete()));

    // Storage: receipt photos live under users/{uid}/.
    await getStorage().bucket().deleteFiles({ prefix: `users/${uid}/`, force: true });

    logger.info("onUserDeleted: removed user data", { uid });
  });
