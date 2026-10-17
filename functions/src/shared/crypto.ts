import { createHash } from "crypto";

/** SHA-256 hex digest. Used for OTP code hashes and Firestore doc ids. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
