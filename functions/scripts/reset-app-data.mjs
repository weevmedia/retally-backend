#!/usr/bin/env node
/**
 * Wipes ReTally USER data so you can start fresh. PERMANENT — there is no undo.
 *
 *   node scripts/reset-app-data.mjs                         # preview only: counts what would go
 *   node scripts/reset-app-data.mjs --confirm retally-c5212 # actually delete
 *
 * Options:
 *   --keep-users     delete receipts & derived data but keep every login account
 *   --user <email|uid>  only this one user (repeatable)
 *
 * DELETES (for every non-admin user, or only --user ones):
 *   - Firestore users/{uid} and everything under it (receipts, lineItems, purchasePatterns, insights)
 *   - Firestore accounts/{uid}, shoppingListJobs/{uid}
 *   - Storage   users/{uid}/…  (receipt photos)
 *   - Firebase Auth account (unless --keep-users)
 *
 * KEEPS: admin accounts (and their own data), store_icons + store-icons/ logos, config/
 *   (categories), merchants, products, recalls, _schema, adminAudit.
 *
 * Phones still hold their receipts locally and may upload them again on the next sync.
 * For a true clean slate, uninstall the app (or clear its data) on test devices too.
 *
 * Needs the same credentials as set-admin.mjs (gcloud auth application-default login).
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const PROJECT_ID = "retally-c5212";
const BUCKET = "retally-c5212.firebasestorage.app";
const PER_USER_DOCS = ["accounts", "shoppingListJobs"];

const args = process.argv.slice(2);
const confirmIdx = args.indexOf("--confirm");
const CONFIRMED = confirmIdx >= 0 && args[confirmIdx + 1] === PROJECT_ID;
const KEEP_USERS = args.includes("--keep-users");
const ONLY = args.flatMap((a, i) => (a === "--user" && args[i + 1] ? [args[i + 1]] : []));
if (confirmIdx >= 0 && !CONFIRMED) {
  console.error(`To delete, pass exactly: --confirm ${PROJECT_ID}`);
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID, storageBucket: BUCKET });
const auth = getAuth();
const db = getFirestore();
const bucket = getStorage().bucket();

// ---------- who ----------
const admins = new Set();
const authUsers = new Map(); // uid -> label
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  for (const u of page.users) {
    if (u.customClaims?.admin === true) admins.add(u.uid);
    authUsers.set(u.uid, u.email ?? `guest ${u.uid.slice(0, 8)}`);
  }
  pageToken = page.pageToken;
} while (pageToken);

// Profile docs can exist without an Auth account (deleted accounts, old guests) — include them.
const profileUids = (await db.collection("users").listDocuments()).map((d) => d.id);
let targets = [...new Set([...authUsers.keys(), ...profileUids])].filter((uid) => !admins.has(uid));

if (ONLY.length) {
  const wanted = new Set();
  for (const who of ONLY) {
    if (who.includes("@")) {
      try { wanted.add((await auth.getUserByEmail(who.toLowerCase())).uid); }
      catch { console.error(`No account for ${who}`); process.exit(1); }
    } else wanted.add(who);
  }
  for (const uid of wanted) if (admins.has(uid)) { console.error(`${authUsers.get(uid)} is an admin — refusing.`); process.exit(1); }
  targets = targets.filter((uid) => wanted.has(uid));
}

// ---------- count ----------
let receipts = 0;
let photos = 0;
for (const uid of targets) {
  receipts += (await db.collection(`users/${uid}/receipts`).count().get()).data().count;
  const [files] = await bucket.getFiles({ prefix: `users/${uid}/` });
  photos += files.length;
}
const authToDelete = KEEP_USERS ? [] : targets.filter((uid) => authUsers.has(uid));

console.log(`
Project ${PROJECT_ID}${CONFIRMED ? "" : "  — PREVIEW (nothing will be deleted)"}
  Users affected:        ${targets.length}   (admins kept: ${admins.size})
  Receipts:              ${receipts}  (+ their line items, patterns, insights)
  Storage files:         ${photos}
  Login accounts:        ${KEEP_USERS ? "kept (--keep-users)" : authToDelete.length}
`);
for (const uid of targets.slice(0, 20)) console.log(`  - ${authUsers.get(uid) ?? "(no login) " + uid}`);
if (targets.length > 20) console.log(`  … and ${targets.length - 20} more`);

if (!CONFIRMED) {
  console.log(`\nRun again with  --confirm ${PROJECT_ID}  to delete permanently.`);
  process.exit(0);
}
if (targets.length === 0) {
  console.log("Nothing to delete.");
  process.exit(0);
}

// ---------- delete ----------
console.log("\nDeleting…");
let done = 0;
for (const uid of targets) {
  await db.recursiveDelete(db.doc(`users/${uid}`)); // the profile and every subcollection
  for (const col of PER_USER_DOCS) await db.doc(`${col}/${uid}`).delete().catch(() => {});
  await bucket.deleteFiles({ prefix: `users/${uid}/` }).catch(() => {});
  done++;
  if (done % 10 === 0 || done === targets.length) console.log(`  data: ${done}/${targets.length} users`);
}
for (let i = 0; i < authToDelete.length; i += 1000) {
  const res = await auth.deleteUsers(authToDelete.slice(i, i + 1000));
  console.log(`  logins: deleted ${res.successCount}${res.failureCount ? `, failed ${res.failureCount}` : ""}`);
}
await db.collection("adminAudit").add({
  action: "data.reset", target: ONLY.length ? ONLY.join(",") : "all-non-admin-users",
  before: { users: targets.length, receipts, files: photos }, after: null,
  by: "reset-app-data script", byUid: null, at: new Date(),
});
console.log("\nDone. Remember to clear the app's data on test phones, or they'll re-sync their local receipts.");
