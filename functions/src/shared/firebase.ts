import { initializeApp } from "firebase-admin/app";

/**
 * Initializes the Firebase Admin SDK. Called once from the entry point
 * (src/index.ts) — every domain module shares this instance.
 */
export function initFirebase(): void {
  initializeApp();
}
