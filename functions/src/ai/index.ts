/**
 * Torn/damaged receipt fallback: sends the receipt image to Gemini for a second
 * pass when on-device OCR couldn't read it fully.
 *
 *   POST /parseTornReceipt { imageBase64, mimeType? } -> 200 { ok: true, receipt: {...} }
 *
 * Auth: Firebase ID token in the Authorization header (Bearer <token>).
 * The Gemini API key lives in the GEMINI_API_KEY secret — never in the app.
 *
 * Returns structured JSON with per-field confidence. The app validates:
 *   - item prices sum to the subtotal (within $0.02)
 *   - subtotal + tax ≈ total (within $0.02)
 * Fields Gemini inferred (not clearly read) get confidence < 1.0 and the app
 * shows them with an 'estimated' badge.
 *
 * Set the secret with:
 *   firebase functions:secrets:set GEMINI_API_KEY
 */

import { onRequest } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { REGION } from "../shared/constants";

interface TornReceiptItemDto {
  name: string;
  price: number;
  confidence: number;
}

interface TornReceiptDto {
  storeName: string | null;
  storeNameConfidence: number;
  purchaseDate: string | null;  // ISO date YYYY-MM-DD
  purchaseDateConfidence: number;
  items: TornReceiptItemDto[];
  subtotal: number | null;
  subtotalConfidence: number;
  tax: number | null;
  taxConfidence: number;
  total: number | null;
  totalConfidence: number;
  paymentInfo: string | null;
}

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const TORN_RECEIPT_PROMPT = `You are reading a damaged, torn, or faded grocery receipt. Extract what you can see.

Return ONLY valid JSON (no markdown, no explanation) with this exact shape:
{
  "storeName": "string or null",
  "storeNameConfidence": 0.0-1.0,
  "purchaseDate": "YYYY-MM-DD or null",
  "purchaseDateConfidence": 0.0-1.0,
  "items": [{"name": "string", "price": 0.00, "confidence": 0.0-1.0}],
  "subtotal": 0.00 or null,
  "subtotalConfidence": 0.0-1.0,
  "tax": 0.00 or null,
  "taxConfidence": 0.0-1.0,
  "total": 0.00 or null,
  "totalConfidence": 0.0-1.0,
  "paymentInfo": "string or null"
}

Rules:
- Confidence 1.0 = clearly readable. Below 0.7 = you inferred or guessed — be honest.
- If a field is not visible at all, use null with confidence 0.
- Prices as numbers (e.g. 4.99), not strings.
- Only include items you can actually see; don't invent line items.`;

/**
 * Extracts the JSON object from model output. Handles markdown fences,
 * surrounding explanation text, and pretty-printed JSON.
 */
function extractJson(text: string): string {
  // Strip markdown fences first.
  let t = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  // If it's already valid JSON, return as-is.
  try {
    JSON.parse(t);
    return t;
  } catch { /* fall through to brace matching */ }
  // Find the outermost { ... }.
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return t.slice(start, end + 1);
  }
  return t;
}

/**
 * Gemini statuses worth retrying: rate limits, overload, and transient
 * server errors. Anything else (bad key, unknown model, bad request)
 * fails fast with no retry.
 */
const RETRYABLE_GEMINI_STATUS = new Set([408, 429, 500, 503, 504]);
// Single quick retry: if Gemini is still overloaded after one backoff, fail fast
// so the app falls back to the on-device parse instead of hanging. Worst case
// (~15s) stays well inside the 60s function and app timeouts.
const GEMINI_RETRY_DELAYS_MS = [5000];

/**
 * Calls Gemini, retrying transient failures (e.g. 503 overloaded).
 * Returns the final response with its body untouched, so the caller's
 * existing ok/error handling below works unchanged.
 */
async function callGemini(url: string, payload: string): Promise<Response> {
  const maxAttempts = GEMINI_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const retryable = !res.ok && RETRYABLE_GEMINI_STATUS.has(res.status);
    if (!retryable || attempt === maxAttempts) {
      return res;
    }
    const errText = await res.text().catch(() => "");
    const delay = GEMINI_RETRY_DELAYS_MS[attempt - 1];
    console.error(
      `parseTornReceipt: Gemini ${res.status}, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`,
      errText.slice(0, 300),
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error("callGemini: unreachable");
}

export const parseTornReceipt = onRequest(
  { region: REGION, secrets: ["GEMINI_API_KEY"] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "method-not-allowed" });
      return;
    }

    // Verify Firebase auth.
    const authHeader = String(req.headers.authorization ?? "");
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    try {
      await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ ok: false, error: "invalid-token" });
      return;
    }

    const imageBase64 = String(req.body?.imageBase64 ?? "");
    const mimeType = String(req.body?.mimeType ?? "image/jpeg");
    if (!imageBase64 || imageBase64.length < 100) {
      res.status(400).json({ ok: false, error: "missing-image" });
      return;
    }
    // ~10MB cap on the base64 payload.
    if (imageBase64.length > 14_000_000) {
      res.status(400).json({ ok: false, error: "image-too-large" });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) {
      console.error("parseTornReceipt: GEMINI_API_KEY secret not set");
      res.status(500).json({ ok: false, error: "server-misconfigured" });
      return;
    }

    try {
      const geminiRes = await callGemini(
        `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
        JSON.stringify({
          contents: [{
            parts: [
              { text: TORN_RECEIPT_PROMPT },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
          },
        }),
      );

      if (!geminiRes.ok) {
        const errText = await geminiRes.text().catch(() => "");
        console.error("parseTornReceipt: Gemini API error", geminiRes.status, errText.slice(0, 500));
        res.status(502).json({ ok: false, error: "gemini-error", status: geminiRes.status });
        return;
      }

      const geminiJson = await geminiRes.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (!rawText) {
        res.status(502).json({ ok: false, error: "empty-response" });
        return;
      }

      // Strip markdown fences if the model added them despite instructions.
      // Fall back to extracting the outermost { ... } if there's surrounding text.
      const cleaned = extractJson(rawText);
      let receipt: TornReceiptDto;
      try {
        receipt = JSON.parse(cleaned);
      } catch {
        console.error("parseTornReceipt: invalid JSON from Gemini", cleaned.slice(0, 500));
        res.status(502).json({ ok: false, error: "invalid-json" });
        return;
      }

      // Sanitize: clamp confidences, drop malformed items.
      const clamp01 = (v: unknown): number => {
        const n = typeof v === "number" ? v : 0;
        return Math.min(1, Math.max(0, n));
      };
      const cleanNum = (v: unknown): number | null =>
        typeof v === "number" && isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
      const items: TornReceiptItemDto[] = Array.isArray(receipt.items)
        ? receipt.items
            .filter((it) => it && typeof it.name === "string" && it.name.trim().length > 0)
            .map((it) => ({
              name: String(it.name).trim().slice(0, 128),
              price: cleanNum(it.price) ?? 0,
              confidence: clamp01(it.confidence),
            }))
            .slice(0, 200)
        : [];

      const out: TornReceiptDto = {
        storeName: typeof receipt.storeName === "string" ? receipt.storeName.trim().slice(0, 128) || null : null,
        storeNameConfidence: clamp01(receipt.storeNameConfidence),
        purchaseDate: typeof receipt.purchaseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(receipt.purchaseDate)
          ? receipt.purchaseDate : null,
        purchaseDateConfidence: clamp01(receipt.purchaseDateConfidence),
        items,
        subtotal: cleanNum(receipt.subtotal),
        subtotalConfidence: clamp01(receipt.subtotalConfidence),
        tax: cleanNum(receipt.tax),
        taxConfidence: clamp01(receipt.taxConfidence),
        total: cleanNum(receipt.total),
        totalConfidence: clamp01(receipt.totalConfidence),
        paymentInfo: typeof receipt.paymentInfo === "string" ? receipt.paymentInfo.trim().slice(0, 64) || null : null,
      };

      res.status(200).json({ ok: true, receipt: out });
    } catch (e) {
      console.error("parseTornReceipt failed", e);
      res.status(500).json({ ok: false, error: "internal" });
    }
  }
);
