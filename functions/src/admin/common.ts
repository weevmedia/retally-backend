/** Shared by every admin callable: the admin-claim gate, the audit log and input helpers. */
import { CallableRequest, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const AUDIT = "adminAudit";

export interface Admin {
  uid: string;
  email: string;
}

/**
 * Gate for every admin callable. Checks the token's `admin` claim AND the live account: an admin
 * who was disabled or demoted keeps a valid ID token for up to an hour, so the claim alone isn't
 * enough. One Auth lookup per call.
 */
export async function requireAdmin(request: CallableRequest<unknown>): Promise<Admin> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const deny = (why: string): never => {
    logger.warn(`admin call denied uid=${request.auth?.uid}: ${why}`);
    throw new HttpsError("permission-denied", "Admin access required.");
  };
  if (request.auth.token.admin !== true) deny("no admin claim on token");
  const user = await getAuth().getUser(request.auth.uid).catch(() => null);
  if (!user) deny("account not found");
  if (user!.disabled) deny("account disabled");
  if (user!.customClaims?.admin !== true) deny("admin claim revoked");
  return { uid: request.auth.uid, email: String(user!.email ?? request.auth.token.email ?? request.auth.uid) };
}

export async function audit(admin: Admin, action: string, target: string, before: unknown, after: unknown): Promise<void> {
  await getFirestore().collection(AUDIT).add({
    action,
    target,
    before: before ?? null,
    after: after ?? null,
    by: admin.email,
    byUid: admin.uid,
    at: FieldValue.serverTimestamp(),
  });
}

export function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v.trim().length === 0) throw new HttpsError("invalid-argument", `${field} is required.`);
  const s = v.trim();
  if (s.length > max) throw new HttpsError("invalid-argument", `${field} must be at most ${max} characters.`);
  return s;
}

