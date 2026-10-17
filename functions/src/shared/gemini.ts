/**
 * Minimal Gemini JSON client shared by the AI features. Retries transient errors once
 * and returns the parsed JSON object, or throws.
 *
 * Models: use stable Flash / Flash-Lite versions (no "short-term availability" models).
 */
export const GEMINI_DECISION_MODEL = "gemini-3.5-flash";
export const GEMINI_LITE_MODEL = "gemini-3.5-flash-lite";

const RETRYABLE = new Set([408, 429, 500, 503, 504]);
const RETRY_DELAY_MS = 3000;

export async function generateJson<T>(
  model: string,
  prompt: string,
  options: { maxOutputTokens?: number; temperature?: number } = {},
): Promise<T> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("GEMINI_API_KEY secret not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
      responseMimeType: "application/json",
    },
  });

  let res: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (res.ok || !RETRYABLE.has(res.status) || attempt === 2) break;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  if (!res || !res.ok) {
    const text = res ? await res.text().catch(() => "") : "";
    throw new Error(`Gemini ${model} failed: ${res?.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`Gemini ${model} returned no JSON object`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
