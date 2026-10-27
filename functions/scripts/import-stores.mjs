#!/usr/bin/env node
/**
 * Bulk-imports store master data (name, aliases, category, logo) into `store_icons/{key}`,
 * with each logo uploaded to Storage at `store-icons/<key>.<ext>` — the same shape the admin
 * console's "Add store" dialog writes, so the stores show up there and in the app.
 *
 *   gcloud auth application-default login                       # once, project owner account
 *   node scripts/import-stores.mjs --dry-run                    # preview, writes nothing
 *   node scripts/import-stores.mjs                              # import (skips stores that already have a logo)
 *   node scripts/import-stores.mjs --overwrite                  # also replace existing logos
 *   node scripts/import-stores.mjs --only walmart,costco        # just these keys
 *   node scripts/import-stores.mjs --file my-stores.json        # a different list
 *
 * Logo source, per store, first one that works:
 *   1. a local file  scripts/data/logos/<key>.(png|jpg|jpeg|webp|svg)   ← drop in your own to override
 *   2. "logoUrl" on the store's row in the JSON (a direct image link you picked)
 *   3. Google's favicon service for the store's domain (256px)
 *   4. the site's /apple-touch-icon.png
 *   5. the icons the home page itself declares (<link rel="icon" / "apple-touch-icon"> and its
 *      web-app manifest), largest first — many sites only expose a big icon this way
 * Downloaded logos smaller than MIN_PX are rejected, so you never get a blurry 16px favicon;
 * the summary at the end lists those stores so you can add a local file for them.
 *
 * Keys use the SAME normalisation as the app's `iconKeyOf` and the console's `storeKeyOf`
 * ("Trader Joe's #552" → "traderjoes"); keep all three in sync.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const PROJECT_ID = "retally-c5212";
const BUCKET = "retally-c5212.firebasestorage.app";
const COLLECTION = "store_icons";
const AUDIT = "adminAudit";
const BY = "import-stores script";
const CATEGORIES = ["grocery", "warehouse", "pharmacy", "department", "convenience", "specialty", "other"];
const MAX_BYTES = 1024 * 1024; // same 1 MB cap as the console and storage.rules
const MIN_PX = 96;
const CONCURRENCY = 4;

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGO_DIR = join(HERE, "data", "logos");
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY_RUN = flag("--dry-run");
const OVERWRITE = flag("--overwrite");
const ONLY = option("--only")?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const FILE = option("--file") ?? join(HERE, "data", "us-stores.json");

// ---------- key normalisation (mirror of iconKeyOf / storeKeyOf) ----------
const SUFFIXES = new Set([
  "supercenter", "supermarket", "wholesale", "market", "markets",
  "store", "stores", "grocery", "groceries", "foods", "food",
]);
function storeKeyOf(name) {
  const key = name
    .toLowerCase()
    .replace(/#\d+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !SUFFIXES.has(w))
    .join("");
  return key || "unknown";
}

// ---------- image helpers ----------
function sniff(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { type: "image/png", ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return { type: "image/jpeg", ext: "jpg", ...jpegSize(buf) };
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { type: "image/webp", ext: "webp", width: null, height: null };
  }
  const head = buf.toString("utf8", 0, Math.min(buf.length, 512)).toLowerCase();
  if (head.includes("<svg")) return { type: "image/svg+xml", ext: "svg", width: Infinity, height: Infinity };
  return null;
}
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return { width: null, height: null };
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: null, height: null };
}

async function download(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) ReTally-import/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

let localLogos = null;
async function findLocalLogo(key) {
  localLogos ??= await readdir(LOGO_DIR).catch(() => []);
  const file = localLogos.find((f) => f.slice(0, -extname(f).length).toLowerCase() === key && TYPES[extname(f).slice(1).toLowerCase()]);
  return file ? join(LOGO_DIR, file) : null;
}

/** Returns { buf, type, ext, source } or throws with the reason no usable logo was found. */
async function resolveLogo(store, key) {
  const local = await findLocalLogo(key);
  if (local) {
    const buf = await readFile(local);
    const ext = extname(local).slice(1).toLowerCase();
    return { buf, type: TYPES[ext], ext: ext === "jpeg" ? "jpg" : ext, source: `local ${local.split("/").pop()}` };
  }
  if (!store.domain && !store.logoUrl) throw new Error("no domain and no local logo");

  const candidates = [];
  if (store.logoUrl) candidates.push({ url: store.logoUrl, source: "logoUrl" });
  if (store.domain) {
    candidates.push(
      { url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(store.domain)}&sz=256`, source: "google favicon" },
      { url: `https://${store.domain}/apple-touch-icon.png`, source: "apple-touch-icon" },
      { url: `https://www.${store.domain.replace(/^www\./, "")}/apple-touch-icon.png`, source: "apple-touch-icon (www)" },
    );
  }
  const problems = [];
  const tried = new Set();
  const attempt = async (c) => {
    if (tried.has(c.url)) return null;
    tried.add(c.url);
    try {
      const buf = await download(c.url);
      const info = sniff(buf);
      if (!info) { problems.push(`${c.source}: not an image`); return null; }
      if (info.width !== null && Math.min(info.width, info.height) < MIN_PX) {
        problems.push(`${c.source}: only ${info.width}x${info.height}px`);
        return null;
      }
      return { buf, type: info.type, ext: info.ext, source: c.source };
    } catch (e) {
      problems.push(`${c.source}: ${e.message}`);
      return null;
    }
  };
  for (const c of candidates) {
    const hit = await attempt(c);
    if (hit) return hit;
  }
  if (store.domain) {
    for (const c of await declaredIcons(store.domain, problems)) {
      const hit = await attempt(c);
      if (hit) return hit;
    }
  }
  throw new Error(problems.join("; "));
}

/**
 * Icons the store's home page declares: `<link rel="icon|apple-touch-icon" sizes=… href=…>` and the
 * web-app manifest's `icons`. Biggest declared size first; undeclared sizes go last.
 */
async function declaredIcons(domain, problems) {
  const found = [];
  for (const home of [`https://www.${domain.replace(/^www\./, "")}/`, `https://${domain}/`]) {
    let html;
    try {
      html = (await download(home)).toString("utf8");
    } catch (e) {
      problems.push(`home page ${home}: ${e.message}`);
      continue;
    }
    const abs = (href) => { try { return new URL(href.replace(/&amp;/g, "&"), home).href; } catch { return null; } };
    const attr = (tag, name) => tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
    const sizeOf = (sizes) => Math.max(0, ...String(sizes ?? "").split(/\s+/).map((x) => parseInt(x, 10) || 0));
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
      const rel = (attr(tag, "rel") ?? "").toLowerCase();
      const href = attr(tag, "href");
      if (!href) continue;
      if (/(apple-touch-icon|icon)/.test(rel) && !rel.includes("mask")) { // mask-icon is a one-colour SVG
        const url = abs(href);
        if (url) found.push({ url, size: sizeOf(attr(tag, "sizes")) || (rel.includes("apple") ? 180 : 0), source: `page ${rel}` });
      } else if (rel === "manifest") {
        const url = abs(href);
        if (!url) continue;
        try {
          const manifest = JSON.parse((await download(url)).toString("utf8"));
          for (const icon of manifest.icons ?? []) {
            const iconUrl = icon?.src ? (() => { try { return new URL(icon.src, url).href; } catch { return null; } })() : null;
            if (iconUrl) found.push({ url: iconUrl, size: sizeOf(icon.sizes), source: "web manifest" });
          }
        } catch (e) {
          problems.push(`manifest: ${e.message}`);
        }
      }
    }
    if (found.length) break; // www worked; don't fetch the bare domain too
  }
  return found.sort((a, b) => b.size - a.size);
}

// ---------- main ----------
const list = JSON.parse(await readFile(FILE, "utf8"));
if (!Array.isArray(list)) throw new Error(`${FILE} must be a JSON array`);

// Validate + dedupe keys up front so a bad row fails before anything is written.
const seen = new Map();
const stores = [];
for (const [i, s] of list.entries()) {
  if (!s?.name) throw new Error(`Row ${i}: "name" is required`);
  const key = s.key ?? storeKeyOf(s.name);
  if (!/^[a-z0-9]{1,64}$/.test(key)) throw new Error(`Row ${i} (${s.name}): bad key "${key}"`);
  if (s.category && !CATEGORIES.includes(s.category)) throw new Error(`Row ${i} (${s.name}): unknown category "${s.category}"`);
  if (seen.has(key)) throw new Error(`Duplicate key "${key}": "${seen.get(key)}" and "${s.name}" — set an explicit "key" on one`);
  seen.set(key, s.name);
  if (!ONLY || ONLY.includes(key)) stores.push({ ...s, key });
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket();

console.log(`${DRY_RUN ? "[dry run] " : ""}Importing ${stores.length} stores from ${FILE}${OVERWRITE ? " (overwrite)" : ""}\n`);

const results = { created: [], updated: [], skipped: [], noLogo: [], failed: [] };

async function importOne(store) {
  const { key } = store;
  const ref = db.collection(COLLECTION).doc(key);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() : null;

  if (existing?.iconUrl && !OVERWRITE) {
    results.skipped.push(key);
    console.log(`  skip     ${key.padEnd(22)} already has a logo`);
    return;
  }

  let logo;
  try {
    logo = await resolveLogo(store, key);
  } catch (e) {
    results.noLogo.push(`${key} (${store.name}): ${e.message}`);
    console.log(`  no logo  ${key.padEnd(22)} ${e.message}`);
    return; // never create a store without a logo — getStoreIcons would hide it anyway
  }
  if (logo.buf.length > MAX_BYTES) {
    results.noLogo.push(`${key} (${store.name}): logo is ${(logo.buf.length / 1024).toFixed(0)} KB, over 1 MB`);
    return;
  }

  // Keep any aliases already added in the console; ours are appended.
  const aliases = [];
  const lower = new Set();
  for (const a of [...(existing?.aliases ?? []), ...(store.aliases ?? [])]) {
    const t = String(a).trim().slice(0, 80);
    if (t && !lower.has(t.toLowerCase())) { lower.add(t.toLowerCase()); aliases.push(t); }
  }

  const after = {
    name: store.name.trim().slice(0, 64),
    aliases: aliases.slice(0, 50),
    category: store.category ?? existing?.category ?? null,
  };

  if (DRY_RUN) {
    console.log(`  would ${existing ? "update" : "create"} ${key.padEnd(18)} ${after.name}  ← ${logo.source}`);
    (existing ? results.updated : results.created).push(key);
    return;
  }

  try {
    // Remove other-extension copies so only one logo per key lives in the bucket.
    const [old] = await bucket.getFiles({ prefix: `store-icons/${key}.` });
    const path = `store-icons/${key}.${logo.ext}`;
    await Promise.all(old.filter((f) => f.name !== path).map((f) => f.delete().catch(() => {})));

    const token = randomUUID();
    await bucket.file(path).save(logo.buf, {
      resumable: false,
      metadata: {
        contentType: logo.type,
        cacheControl: "public,max-age=86400",
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
    // Same URL format the console's getDownloadURL() returns (adminUpsertStore only accepts these).
    const iconUrl = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;

    await ref.set({ ...after, iconUrl, updatedAt: FieldValue.serverTimestamp(), updatedBy: BY }, { merge: true });
    await db.collection(AUDIT).add({
      action: existing ? "store.update" : "store.create",
      target: `${COLLECTION}/${key}`,
      before: existing ?? null,
      after: { ...after, iconUrl },
      by: BY,
      byUid: null,
      at: FieldValue.serverTimestamp(),
    });
    (existing ? results.updated : results.created).push(key);
    console.log(`  ${existing ? "updated" : "created"}  ${key.padEnd(22)} ${after.name}  ← ${logo.source}`);
  } catch (e) {
    results.failed.push(`${key}: ${e.message}`);
    console.log(`  FAILED   ${key.padEnd(22)} ${e.message}`);
  }
}

// Small worker pool: polite to the logo hosts, fast enough for a few hundred stores.
const queue = [...stores];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await importOne(queue.shift());
  }),
);

console.log(`
Done${DRY_RUN ? " (dry run — nothing written)" : ""}:
  created ${results.created.length}, updated ${results.updated.length}, skipped ${results.skipped.length}, no logo ${results.noLogo.length}, failed ${results.failed.length}`);
if (results.noLogo.length) {
  console.log(`\nNo usable logo — save one as scripts/data/logos/<key>.png (square, ≥${MIN_PX}px, <1 MB) and re-run:`);
  for (const line of results.noLogo) console.log(`  - ${line}`);
}
if (results.failed.length) {
  console.log("\nFailed:");
  for (const line of results.failed) console.log(`  - ${line}`);
  process.exitCode = 1;
}
