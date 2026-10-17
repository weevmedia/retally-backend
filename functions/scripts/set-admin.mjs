#!/usr/bin/env node
/**
 * Grants or revokes ReTally admin-console access (the `admin` custom claim).
 *
 *   gcloud auth application-default login          # once, with a project owner account
 *   node scripts/set-admin.mjs you@example.com     # grant
 *   node scripts/set-admin.mjs you@example.com --revoke
 *
 * The person must have signed in to the console once so the account exists. Then they click
 * "Check again" on the console's sign-in page (claims refresh with a new ID token).
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error("Usage: node scripts/set-admin.mjs <email> [--revoke]");
  process.exit(1);
}
initializeApp({ credential: applicationDefault(), projectId: "retally-c5212" });

const auth = getAuth();
const user = await auth.getUserByEmail(email);
const claims = { ...(user.customClaims ?? {}) };
if (flag === "--revoke") delete claims.admin;
else claims.admin = true;
await auth.setCustomUserClaims(user.uid, claims);
console.log(`${flag === "--revoke" ? "Revoked" : "Granted"} admin for ${email} (uid ${user.uid}).`);
