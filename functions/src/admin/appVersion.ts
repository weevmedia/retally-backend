/**
 * App version gate (`config/appVersion`): what the console sets when a build goes live, and
 * what every install reads at launch to decide whether to nudge or force an update.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { ADMIN_ENFORCE_APP_CHECK, audit, requireAdmin, text } from "./common";

export const APP_VERSION_DOC = "config/appVersion";
const PLATFORMS = ["android", "ios"] as const;
type Platform = (typeof PLATFORMS)[number];
const VERSION_RE = /^\d+(\.\d+){0,2}$/;

export interface PlatformVersion {
  latest: string;
  minSupported: string;
  storeUrl: string;
  message: string;
}

/** Numeric dotted compare ("1.10.0" > "1.9.0"); mirrors the app's `compareVersions`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Marketing version as the app reports it, e.g. "1.4.0 (42)" -> "1.4.0". */
function marketingVersion(reported: string): string {
  return reported.trim().split(/[\s(+-]/)[0] ?? "";
}

function versionOf(v: unknown, field: string): string {
  const s = text(v, field, 20);
  if (!VERSION_RE.test(s)) throw new HttpsError("invalid-argument", `${field} must look like 1.2.0.`);
  return s;
}

function storeUrlOf(v: unknown, platform: Platform): string {
  const url = text(v, `${platform}.storeUrl`, 2048);
  // Only the store's own domain; the exact App Store id is not known until the app is listed,
  // so iOS accepts any apps.apple.com page (a placeholder can be saved before launch).
  const ok = platform === "android"
    ? url.startsWith("https://play.google.com/store/apps/details?id=")
    : url.startsWith("https://apps.apple.com/");
  if (!ok) {
    throw new HttpsError("invalid-argument", platform === "android"
      ? "android.storeUrl must be a Play Store app page (https://play.google.com/store/apps/details?id=...)."
      : "ios.storeUrl must be an App Store page (https://apps.apple.com/...).");
  }
  return url;
}

function platformVersionOf(raw: unknown, platform: Platform): PlatformVersion {
  const r = (raw ?? {}) as Record<string, unknown>;
  const latest = versionOf(r.latest, `${platform}.latest`);
  const minSupported = versionOf(r.minSupported, `${platform}.minSupported`);
  if (compareVersions(minSupported, latest) > 0) {
    throw new HttpsError("invalid-argument", `${platform}.minSupported cannot be above ${platform}.latest.`);
  }
  // Optional: the console sends "" when the field is left empty.
  const message = typeof r.message === "string" && r.message.trim() ? text(r.message, `${platform}.message`, 160) : "";
  return { latest, minSupported, storeUrl: storeUrlOf(r.storeUrl, platform), message };
}

/**
 * Installs per platform that would be locked out by a `minSupported`: distinct devices seen in
 * the last 30 days whose reported version is below it. The console shows this before saving.
 */
async function lockedOutCounts(min: Record<Platform, string>): Promise<Record<Platform, number>> {
  const since = Date.now() - 30 * 86_400_000;
  // Unfiltered like adminListUsers (a range filter on a collection group needs its own index);
  // the device set is small and the recency cut is applied here.
  const snap = await getFirestore().collectionGroup("devices").get();
  const counts: Record<Platform, number> = { android: 0, ios: 0 };
  for (const doc of snap.docs) {
    const platform = String(doc.get("platform") ?? "") as Platform;
    if (!PLATFORMS.includes(platform)) continue;
    const lastSeen = doc.get("lastSeenAt") as { toMillis?: () => number } | undefined;
    if (!lastSeen?.toMillis || lastSeen.toMillis() < since) continue;
    const version = marketingVersion(String(doc.get("appVersion") ?? ""));
    if (VERSION_RE.test(version) && compareVersions(version, min[platform]) < 0) counts[platform] += 1;
  }
  return counts;
}

/** Current gate plus, per platform, how many recent installs sit below `minSupported`. */
export const adminGetAppVersion = onCall({ region: REGION, enforceAppCheck: ADMIN_ENFORCE_APP_CHECK }, async (request) => {
  await requireAdmin(request);
  const snap = await getFirestore().doc(APP_VERSION_DOC).get();
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const config: Record<Platform, PlatformVersion | null> = { android: null, ios: null };
  for (const p of PLATFORMS) {
    const r = (data[p] ?? null) as Record<string, unknown> | null;
    config[p] = r ? {
      latest: String(r.latest ?? ""), minSupported: String(r.minSupported ?? ""),
      storeUrl: String(r.storeUrl ?? ""), message: String(r.message ?? ""),
    } : null;
  }
  const lockedOut = await lockedOutCounts({
    android: config.android?.minSupported || "0", ios: config.ios?.minSupported || "0",
  });
  return { config, lockedOut, updatedAt: snap.get("updatedAt")?.toDate?.()?.toISOString() ?? null, updatedBy: snap.get("updatedBy") ?? null };
});

/**
 * Dry run: validates a proposed gate and reports how many installs each platform's
 * `minSupported` would lock out, so the console can confirm before `adminSetAppVersion`.
 */
export const adminPreviewAppVersion = onCall({ region: REGION, enforceAppCheck: ADMIN_ENFORCE_APP_CHECK }, async (request) => {
  await requireAdmin(request);
  const data = (request.data ?? {}) as Record<string, unknown>;
  const android = platformVersionOf(data.android, "android");
  const ios = platformVersionOf(data.ios, "ios");
  const lockedOut = await lockedOutCounts({ android: android.minSupported, ios: ios.minSupported });
  return { lockedOut };
});

/** Replaces the whole gate (both platforms) and records the change in `/adminAudit`. */
export const adminSetAppVersion = onCall({ region: REGION, enforceAppCheck: ADMIN_ENFORCE_APP_CHECK }, async (request) => {
  const admin = await requireAdmin(request);
  const data = (request.data ?? {}) as Record<string, unknown>;
  const after = { android: platformVersionOf(data.android, "android"), ios: platformVersionOf(data.ios, "ios") };
  const ref = getFirestore().doc(APP_VERSION_DOC);
  const before = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    tx.set(ref, { ...after, updatedAt: FieldValue.serverTimestamp(), updatedBy: admin.email });
    return snap.exists ? { android: snap.get("android") ?? null, ios: snap.get("ios") ?? null } : null;
  });
  await audit(admin, "appVersion.update", APP_VERSION_DOC, before, after);
  return { ok: true };
});
