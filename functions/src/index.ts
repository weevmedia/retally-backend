/**
 * ReTally Cloud Functions entry point (2nd gen, region us-east1).
 *
 * Each domain lives in its own module — this file only wires them up.
 * Deployed function names and URLs are unchanged by the split.
 *
 *   auth/   - lookupAccount, requestOtp, verifyOtp (email OTP sign-in)
 *   config/ - getCategories, getStoreIcons (server-driven config)
 *   ai/     - parseTornReceipt (Gemini fallback for torn/damaged receipts)
 *   shopping/ - AI shopping list: onReceiptWrittenForShoppingList, processShoppingLists, getShoppingList,
 *               getNudges (Home nudges, built in the same pass — see nudges/compute.ts)
 *   devices/ - registerDevice (which phones each user has; listed in the admin console)
 *   recalls/ - getRecalls (FDA + USDA food recalls, fetched live and cached in memory)
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
export { signInWithProvider } from "./auth/provider";
export { getCategories, getStoreIcons } from "./config";
export { parseTornReceipt } from "./ai";
export { getNudges, getShoppingList, onReceiptWrittenForShoppingList, processShoppingLists } from "./shopping";
export { getRecalls } from "./recalls";
export { processPriceDrops } from "./priceDrops";
export { categorizeItems } from "./categories";
export { registerDevice } from "./devices";
export {
  adminDeleteStore, adminDiscoverStores, adminGetReceipt, adminInviteAdmin, adminListUsers, adminMergeStore,
  adminSaveCategories, adminSearchReceipts, adminSetAdmin, adminSetUserDisabled, adminUpsertStore,
  adminListItemAliases, adminSetItemCategory,
} from "./admin";
export { onReceiptWrittenForStores } from "./stores";
