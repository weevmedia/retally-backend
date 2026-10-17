/**
 * ReTally Cloud Functions entry point (2nd gen, region us-east1).
 *
 * Each domain lives in its own module — this file only wires them up.
 * Deployed function names and URLs are unchanged by the split.
 *
 *   auth/   - lookupAccount, requestOtp, verifyOtp (email OTP sign-in)
 *   config/ - getCategories, getStoreIcons (server-driven config)
 *   ai/     - parseTornReceipt (Gemini fallback for torn/damaged receipts)
 *   shopping/ - AI shopping list: onReceiptWrittenForShoppingList, processShoppingLists, getShoppingList
 *   shared/ - constants, crypto, validation, Firebase init
 *
 * Secrets (firebase functions:secrets:set):
 *   RESEND_API_KEY  - Resend API key (sign up at resend.com)
 *   OTP_PEPPER      - any long random string, e.g. `openssl rand -hex 32`
 *   GEMINI_API_KEY  - Google AI Studio API key for the torn-receipt fallback
 *                     (https://aistudio.google.com/apikey)
 */

import { initFirebase } from "./shared/firebase";

initFirebase();

export { lookupAccount, requestOtp, verifyOtp } from "./auth";
export { getCategories, getStoreIcons } from "./config";
export { parseTornReceipt } from "./ai";
export { getShoppingList, onReceiptWrittenForShoppingList, processShoppingLists } from "./shopping";
export { getRecalls, syncRecalls } from "./recalls";
export {
  adminDeleteStore, adminDiscoverStores, adminGetReceipt, adminInviteAdmin, adminListUsers, adminMergeStore,
  adminSaveCategories, adminSearchReceipts, adminSetAdmin, adminSetUserDisabled, adminUpsertStore,
} from "./admin";
export { onReceiptWrittenForStores } from "./stores";
