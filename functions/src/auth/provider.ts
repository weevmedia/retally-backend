/**
 * Sign in with Apple (iOS) and Google (Android and iOS).
 *
 *   POST /signInWithProvider { provider: "apple" | "google", idToken, nonce?, displayName? }
 *     -> 200 { customToken, isNewUser, firstName }
 *     -> 400 invalid-request | 401 invalid-token | 422 no-email
 *
 * The app gets an ID token from the platform (Apple's identity token / Google's ID token via
 * Credential Manager) and sends it here. We verify it, read the (verified) email, and mint a
 * Firebase custom token for the SAME per-email account the email-code sign-in uses — so a
 * shopper who signs in with Google one day and an email code the next lands in one account
 * with one set of receipts. Nothing extra to link or migrate.
 *
 * Config (set once; `firebase deploy` prompts for missing values):
 *   GOOGLE_WEB_CLIENT_IDS - every Google OAuth client ID a token may be issued to, comma-separated:
 *                           the "Web client" ID (Android asks for tokens with it) AND the iOS
 *                           client ID (CLIENT_ID in GoogleService-Info.plist; iOS signs in with it).
 */
import { onRequest } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getAuth } from "firebase-admin/auth";
import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash } from "crypto";
import { REGION } from "../shared/constants";

const GOOGLE_WEB_CLIENT_IDS = defineString("GOOGLE_WEB_CLIENT_IDS", {
  description: "Google OAuth client IDs accepted as token audience (Web client ID for Android, iOS client ID), comma-separated",
});

/** iOS bundle ids allowed as the Apple identity token's audience (release + debug). */
const APPLE_AUDIENCES = ["com.weevmedia.retally", "com.weevmedia.retally.debug"];
const APPLE_ISSUER = "https://appleid.apple.com";
const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const googleClient = new OAuth2Client();

interface VerifiedIdentity {
  email: string;
  emailVerified: boolean;
  name: string | null;
}

async function verifyGoogle(idToken: string): Promise<VerifiedIdentity> {
  const audience = GOOGLE_WEB_CLIENT_IDS.value().split(",").map((s) => s.trim()).filter(Boolean);
  const ticket = await googleClient.verifyIdToken({ idToken, audience });
  const p = ticket.getPayload();
  if (!p?.email) throw new NoEmailError();
  return { email: p.email.toLowerCase(), emailVerified: p.email_verified === true, name: p.name ?? null };
}

async function verifyApple(idToken: string, rawNonce: string): Promise<VerifiedIdentity> {
  const { payload } = await jwtVerify(idToken, appleKeys, { issuer: APPLE_ISSUER, audience: APPLE_AUDIENCES });
  // The app hashes a random nonce into the request; the token must carry that hash, so a
  // token captured elsewhere can't be replayed here.
  const expected = createHash("sha256").update(rawNonce).digest("hex");
  if (!rawNonce || payload.nonce !== expected) throw new Error("nonce mismatch");
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email) throw new NoEmailError();
  const verified = payload.email_verified === true || payload.email_verified === "true";
  return { email, emailVerified: verified, name: null };
}

class NoEmailError extends Error {}

export const signInWithProvider = onRequest({ region: REGION }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method-not-allowed" });
    return;
  }
  const provider = String(req.body?.provider ?? "");
  const idToken = String(req.body?.idToken ?? "");
  const nonce = String(req.body?.nonce ?? "");
  // Apple sends the user's name only on the very first sign-in, to the app — not in the token.
  const displayName = String(req.body?.displayName ?? "").trim().slice(0, 100);
  if ((provider !== "apple" && provider !== "google") || idToken.length < 20) {
    res.status(400).json({ error: "invalid-request" });
    return;
  }

  let identity: VerifiedIdentity;
  try {
    identity = provider === "google" ? await verifyGoogle(idToken) : await verifyApple(idToken, nonce);
  } catch (e) {
    if (e instanceof NoEmailError) {
      res.status(422).json({ error: "no-email" });
      return;
    }
    logger.warn(`signInWithProvider: ${provider} token rejected`, (e as Error).message);
    res.status(401).json({ error: "invalid-token" });
    return;
  }
  if (!identity.emailVerified) {
    res.status(401).json({ error: "email-not-verified" });
    return;
  }

  const auth = getAuth();
  const name = displayName || identity.name || "";
  let isNewUser = false;
  let user;
  try {
    user = await auth.getUserByEmail(identity.email);
  } catch {
    user = await auth.createUser({ email: identity.email, emailVerified: true, displayName: name || undefined });
    isNewUser = true;
  }
  if (name && !user.displayName) user = await auth.updateUser(user.uid, { displayName: name });

  const customToken = await auth.createCustomToken(user.uid, { signInProvider: provider });
  const firstName = (user.displayName ?? "").trim().split(/\s+/)[0] || null;
  res.status(200).json({ customToken, isNewUser, firstName });
});
