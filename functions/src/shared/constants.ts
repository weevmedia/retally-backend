/** Shared constants across all ReTally Cloud Functions. */
export const REGION = "us-east1";

/**
 * App Check on the user-facing `onCall` functions (Smart list, nudges, recalls, categories,
 * device registration). `enforceAppCheck` is a deploy-time option, so it can't follow the
 * APP_CHECK_ENFORCE runtime param. Kept on: a call without a valid token is refused with
 * `unauthenticated`, so every build that talks to these must carry App Check (dev builds via a
 * registered debug token — see SECURITY.md).
 */
export const ENFORCE_APP_CHECK_ON_CALL = true;
