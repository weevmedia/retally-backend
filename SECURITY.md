# ReTally backend security

How calls into the backend are protected, and the one-time console setup App Check needs.

## Layers

| Layer | What it stops | Where |
|---|---|---|
| **App Check** (Play Integrity / App Attest / reCAPTCHA Enterprise) | Scripts, curl, bots, repackaged apps — anything that isn't a genuine ReTally build or the admin site | Every `onCall` (`enforceAppCheck: true`), every `onRequest` (`requireAppCheck`), Firestore + Storage (console enforcement) |
| **Firebase Auth ID token** | Acting as another user | Signed-in endpoints, security rules (`isOwner`) |
| **`admin` custom claim** | Non-admins reaching console functions / admin rules | `requireAdmin`, `isAdmin()` in rules |
| **No guests on paid features** | Free anonymous accounts burning Gemini | `parseTornReceipt`, `getShoppingList`, `getNudges`, `categorizeItems` |
| **Rate limits** | A genuine app (or leaked token) hammering an endpoint | Per-email OTP limits + per-IP buckets (`rateLimits/` in Firestore) on `lookupAccount`, `requestOtp`, `verifyOtp`, `signInWithProvider`, `parseTornReceipt` |
| **Input caps** | Oversized payloads | `MAX_IMAGE_BASE64_CHARS` (6 MB) on Gemini |
| **Secrets in Secret Manager** | Keys in the app or repo | `GEMINI_API_KEY`, `RESEND_API_KEY`, `OTP_PEPPER` |

Nothing is "100 %": App Check raises the bar from "anyone with curl" to "someone who defeats
Google's device attestation", and the rate limits + billing caps bound what even that costs.

## One-time setup (Firebase console → App Check)

1. **Register the apps**
   - Android app → **Play Integrity**. Needs the app's SHA-256 signing certificates in
     Project settings → the Android app (upload key *and* the Play App Signing key from the
     Play Console → App integrity).
   - iOS app → **App Attest** (Team ID is read from the Apple developer account linked in
     Project settings). Keep **DeviceCheck** as the fallback provider for iOS < 14 if offered.
   - Web app ("ReTally Admin") → **reCAPTCHA Enterprise**: create a key in Google Cloud →
     reCAPTCHA Enterprise (score-based, domain `retally-c5212.web.app` + your custom domain +
     `localhost` for dev), paste the site key into the console, then into
     `retally-webapp/src/environments/*.ts` → `appCheckSiteKey`.
2. **Debug tokens** (one per developer device / simulator / browser): run a debug build once,
   copy the token it prints (Logcat / Xcode console / browser console), add it under
   *App Check → Apps → … → Manage debug tokens*. Debug builds use the debug provider
   automatically (`androidApp/src/debug`, `AppCheckSetup.swift` under `DEBUG`,
   `appCheckDebug: true` in `environment.development.ts`).
3. **Enforce on the SDKs**: App Check → APIs → **Cloud Firestore** and **Cloud Storage** →
   *Enforce*. (Functions enforce in code — see below.) Watch the "unverified requests" graph
   for a day before enforcing if the current app version in the wild predates App Check.
4. **Rate-limit TTL**: Firestore → TTL policies → collection `rateLimits`, field `expiresAt`
   (purges old buckets for free).
5. **Billing guard rails**: Google Cloud → Billing → budget alerts (e.g. $10 / $50), and a
   Gemini API quota cap on the key's project; Resend → monthly sending limit.

## Rollout order

1. Deploy the backend with `APP_CHECK_ENFORCE=false` (`firebase functions:config` param, or
   `.env` → `APP_CHECK_ENFORCE=false`) so old installs keep working.
2. Ship the App Check-enabled mobile builds; set the web site key and deploy the console.
3. When the unverified-request graph is flat, redeploy with `APP_CHECK_ENFORCE=true`
   (the default), `ENFORCE_APP_CHECK_ON_CALL = true` in `functions/src/shared/constants.ts`
   (Smart list, nudges, recalls, categories, device registration) and
   `ADMIN_ENFORCE_APP_CHECK = true` in `functions/src/admin/common.ts`. Enforce Firestore +
   Storage in the console at the same time.

## Verifying

From a terminal (no token → refused):

```sh
curl -s -X POST https://us-east1-retally-c5212.cloudfunctions.net/requestOtp \
  -H 'content-type: application/json' -d '{"email":"someone@example.com"}'
# → 401 {"error":"app-check-required"}

curl -s -X POST https://us-east1-retally-c5212.cloudfunctions.net/getShoppingList \
  -H 'content-type: application/json' -d '{"data":{}}'
# → 401 {"error":{"status":"UNAUTHENTICATED", ...}}
```

From the app: sign-in, scan with the torn-receipt fallback, Smart list and recalls all work,
and Cloud Logging shows no `App Check token missing` warnings for your device.
Hit `requestOtp` 11× within an hour from one network → the 11th returns `429 rate-limited`.
