# ReTally OTP functions

Cloud Functions 2nd gen (`requestOtp` / `verifyOtp`, region `us-east1`) for project
`retally-c5212`. They email a 6-digit code via Resend and mint a Firebase custom token
on successful verification. The KMP app calls them through `HttpOtpService`.

## First-time setup

1. **Billing**: Cloud Functions 2nd gen needs the Blaze (pay-as-you-go) plan.
   Firebase console → `retally-c5212` → Upgrade. The free tier covers this usage
   (2M invocations/month free); a billing account is just required to enable it.

2. **Resend account**: sign up at https://resend.com using
   `vejimon777@pumpoly.com` as the account email. Without a verified domain,
   Resend's sandbox only delivers to the account owner's address — which is
   exactly what we want for testing. Create an API key (dashboard → API Keys).

3. **Install deps**: `cd backend/functions && npm install`

4. **Secrets** (run from `backend/firestore`, the firebase project root):
   ```
   firebase functions:secrets:set RESEND_API_KEY
   firebase functions:secrets:set OTP_PEPPER   # paste any long random string
   ```
   Generate the pepper with: `openssl rand -hex 32`

5. **Deploy** (from `backend/firestore`):
   ```
   firebase deploy --only functions
   ```
   This builds TypeScript first (predeploy hook), then deploys. Expect URLs like
   `https://us-east1-retally-c5212.cloudfunctions.net/requestOtp`.

6. **Firestore TTL** (one click in the console): Firestore → `otpCodes`
   collection → enable TTL on the `expiresAt` field, so expired codes auto-delete.
   (The functions also check expiry themselves; TTL is just hygiene.)

## Testing

1. Build the app, go to sign-in, enter `vejimon777@pumpoly.com`, CONTINUE.
2. The code lands in that inbox (check spam on the first send).
3. Enter the code → you land in Home signed in as a real (non-anonymous)
   Firebase user. Wrong codes show the red mismatch state; expired codes ask
   for a resend.

## Later: custom domain

Verify the domain in Resend (paste its SPF/DKIM records into Cloudflare DNS),
then change `FROM_ADDRESS` in `src/index.ts` from `onboarding@resend.dev` to
`ReTally <noreply@yourdomain.com>` and redeploy. No app changes needed.

## API

- `POST /requestOtp` `{ email }` → `200 { ok: true }` · `429 { error: "rate-limited" }`
  (3 requests/hour per email; code valid 10 minutes)
- `POST /verifyOtp` `{ email, code }` → `200 { customToken }` · `401 mismatch` ·
  `410 expired` · `429 too-many-attempts` (5 tries burn the code) · `404 no-code`
