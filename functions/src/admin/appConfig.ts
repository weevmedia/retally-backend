/**
 * App config (`config/app`): links and feature switches every install reads at launch, so they
 * can change without an app release. Edited only from the console through `adminSetAppConfig`.
 *
 *   links:    { howItWorks, terms, privacy, support }   "" = the app's built-in default
 *   features: { ads, recalls }                          missing = on
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { REGION } from "../shared/constants";
import { ADMIN_ENFORCE_APP_CHECK, audit, requireAdmin } from "./common";

export const APP_CONFIG_DOC = "config/app";

const LINK_KEYS = ["howItWorks", "terms", "privacy", "support"] as const;
const FEATURE_KEYS = ["ads", "recalls"] as const;
type LinkKey = (typeof LINK_KEYS)[number];
type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface AppConfig {
  links: Record<LinkKey, string>;
  features: Record<FeatureKey, boolean>;
}

/** What the app falls back to when a link is blank; shown as placeholders in the console. */
export const APP_CONFIG_DEFAULTS: AppConfig = {
  links: {
    howItWorks: "", // blank = the app's built-in How it works screen
    terms: "https://retally-c5212.web.app/terms",
    privacy: "https://retally-c5212.web.app/privacy",
    support: "https://retally-c5212.web.app/support",
  },
  features: { ads: true, recalls: true },
};

function linkOf(v: unknown, key: LinkKey): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HttpsError("invalid-argument", `links.${key} must be text.`);
  const url = v.trim();
  if (url === "") return "";
  if (url.length > 2048) throw new HttpsError("invalid-argument", `links.${key} is too long.`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpsError("invalid-argument", `links.${key} must be a full URL (https://…).`);
  }
  if (parsed.protocol !== "https:") throw new HttpsError("invalid-argument", `links.${key} must start with https://.`);
  return url;
}

function configOf(raw: unknown): AppConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const links = (r.links ?? {}) as Record<string, unknown>;
  const features = (r.features ?? {}) as Record<string, unknown>;
  const out: AppConfig = { links: { ...APP_CONFIG_DEFAULTS.links }, features: { ...APP_CONFIG_DEFAULTS.features } };
  for (const k of LINK_KEYS) out.links[k] = linkOf(links[k], k);
  for (const k of FEATURE_KEYS) {
    const v = features[k];
    if (v !== undefined && typeof v !== "boolean") throw new HttpsError("invalid-argument", `features.${k} must be true or false.`);
    out.features[k] = v !== false;
  }
  return out;
}

/** Stored doc as the app sees it: blank links, features default on. */
function storedOf(data: Record<string, unknown> | undefined): AppConfig {
  const links = (data?.links ?? {}) as Record<string, unknown>;
  const features = (data?.features ?? {}) as Record<string, unknown>;
  const out: AppConfig = { links: { howItWorks: "", terms: "", privacy: "", support: "" }, features: { ads: true, recalls: true } };
  for (const k of LINK_KEYS) out.links[k] = typeof links[k] === "string" ? String(links[k]) : "";
  for (const k of FEATURE_KEYS) out.features[k] = features[k] !== false;
  return out;
}

export const adminGetAppConfig = onCall({ region: REGION, enforceAppCheck: ADMIN_ENFORCE_APP_CHECK }, async (request) => {
  await requireAdmin(request);
  const snap = await getFirestore().doc(APP_CONFIG_DOC).get();
  return {
    config: storedOf(snap.data()),
    defaults: APP_CONFIG_DEFAULTS,
    updatedAt: snap.get("updatedAt")?.toDate?.()?.toISOString() ?? null,
    updatedBy: snap.get("updatedBy") ?? null,
  };
});

/** Replaces the whole config and records the change in `/adminAudit`. */
export const adminSetAppConfig = onCall({ region: REGION, enforceAppCheck: ADMIN_ENFORCE_APP_CHECK }, async (request) => {
  const admin = await requireAdmin(request);
  const after = configOf(request.data);
  const ref = getFirestore().doc(APP_CONFIG_DOC);
  const before = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    tx.set(ref, { ...after, updatedAt: FieldValue.serverTimestamp(), updatedBy: admin.email });
    return snap.exists ? { links: snap.get("links") ?? null, features: snap.get("features") ?? null } : null;
  });
  await audit(admin, "appConfig.update", APP_CONFIG_DOC, before, after);
  return { ok: true };
});
