#!/usr/bin/env node
/**
 * Wipes ReTally USER data so you can start fresh (e.g. before launch). PERMANENT, no undo.
 *
 *   node scripts/reset-app-data.mjs                         # preview only: counts what would go
 *   node scripts/reset-app-data.mjs --confirm retally-c5212 # actually delete
 *
 * Options:
 *   --keep-users           delete receipts & derived data but keep every login account
 *   --user <email|uid>     only this one user (repeatable)
 *   --include-admin-data   also wipe admins' receipts & app data (their login and console
 *                          access are always kept)
 *   --reset-stores         also delete the "new" store placeholders test receipts created
 *                          (no logo yet) and zero every store's receipt stats
 *   --keep <email|uid>     never touch this account: login and data (repeatable). The
 *                          store-review and owner accounts in ALWAYS_KEEP are always kept.
 *
 * DELETES (for every non-admin user, or only --user ones):
 *   - Firestore users/{uid} and everything under it (receipts, lineItems, devices,
 *     purchasePatterns, insights)
 *   - Firestore accounts/{uid}, shoppingListJobs/{uid}, deviceOwners entries pointing at them
 *   - Storage   users/{uid}/…  (receipt photos)
 *   - Firebase Auth account (unless --keep-users)
 * On a full run (no --user) also clears the short-lived otpCodes and rateLimits collections.
 *
 * KEEPS: admin accounts (and their data unless --include-admin-data), store_icons + logos
 *   (unless --reset-stores), config/ (categories, app config, version gate), itemAliases (the
 *   shared AI category cache: no personal data, saves Gemini calls), merchants, products,
 *   _schema, adminAudit.
 *
 * Phones still hold their receipts locally and may upload them again on the next sync.
 * For a true clean slate, uninstall the app (or clear its data) on test devices too.
 *
 * Needs the same credentials as set-admin.mjs (gcloud auth application-default login).
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const PROJECT_ID = "retally-c5212";
const BUCKET = "retally-c5212.firebasestorage.app";
const PER_USER_DOCS = ["accounts", "shoppingListJobs"];
/**
 * Accounts that are never deleted, login or data: the Play / App Store review account (its
 * sign-in details are in Play Console) and the owner account.
 */
const ALWAYS_KEEP = ["review@weevmedia.com", "retallyadmin@gmail.com"];
/** Short-lived, function-only collections with nothing worth keeping. */
const TRANSIENT = ["otpCodes", "rateLimits"];

const args = process.argv.slice(2);
const confirmIdx = args.indexOf("--confirm");
const CONFIRMED = confirmIdx >= 0 && args[confirmIdx + 1] === PROJECT_ID;
const KEEP_USERS = args.includes("--keep-users");
const INCLUDE_ADMIN_DATA = args.includes("--include-admin-data");
const RESET_STORES = args.includes("--reset-stores");
const ONLY = args.flatMap((a, i) => (a === "--user" && args[i + 1] ? [args[i + 1]] : []));
const KEEP = [...ALWAYS_KEEP, ...args.flatMap((a, i) => (a === "--keep" && args[i + 1] ? [args[i + 1]] : []))];
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

// Protected accounts: skipped entirely. A missing one (e.g. review account not created yet) is fine.
const kept = new Map(); // uid -> label
for (const who of KEEP) {
  if (who.includes("@")) {
    const u = await auth.getUserByEmail(who.toLowerCase()).catch(() => null);
    if (u) kept.set(u.uid, who.toLowerCase());
  } else kept.set(who, authUsers.get(who) ?? who);
}

// Profile docs can exist without an Auth account (deleted accounts, old guests): include them.
const profileUids = (await db.collection("users").listDocuments()).map((d) => d.id);
let targets = [...new Set([...authUsers.keys(), ...profileUids])]
  .filter((uid) => !kept.has(uid))
  .filter((uid) => INCLUDE_ADMIN_DATA || !admins.has(uid));

if (ONLY.length) {
  const wanted = new Set();
  for (const who of ONLY) {
    if (who.includes("@")) {
      try { wanted.add((await auth.getUserByEmail(who.toLowerCase())).uid); }
      catch { console.error(`No account for ${who}`); process.exit(1); }
    } else wanted.add(who);
  }
  if (!INCLUDE_ADMIN_DATA) {
    for (const uid of wanted) if (admins.has(uid)) { console.error(`${authUsers.get(uid)} is an admin. Add --include-admin-data to wipe its data.`); process.exit(1); }
  }
  targets = targets.filter((uid) => wanted.has(uid));
}
const targetSet = new Set(targets);

// ---------- count ----------
let receipts = 0;
let photos = 0;
for (const uid of targets) {
  receipts += (await db.collection(`users/${uid}/receipts`).count().get()).data().count;
  const [files] = await bucket.getFiles({ prefix: `users/${uid}/` });
  photos += files.length;
}
// Admins never lose their login, even with --include-admin-data.
const authToDelete = KEEP_USERS ? [] : targets.filter((uid) => authUsers.has(uid) && !admins.has(uid));
const ownerDocs = (await db.collection("deviceOwners").get()).docs.filter((d) => targetSet.has(d.get("uid")));
const transientCounts = ONLY.length ? {} : Object.fromEntries(
  await Promise.all(TRANSIENT.map(async (c) => [c, (await db.collection(c).count().get()).data().count])),
);
const stores = RESET_STORES ? (await db.collection("store_icons").get()).docs : [];
const placeholders = stores.filter((d) => d.get("status") === "new" && !d.get("iconUrl"));

console.log(`
Project ${PROJECT_ID}${CONFIRMED ? "" : "  (PREVIEW: nothing will be deleted)"}
  Users affected:        ${targets.length}   (admins: ${admins.size}, ${INCLUDE_ADMIN_DATA ? "their DATA included, logins kept" : "skipped"})
  Protected (untouched): ${[...kept.values()].join(", ") || "none found"}
  Receipts:              ${receipts}  (+ their line items, devices, patterns, insights)
  Storage files:         ${photos}
  Login accounts:        ${KEEP_USERS ? "kept (--keep-users)" : authToDelete.length}
  Device owner entries:  ${ownerDocs.length}
${ONLY.length ? "" : TRANSIENT.map((c) => `  ${(c + ":").padEnd(22)} ${transientCounts[c]}\n`).join("")}${RESET_STORES ? `  Store placeholders:    ${placeholders.length} deleted, stats zeroed on ${stores.length - placeholders.length}\n` : ""}`);
for (const uid of targets.slice(0, 20)) console.log(`  - ${authUsers.get(uid) ?? "(no login) " + uid}${admins.has(uid) ? "  [admin: data only]" : ""}`);
if (targets.length > 20) console.log(`  … and ${targets.length - 20} more`);

if (!CONFIRMED) {
  console.log(`\nRun again with  --confirm ${PROJECT_ID}  to delete permanently.`);
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
for (const d of ownerDocs) await d.ref.delete();
if (ownerDocs.length) console.log(`  device owners: ${ownerDocs.length}`);
for (let i = 0; i < authToDelete.length; i += 1000) {
  // Also fires onUserDeleted, which repeats the cleanup above (every step is idempotent).
  const res = await auth.deleteUsers(authToDelete.slice(i, i + 1000));
  console.log(`  logins: deleted ${res.successCount}${res.failureCount ? `, failed ${res.failureCount}` : ""}`);
}
if (!ONLY.length) {
  for (const c of TRANSIENT) await db.recursiveDelete(db.collection(c));
  console.log(`  cleared ${TRANSIENT.join(", ")}`);
}
if (RESET_STORES) {
  for (const d of placeholders) await d.ref.delete();
  const keep = stores.filter((d) => !placeholders.includes(d));
  for (const d of keep) await d.ref.set({ stats: { receiptCount: 0, lastSeenAt: FieldValue.delete() } }, { merge: true });
  console.log(`  stores: ${placeholders.length} placeholders deleted, ${keep.length} stats reset`);
}
await db.collection("adminAudit").add({
  action: "data.reset", target: ONLY.length ? ONLY.join(",") : "all-users",
  before: { users: targets.length, receipts, files: photos, adminData: INCLUDE_ADMIN_DATA, stores: RESET_STORES },
  after: null, by: "reset-app-data script", byUid: null, at: new Date(),
});
console.log("\nDone. Clear the app's data (or uninstall) on test phones, or they'll re-sync their local receipts.");
