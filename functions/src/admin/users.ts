/**
 * Admin console: app users and admin users (Firebase Auth).
 *
 *  - adminListUsers: every Auth account, with its admin flag, sign-in providers, last activity and
 *    receipt stats from `users/{uid}`. The console splits them into "App users" and "Admins".
 *  - adminSetUserDisabled: enable / disable an account. Disabling also revokes its refresh tokens,
 *    so the mobile app and the console are signed out within the hour.
 *  - adminSetAdmin: grant / revoke console access (the `admin` custom claim).
 *  - adminInviteAdmin: make an email an admin, creating the account if needed and returning a
 *    set-password link to share with them.
 *
 * Guard rails: you can't disable or demote yourself, and the last enabled admin can't be removed.
 * Every change is written to `/adminAudit`.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getAuth, UserRecord } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { Admin, audit, requireAdmin } from "./common";

const MAX_USERS = 10000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface UserDto {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoUrl: string | null;
  providers: string[];
  anonymous: boolean;
  disabled: boolean;
  isAdmin: boolean;
  emailVerified: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
  receiptCount: number | null;
  lastReceiptAt: string | null;
}

function isoOf(v: string | undefined | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toDto(u: UserRecord): UserDto {
  const providers = u.providerData.map((p) => p.providerId);
  return {
    uid: u.uid,
    email: u.email ?? null,
    displayName: u.displayName ?? null,
    photoUrl: u.photoURL ?? null,
    providers,
    // A guest has no provider and no email; an invited admin who hasn't set a password yet has an email.
    anonymous: providers.length === 0 && !u.email,
    disabled: u.disabled,
    isAdmin: u.customClaims?.admin === true,
    emailVerified: u.emailVerified,
    createdAt: isoOf(u.metadata.creationTime),
    lastSignInAt: isoOf(u.metadata.lastSignInTime),
    lastActiveAt: isoOf(u.metadata.lastRefreshTime ?? u.metadata.lastSignInTime),
    receiptCount: null,
    lastReceiptAt: null,
  };
}

function uidOf(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 128 || v.includes("/")) {
    throw new HttpsError("invalid-argument", "uid is required.");
  }
  return v.trim();
}

async function getUserOr404(uid: string): Promise<UserRecord> {
  try {
    return await getAuth().getUser(uid);
  } catch {
    throw new HttpsError("not-found", "That account no longer exists.");
  }
}

/** Enabled admins other than [exceptUid] — used to never remove the last one. */
async function otherEnabledAdmins(exceptUid: string): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    for (const u of page.users) {
      if (u.uid !== exceptUid && !u.disabled && u.customClaims?.admin === true) count++;
    }
    pageToken = page.pageToken;
  } while (pageToken && count === 0);
  return count;
}

function snapshot(u: UserRecord) {
  return { email: u.email ?? null, disabled: u.disabled, admin: u.customClaims?.admin === true };
}

// ---------- list ----------

export const adminListUsers = onCall({ region: REGION, memory: "512MiB", timeoutSeconds: 60 }, async (request) => {
  await requireAdmin(request);

  const users: UserDto[] = [];
  let pageToken: string | undefined;
  let truncated = false;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    users.push(...page.users.map(toDto));
    pageToken = page.pageToken;
    if (users.length >= MAX_USERS) {
      truncated = Boolean(pageToken);
      break;
    }
  } while (pageToken);

  // Receipt stats from the profile docs (maintained by the app / functions; may be missing).
  const db = getFirestore();
  for (let i = 0; i < users.length; i += 300) {
    const batch = users.slice(i, i + 300);
    const snaps = await db.getAll(...batch.map((u) => db.doc(`users/${u.uid}`)), { fieldMask: ["stats"] });
    snaps.forEach((snap, j) => {
      const stats = snap.exists ? (snap.get("stats") as Record<string, unknown> | undefined) : undefined;
      if (!stats) return;
      if (typeof stats.receiptCount === "number") batch[j].receiptCount = stats.receiptCount;
      const last = stats.lastReceiptAt as { toDate?: () => Date } | undefined;
      if (last && typeof last.toDate === "function") batch[j].lastReceiptAt = last.toDate().toISOString();
    });
  }

  return { users, truncated, you: request.auth!.uid };
});

// ---------- enable / disable ----------

export const adminSetUserDisabled = onCall({ region: REGION }, async (request) => {
  const admin = await requireAdmin(request);
  const d = (request.data ?? {}) as Record<string, unknown>;
  const uid = uidOf(d.uid);
  if (typeof d.disabled !== "boolean") throw new HttpsError("invalid-argument", "disabled must be true or false.");
  const disabled = d.disabled;

  if (uid === admin.uid && disabled) throw new HttpsError("failed-precondition", "You can't disable your own account.");
  const before = await getUserOr404(uid);
  if (disabled && before.customClaims?.admin === true && !before.disabled && (await otherEnabledAdmins(uid)) === 0) {
    throw new HttpsError("failed-precondition", "This is the last enabled admin. Add another admin first.");
  }

  const after = await getAuth().updateUser(uid, { disabled });
  if (disabled) await getAuth().revokeRefreshTokens(uid); // sign them out everywhere
  await audit(admin, disabled ? "user.disable" : "user.enable", `auth/${uid}`, snapshot(before), snapshot(after));
  return { ok: true, user: toDto(after) };
});

// ---------- admin access ----------

async function setAdminClaim(admin: Admin, user: UserRecord, makeAdmin: boolean): Promise<UserRecord> {
  if (!makeAdmin) {
    if (user.uid === admin.uid) throw new HttpsError("failed-precondition", "You can't remove your own admin access.");
    if (!user.disabled && (await otherEnabledAdmins(user.uid)) === 0) {
      throw new HttpsError("failed-precondition", "This is the last enabled admin. Add another admin first.");
    }
  }
  const claims = { ...(user.customClaims ?? {}) };
  if (makeAdmin) claims.admin = true;
  else delete claims.admin;
  await getAuth().setCustomUserClaims(user.uid, claims);
  if (!makeAdmin) await getAuth().revokeRefreshTokens(user.uid); // console session ends within the hour
  const after = await getAuth().getUser(user.uid);
  await audit(admin, makeAdmin ? "admin.grant" : "admin.revoke", `auth/${user.uid}`, snapshot(user), snapshot(after));
  return after;
}

export const adminSetAdmin = onCall({ region: REGION }, async (request) => {
  const admin = await requireAdmin(request);
  const d = (request.data ?? {}) as Record<string, unknown>;
  if (typeof d.admin !== "boolean") throw new HttpsError("invalid-argument", "admin must be true or false.");
  const user = await getUserOr404(uidOf(d.uid));
  if (d.admin && user.providerData.length === 0 && !user.email) {
    throw new HttpsError("failed-precondition", "Guest (anonymous) accounts can't be admins.");
  }
  const after = await setAdminClaim(admin, user, d.admin);
  return { ok: true, user: toDto(after) };
});

/**
 * Makes [email] an admin. Existing account → grant. No account → create one (email/password, no
 * password yet) and return a link where they set their password. The link is returned, not emailed:
 * share it with the person yourself.
 */
export const adminInviteAdmin = onCall({ region: REGION }, async (request) => {
  const admin = await requireAdmin(request);
  const raw = (request.data as Record<string, unknown> | undefined)?.email;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpsError("invalid-argument", "Enter a valid email address.");

  let user: UserRecord;
  let created = false;
  try {
    user = await getAuth().getUserByEmail(email);
  } catch {
    user = await getAuth().createUser({ email, emailVerified: false, disabled: false });
    created = true;
    await audit(admin, "user.create", `auth/${user.uid}`, null, snapshot(user));
  }
  if (user.customClaims?.admin === true && !user.disabled) {
    throw new HttpsError("already-exists", `${email} is already an admin.`);
  }
  if (user.disabled) user = await getAuth().updateUser(user.uid, { disabled: false });
  const after = await setAdminClaim(admin, user, true);

  // A set-password link: needed for new accounts, handy for existing email/password ones.
  const hasPassword = after.providerData.some((p) => p.providerId === "password");
  let passwordLink: string | null = null;
  if (created || hasPassword) {
    try {
      passwordLink = await getAuth().generatePasswordResetLink(email);
    } catch {
      passwordLink = null; // Email/Password provider disabled — they can still use Google sign-in
    }
  }
  return { ok: true, created, passwordLink, user: toDto(after) };
});
