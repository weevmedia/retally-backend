/**
 * Admin console: receipts across all users (read-only).
 *
 * Receipts live under `users/{uid}/receipts` and the security rules keep them owner-only, so the
 * console never reads them directly — it calls these functions, which re-check the admin claim.
 *
 *  - adminSearchReceipts: reads the receipts (all users, or one user's) WITHOUT a where/orderBy,
 *    because Firestore silently drops documents that lack the field a query filters or sorts on —
 *    and older app builds didn't always write `purchaseDateLocal`. Every filter (dates included),
 *    the sort, the summary and the paging run here in memory. Each receipt's date falls back
 *    purchaseDateLocal → purchaseDate → createdAt → updatedAt, and timestamps, ISO strings and
 *    epoch numbers are all accepted. At most SCAN_LIMIT receipts are read per search; beyond that
 *    the result says `truncated`. Heavy fields (OCR text, embeddings) are never fetched.
 *  - adminGetReceipt: one receipt with its line items and owner, for the detail view.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { DocumentData, Query, QueryDocumentSnapshot, Timestamp, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { REGION } from "../shared/constants";
import { requireAdmin } from "./common";

const SCAN_LIMIT = 5000;
const MAX_PAGE_SIZE = SCAN_LIMIT; // the console's CSV export asks for everything in one page
const LOW_CONFIDENCE = 0.7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp)$/i;

const LIST_FIELDS = [
  "storeName", "merchantId", "merchantNameNormalized", "purchaseDate", "purchaseDateLocal", "currency",
  "subtotal", "tax", "total", "lineItemCount", "paymentMethod", "analysis", "categoryTotals",
  "image", "source", "createdAt", "updatedAt", "deletedAt",
];

type SortField = "date" | "total" | "store" | "items" | "overcharge" | "user";

interface Filters {
  from: string | null;
  to: string | null;
  text: string;
  searchOcr: boolean;
  user: string;
  store: string;
  minTotal: number | null;
  maxTotal: number | null;
  minItems: number | null;
  maxItems: number | null;
  sources: string[];
  paymentMethods: string[];
  currencies: string[];
  categories: string[];
  issues: string[];
  status: "active" | "deleted" | "all";
  hasImage: "any" | "yes" | "no";
}

export interface ReceiptRow {
  uid: string;
  id: string;
  email: string | null;
  storeName: string;
  merchantId: string | null;
  purchaseDate: string | null;
  purchaseDateLocal: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  lineItemCount: number;
  paymentMethod: string;
  source: string;
  duplicateCount: number;
  overchargeAmount: number;
  flags: string[];
  confidence: number | null;
  categories: string[];
  hasImage: boolean;
  deleted: boolean;
  createdAt: string | null;
}

// ---------- input parsing (the browser is never trusted) ----------

function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 50) : [];
}
function date(v: unknown, field: string): string | null {
  const s = str(v, 10);
  if (!s) return null;
  if (!DATE_RE.test(s)) throw new HttpsError("invalid-argument", `${field} must be YYYY-MM-DD.`);
  return s;
}

function parseFilters(raw: unknown): Filters {
  const f = (raw ?? {}) as Record<string, unknown>;
  const status = f.status === "deleted" || f.status === "all" ? f.status : "active";
  const hasImage = f.hasImage === "yes" || f.hasImage === "no" ? f.hasImage : "any";
  const filters: Filters = {
    from: date(f.from, "from"),
    to: date(f.to, "to"),
    text: str(f.text).toLowerCase(),
    searchOcr: f.searchOcr === true,
    user: str(f.user),
    store: str(f.store).toLowerCase(),
    minTotal: num(f.minTotal),
    maxTotal: num(f.maxTotal),
    minItems: num(f.minItems),
    maxItems: num(f.maxItems),
    sources: list(f.sources),
    paymentMethods: list(f.paymentMethods),
    currencies: list(f.currencies),
    categories: list(f.categories),
    issues: list(f.issues),
    status,
    hasImage,
  };
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new HttpsError("invalid-argument", "The start date is after the end date.");
  }
  return filters;
}

// ---------- helpers ----------

/** Accepts a Firestore Timestamp, an ISO / date string, or epoch seconds / millis. */
function dateOf(v: unknown): Date | null {
  let d: Date | null = null;
  if (v instanceof Timestamp) d = v.toDate();
  else if (typeof v === "string" && v.trim()) d = new Date(v.trim());
  else if (typeof v === "number" && Number.isFinite(v) && v > 0) d = new Date(v < 1e12 ? v * 1000 : v);
  else if (v && typeof v === "object" && typeof (v as { toDate?: unknown }).toDate === "function") d = (v as { toDate(): Date }).toDate();
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
function iso(v: unknown): string | null {
  return dateOf(v)?.toISOString() ?? null;
}
/** YYYY-MM-DD for a receipt: the app's local date if present, else the first usable timestamp (UTC day). */
function localDayOf(d: DocumentData): string {
  if (typeof d.purchaseDateLocal === "string" && DATE_RE.test(d.purchaseDateLocal)) return d.purchaseDateLocal;
  for (const v of [d.purchaseDate, d.createdAt, d.updatedAt]) {
    const date = dateOf(v);
    if (date) return date.toISOString().slice(0, 10);
  }
  return "";
}
function n(v: unknown): number {
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toRow(doc: QueryDocumentSnapshot<DocumentData>): ReceiptRow {
  const d = doc.data();
  const analysis = (d.analysis ?? {}) as Record<string, unknown>;
  const image = (d.image ?? {}) as Record<string, unknown>;
  return {
    uid: doc.ref.parent.parent?.id ?? "",
    id: doc.id,
    email: null,
    storeName: typeof d.storeName === "string" ? d.storeName : "",
    merchantId: typeof d.merchantId === "string" ? d.merchantId : null,
    purchaseDate: iso(d.purchaseDate),
    purchaseDateLocal: localDayOf(d),
    currency: typeof d.currency === "string" ? d.currency : "",
    subtotal: n(d.subtotal),
    tax: n(d.tax),
    total: n(d.total),
    lineItemCount: n(d.lineItemCount),
    paymentMethod: typeof d.paymentMethod === "string" ? d.paymentMethod : "unknown",
    source: typeof d.source === "string" ? d.source : "",
    duplicateCount: n(analysis.duplicateCount),
    overchargeAmount: n(analysis.overchargeAmount),
    flags: Array.isArray(analysis.flags) ? analysis.flags.filter((x): x is string => typeof x === "string") : [],
    confidence: typeof analysis.confidence === "number" ? analysis.confidence : null,
    categories: d.categoryTotals && typeof d.categoryTotals === "object" ? Object.keys(d.categoryTotals) : [],
    hasImage: typeof image.storagePath === "string" && image.storagePath.length > 0,
    deleted: d.deletedAt !== undefined && d.deletedAt !== null && d.deletedAt !== false,
    createdAt: iso(d.createdAt),
  };
}

/** Resolves the "user" filter (an email or a uid) to a uid; null means "no such user". */
async function resolveUser(user: string): Promise<string | null> {
  if (!user.includes("@")) return user;
  try {
    return (await getAuth().getUserByEmail(user.toLowerCase())).uid;
  } catch {
    return null;
  }
}

/** uid → email (anonymous users map to null), 100 per Auth call. */
async function emailsOf(uids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < uids.length; i += 100) {
    const batch = uids.slice(i, i + 100);
    const res = await getAuth().getUsers(batch.map((uid) => ({ uid })));
    for (const u of res.users) out.set(u.uid, u.email ?? null);
  }
  return out;
}

function matchesIssues(r: ReceiptRow, issues: string[]): boolean {
  if (issues.length === 0) return true;
  return issues.some((issue) => {
    switch (issue) {
      case "duplicates": return r.duplicateCount > 0;
      case "overcharge": return r.overchargeAmount > 0;
      case "low_confidence": return r.confidence !== null && r.confidence < LOW_CONFIDENCE;
      case "no_items": return r.lineItemCount === 0;
      default: return r.flags.includes(issue); // price_mismatch, total_mismatch, tax_anomaly, duplicate_line, ...
    }
  });
}

function matches(r: ReceiptRow, f: Filters, ocrText: string): boolean {
  // Receipts with no usable date at all only show when no date range is set.
  if (f.from && (!r.purchaseDateLocal || r.purchaseDateLocal < f.from)) return false;
  if (f.to && (!r.purchaseDateLocal || r.purchaseDateLocal > f.to)) return false;
  if (f.status === "active" && r.deleted) return false;
  if (f.status === "deleted" && !r.deleted) return false;
  if (f.store && !r.storeName.toLowerCase().includes(f.store) && !(r.merchantId ?? "").includes(f.store)) return false;
  if (f.minTotal !== null && r.total < f.minTotal) return false;
  if (f.maxTotal !== null && r.total > f.maxTotal) return false;
  if (f.minItems !== null && r.lineItemCount < f.minItems) return false;
  if (f.maxItems !== null && r.lineItemCount > f.maxItems) return false;
  if (f.sources.length && !f.sources.includes(r.source)) return false;
  if (f.paymentMethods.length && !f.paymentMethods.includes(r.paymentMethod)) return false;
  if (f.currencies.length && !f.currencies.includes(r.currency)) return false;
  if (f.categories.length && !f.categories.some((c) => r.categories.includes(c))) return false;
  if (f.hasImage === "yes" && !r.hasImage) return false;
  if (f.hasImage === "no" && r.hasImage) return false;
  if (!matchesIssues(r, f.issues)) return false;
  if (f.text) {
    const hay = [r.storeName, r.merchantId ?? "", r.id, r.uid, r.email ?? "", ocrText].join(" ").toLowerCase();
    if (!f.text.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

function compare(a: ReceiptRow, b: ReceiptRow, field: SortField): number {
  switch (field) {
    case "total": return a.total - b.total;
    case "items": return a.lineItemCount - b.lineItemCount;
    case "overcharge": return a.overchargeAmount - b.overchargeAmount;
    case "store": return a.storeName.localeCompare(b.storeName, undefined, { sensitivity: "base" });
    case "user": return (a.email ?? a.uid).localeCompare(b.email ?? b.uid);
    case "date":
    default:
      return a.purchaseDateLocal.localeCompare(b.purchaseDateLocal) || (a.purchaseDate ?? "").localeCompare(b.purchaseDate ?? "");
  }
}

function addTo(map: Record<string, number>, key: string, amount: number): void {
  map[key || "?"] = Math.round(((map[key || "?"] ?? 0) + amount) * 100) / 100;
}

// ---------- receipt photos ----------
// The app uploads photos to Storage under users/{uid}/…/{receiptId}.jpg, but older builds left
// `image.storagePath` null on the receipt. So photos are found by listing Storage, not by the field.

function photoKeyOf(objectName: string): string | null {
  const parts = objectName.split("/");
  if (parts.length < 3 || parts[0] !== "users" || !IMAGE_EXT.test(objectName)) return null;
  if (parts.includes("thumbnails")) return null;
  const base = parts[parts.length - 1].replace(IMAGE_EXT, "");
  return `${parts[1]}/${base}`;
}

/** `${uid}/${receiptId}` → object path, for every receipt photo (one user's, or everyone's). */
async function photoIndex(uid: string | null): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  try {
    const [files] = await getStorage().bucket().getFiles({ prefix: uid ? `users/${uid}/` : "users/", autoPaginate: true });
    for (const file of files) {
      const key = photoKeyOf(file.name);
      if (key && !index.has(key)) index.set(key, file.name);
    }
  } catch (e) {
    logger.warn("photoIndex: couldn't list Storage", e);
  }
  return index;
}

/** A browser-loadable URL for a Storage object, using its Firebase download token when it has one. */
async function downloadUrlOf(path: string): Promise<string | null> {
  try {
    const file = getStorage().bucket().file(path);
    const [meta] = await file.getMetadata();
    const token = String(meta.metadata?.firebaseStorageDownloadTokens ?? "").split(",")[0];
    if (!token) return null;
    return `https://firebasestorage.googleapis.com/v0/b/${file.bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  } catch (e) {
    logger.warn(`downloadUrlOf(${path}) failed`, e);
    return null;
  }
}

// ---------- callables ----------

export const adminSearchReceipts = onCall({ region: REGION, memory: "512MiB", timeoutSeconds: 60 }, async (request) => {
  await requireAdmin(request);
  const data = (request.data ?? {}) as Record<string, unknown>;
  const f = parseFilters(data.filters);
  const sortField = (["date", "total", "store", "items", "overcharge", "user"].includes(String(data.sortField))
    ? data.sortField : "date") as SortField;
  const sortDir = data.sortDir === "asc" ? 1 : -1;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(num(data.pageSize) ?? 25)));
  const page = Math.max(0, Math.trunc(num(data.page) ?? 0));

  // 1. One read: one user's receipts, or everyone's (collection group). No where/orderBy on purpose
  //    (see the header comment) — dates are filtered below like everything else.
  const db = getFirestore();
  let uidFilter: string | null = null;
  if (f.user) {
    uidFilter = await resolveUser(f.user);
    if (uidFilter === null) {
      return { rows: [], total: 0, scanned: 0, truncated: false, summary: emptySummary(), facets: emptyFacets(), userNotFound: true };
    }
  }
  let q: Query = uidFilter ? db.collection(`users/${uidFilter}/receipts`) : db.collectionGroup("receipts");
  const fields = f.text && f.searchOcr ? [...LIST_FIELDS, "ocr.rawText"] : LIST_FIELDS;
  q = q.select(...fields).limit(SCAN_LIMIT + 1);

  let docs: QueryDocumentSnapshot<DocumentData>[];
  try {
    docs = (await q.get()).docs;
  } catch (e) {
    const code = (e as { code?: number }).code;
    logger.error("adminSearchReceipts query failed", e);
    if (code === 9) throw new HttpsError("failed-precondition", "Firestore needs an index for this query — check the function logs for the link.");
    throw new HttpsError("internal", "Couldn't load receipts.");
  }
  const truncated = docs.length > SCAN_LIMIT;
  if (truncated) docs = docs.slice(0, SCAN_LIMIT);

  // 2. Rows + owners' emails + which receipts have a photo in Storage.
  const [rows, photos] = [docs.map(toRow), await photoIndex(uidFilter)];
  for (const r of rows) if (!r.hasImage && photos.has(`${r.uid}/${r.id}`)) r.hasImage = true;
  const ocr = new Map<string, string>();
  if (f.text && f.searchOcr) {
    for (const d of docs) ocr.set(d.ref.path, String(d.get("ocr.rawText") ?? ""));
  }
  const emails = await emailsOf([...new Set(rows.map((r) => r.uid))]);
  for (const r of rows) r.email = emails.get(r.uid) ?? null;

  // 3. Facets come from everything in the date range, so options don't vanish as you filter.
  const facets = facetsOf(rows);

  // 4. Filter, summarise, sort, page.
  const filtered = rows.filter((r, i) => matches(r, f, ocr.get(docs[i].ref.path) ?? ""));
  const summary = summarize(filtered);
  filtered.sort((a, b) => compare(a, b, sortField) * sortDir);
  const start = page * pageSize;

  return {
    rows: filtered.slice(start, start + pageSize),
    total: filtered.length,
    scanned: rows.length,
    truncated,
    summary,
    facets,
    userNotFound: false,
  };
});

function emptySummary() {
  return { count: 0, users: 0, stores: 0, items: 0, spentByCurrency: {}, overchargeByCurrency: {}, withDuplicates: 0, withIssues: 0, deleted: 0, undated: 0 };
}
function emptyFacets() {
  return { sources: [], paymentMethods: [], currencies: [], categories: [], flags: [] };
}

function summarize(rows: ReceiptRow[]) {
  const s = emptySummary();
  const spent: Record<string, number> = {};
  const over: Record<string, number> = {};
  const users = new Set<string>();
  const stores = new Set<string>();
  for (const r of rows) {
    s.count++;
    s.items += r.lineItemCount;
    users.add(r.uid);
    stores.add((r.merchantId ?? r.storeName).toLowerCase());
    addTo(spent, r.currency, r.total);
    if (r.overchargeAmount > 0) addTo(over, r.currency, r.overchargeAmount);
    if (r.duplicateCount > 0) s.withDuplicates++;
    if (r.duplicateCount > 0 || r.overchargeAmount > 0 || r.flags.length > 0) s.withIssues++;
    if (r.deleted) s.deleted++;
    if (!r.purchaseDateLocal) s.undated++;
  }
  return { ...s, users: users.size, stores: stores.size, spentByCurrency: spent, overchargeByCurrency: over };
}

function facetsOf(rows: ReceiptRow[]) {
  const sources = new Set<string>();
  const payments = new Set<string>();
  const currencies = new Set<string>();
  const categories = new Set<string>();
  const flags = new Set<string>();
  for (const r of rows) {
    if (r.source) sources.add(r.source);
    if (r.paymentMethod) payments.add(r.paymentMethod);
    if (r.currency) currencies.add(r.currency);
    r.categories.forEach((c) => categories.add(c));
    r.flags.forEach((x) => flags.add(x));
  }
  const sorted = (set: Set<string>) => [...set].sort();
  return {
    sources: sorted(sources), paymentMethods: sorted(payments), currencies: sorted(currencies),
    categories: sorted(categories), flags: sorted(flags),
  };
}

/** Converts Firestore values to JSON (timestamps → ISO strings) and drops embeddings. */
function plain(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    if (value.constructor?.name === "VectorValue") return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "embedding") continue;
      const p = plain(v);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  return value;
}

/** Line-item order; items without a numeric `position` go last (keeping their read order). */
function positionOf(item: Record<string, unknown>): number {
  return typeof item.position === "number" && Number.isFinite(item.position) ? item.position : Number.MAX_SAFE_INTEGER;
}

export const adminGetReceipt = onCall({ region: REGION }, async (request) => {
  await requireAdmin(request);
  const d = (request.data ?? {}) as Record<string, unknown>;
  const uid = str(d.uid, 128);
  const receiptId = str(d.receiptId, 128);
  if (!uid || !receiptId || uid.includes("/") || receiptId.includes("/")) {
    throw new HttpsError("invalid-argument", "uid and receiptId are required.");
  }
  const ref = getFirestore().doc(`users/${uid}/receipts/${receiptId}`);
  const [snap, items, user] = await Promise.all([
    ref.get(),
    ref.collection("lineItems").get(), // no orderBy: it would drop items without `position`
    getAuth().getUser(uid).catch(() => null),
  ]);
  if (!snap.exists) throw new HttpsError("not-found", "Receipt not found.");

  // Photo: the recorded path if there is one, otherwise whatever Storage holds for this receipt.
  const recorded = snap.get("image.storagePath");
  let imagePath: string | null = typeof recorded === "string" && recorded ? recorded : null;
  if (!imagePath) imagePath = (await photoIndex(uid)).get(`${uid}/${receiptId}`) ?? null;
  const imageUrl = imagePath ? await downloadUrlOf(imagePath) : null;

  return {
    imagePath,
    imageUrl,
    uid,
    id: receiptId,
    email: user?.email ?? null,
    anonymous: user ? user.providerData.length === 0 : null,
    receipt: plain(snap.data()),
    lineItems: items.docs
      .map((doc) => ({ id: doc.id, ...(plain(doc.data()) as Record<string, unknown>) }))
      .sort((a, b) => positionOf(a) - positionOf(b)),
  };
});
