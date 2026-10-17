/**
 * Food recall sources. Both are free, official and need no API key:
 *  - FDA recalls RSS: company announcements for FDA-regulated products (packaged food,
 *    allergens, listeria…). Timely and each item links to its FDA press release. The feed
 *    also carries drug/device/cosmetic recalls, which [looksNonFood] filters out.
 *  - USDA FSIS Recall API: meat, poultry and egg products, which the FDA does not cover.
 */
import { createHash } from "node:crypto";
import { logger } from "firebase-functions/v2";

export interface Recall {
  id: string;
  source: "FDA" | "USDA";
  title: string;
  /** Plain-text snippet shown under the title (~240 chars). */
  excerpt: string;
  url: string;
  /** ISO-8601 instant. */
  publishedAt: string;
  /** Extra text used only for purchase matching (product list, firm). Not shown. */
  matchText: string;
  classification?: string;
}

const FDA_RSS_URLS = [
  "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml",
  "https://www.fda.gov/AboutFDA/ContactFDA/StayInformed/RSSFeeds/Recalls/rss.xml",
];
const FSIS_API = "https://www.fsis.usda.gov/fsis/api/recall/v/1?field_translation_language=en";
const FSIS_HOME = "https://www.fsis.usda.gov";
const FSIS_FALLBACK_URL = "https://www.fsis.usda.gov/recalls";
// Browser-like headers: fda.gov and fsis.usda.gov sit behind bot protection that can reject
// unusual user agents from cloud IPs.
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "application/rss+xml, application/xml, application/json, text/xml, */*",
  "Accept-Language": "en-US,en;q=0.9",
};
const OPENFDA_API = "https://api.fda.gov/food/enforcement.json";
const FDA_RECALLS_PAGE = "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts";
const EXCERPT_LEN = 240;

const idFor = (source: string, key: string): string =>
  createHash("sha1").update(`${source}|${key}`).digest("hex").slice(0, 24);

/** HTML → plain text: drop tags, decode the common entities, collapse whitespace. */
export function toPlainText(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, "\"")
    .replace(/&ndash;|&mdash;/g, "–")
    .replace(/&reg;/g, "®")
    .replace(/&trade;/g, "™")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

export function excerptOf(text: string, max = EXCERPT_LEN): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}…`;
}

// ---------- FDA (RSS) ----------

const NON_FOOD = new RegExp(
  "\\b(" + [
    "tablets?", "capsules?", "injections?", "injectable", "syringes?", "vials?", "catheters?", "devices?",
    "pharmac\\w*", "prescription", "ophthalmic", "eye ?drops?", "inhalers?", "topical", "ointments?",
    "sunscreen", "cosmetics?", "hand sanitizers?", "vapes?", "e-cigarettes?", "contact lens\\w*",
    "surgical", "implants?", "infusion", "drug products?", "kits?", "test strips?", "ventilators?",
  ].join("|") + ")\\b",
  "i",
);

const SPANISH = /\b(emite|retira|debido|alerta por|al[ée]rgenos?|no declarad[oa]|voluntariamente)\b/i;

/** True for drug/device/cosmetic recalls that share the FDA feed with food. */
export function looksNonFood(text: string): boolean {
  return NON_FOOD.test(text);
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : "";
}

export function parseFdaRss(xml: string): Recall[] {
  const out: Recall[] = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  if (items.length === 0) logger.warn(`FDA RSS: no <item> found; body starts: ${xml.slice(0, 200)}`);
  for (const item of items) {
    const title = toPlainText(tag(item, "title"));
    const link = toPlainText(tag(item, "link"));
    const description = toPlainText(tag(item, "description"));
    const pub = Date.parse(toPlainText(tag(item, "pubDate")) || toPlainText(tag(item, "dc:date")));
    if (!title || !link || Number.isNaN(pub)) continue;
    if (looksNonFood(`${title} ${description}`)) continue;
    if (SPANISH.test(title)) continue; // FDA posts Spanish duplicates of some notices
    out.push({
      id: idFor("FDA", link),
      source: "FDA",
      title,
      excerpt: excerptOf(description || title),
      url: link.replace(/^http:\/\//, "https://"),
      publishedAt: new Date(pub).toISOString(),
      matchText: `${title} ${description}`,
    });
  }
  return out;
}

export async function fetchFdaRecalls(): Promise<Recall[]> {
  for (const url of FDA_RSS_URLS) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        logger.warn(`FDA RSS ${url} -> HTTP ${res.status}`);
        continue;
      }
      const parsed = parseFdaRss(await res.text());
      logger.info(`FDA RSS ${url}: ${parsed.length} food recalls`);
      if (parsed.length > 0) return parsed;
    } catch (e) {
      logger.warn(`FDA RSS ${url} failed`, e);
    }
  }
  // Fallback: openFDA food enforcement reports (an official API, food only). It lags the press
  // releases and has no per-recall page, so cards link to the FDA recalls list.
  return fetchOpenFdaRecalls();
}

const yyyymmdd = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, "");

export async function fetchOpenFdaRecalls(days = 60): Promise<Recall[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const url = `${OPENFDA_API}?search=report_date:[${yyyymmdd(from)}+TO+${yyyymmdd(to)}]&sort=report_date:desc&limit=100`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      logger.warn(`openFDA -> HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const out: Recall[] = [];
    for (const r of body.results ?? []) {
      const d = str(r.report_date || r.recall_initiation_date);
      const date = /^\d{8}$/.test(d) ? Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00Z`) : NaN;
      const product = toPlainText(str(r.product_description));
      const firm = toPlainText(str(r.recalling_firm));
      const reason = toPlainText(str(r.reason_for_recall));
      if (!product || Number.isNaN(date)) continue;
      out.push({
        id: idFor("FDA", str(r.recall_number) || product),
        source: "FDA",
        title: excerptOf(`${firm ? `${firm}: ` : ""}${product}`, 140),
        excerpt: excerptOf(reason || product),
        url: FDA_RECALLS_PAGE,
        publishedAt: new Date(date).toISOString(),
        matchText: `${product} ${firm}`,
        classification: str(r.classification) || undefined,
      });
    }
    logger.info(`openFDA: ${out.length} food recalls`);
    return out;
  } catch (e) {
    logger.warn("openFDA failed", e);
    return [];
  }
}

// ---------- USDA FSIS (JSON API) ----------

type FsisRecord = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** The press-release link: the API returns it as a URL, a site-relative path or an HTML anchor. */
export function fsisUrl(rec: FsisRecord): string {
  for (const key of ["field_en_press_release", "field_press_release", "field_recall_url", "url"]) {
    const raw = str(rec[key]).trim();
    if (!raw) continue;
    const href = raw.match(/href="([^"]+)"/i)?.[1] ?? raw;
    if (/^https?:\/\//i.test(href)) return href.replace(/^http:\/\//i, "https://");
    if (href.startsWith("/")) return `${FSIS_HOME}${href}`;
  }
  return FSIS_FALLBACK_URL;
}

/** Drops the press-release dateline, e.g. "WASHINGTON, Oct. 29, 2022 – ". */
const stripDateline = (text: string): string => text.replace(/^[A-Z][A-Z .,'-]*,\s*[A-Za-z.]+\s+\d{1,2},\s*\d{4}\s*[–—-]\s*/, "");

export function parseFsis(records: FsisRecord[], sinceMs: number): Recall[] {
  const out: Recall[] = [];
  for (const rec of records) {
    const lang = str(rec.langcode).toLowerCase();
    if (lang && !lang.startsWith("en")) continue;
    const title = toPlainText(str(rec.field_title));
    // Date-only values: pin to noon UTC so the day doesn't shift in US time zones.
    const rawDate = str(rec.field_recall_date).trim();
    const date = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate}T12:00:00Z` : rawDate);
    if (!title || Number.isNaN(date) || date < sinceMs) continue;
    const summary = stripDateline(toPlainText(str(rec.field_summary)));
    const products = toPlainText(str(rec.field_product_items));
    const number = str(rec.field_recall_number);
    out.push({
      id: idFor("USDA", number || title),
      source: "USDA",
      title,
      excerpt: excerptOf(summary || products || title),
      url: fsisUrl(rec),
      publishedAt: new Date(date).toISOString(),
      matchText: `${title} ${products} ${str(rec.field_establishment)}`,
      classification: str(rec.field_recall_classification) || undefined,
    });
  }
  return out;
}

export async function fetchFsisRecalls(sinceMs: number): Promise<Recall[]> {
  try {
    const res = await fetch(FSIS_API, { headers: { ...HEADERS, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      logger.warn(`FSIS API -> HTTP ${res.status}`);
      return [];
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      logger.warn(`FSIS API: not JSON (blocked?); body starts: ${text.slice(0, 200)}`);
      return [];
    }
    const parsed = Array.isArray(body) ? parseFsis(body as FsisRecord[], sinceMs) : [];
    logger.info(`FSIS API: ${Array.isArray(body) ? body.length : 0} records, ${parsed.length} in window`);
    return parsed;
  } catch (e) {
    logger.warn("FSIS API failed", e);
    return [];
  }
}
