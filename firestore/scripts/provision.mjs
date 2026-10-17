#!/usr/bin/env node
/**
 * ReTally Firestore provisioning — the "CREATE" script for a database that has no DDL.
 *
 * What it does (idempotent, safe to re-run):
 *   1. Writes /_schema/v1 — the registry the app and functions check on startup.
 *   2. Seeds /merchants and /products reference data so normalization has something to match.
 *   3. With --demo, creates one demo user tree (users/accounts/receipts/lineItems/
 *      purchasePatterns/insights) so every collection exists and the indexes can build.
 *      Never run --demo against production.
 *
 * Auth: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON from
 *       Firebase console → Project settings → Service accounts, or run against the emulator
 *       with FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 (no credentials needed).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa.json node scripts/provision.mjs
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/provision.mjs --demo
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const DEMO = process.argv.includes("--demo");
const SCHEMA_VERSION = 1;
const EMBEDDING_DIM = 768;

initializeApp(
  process.env.FIRESTORE_EMULATOR_HOST
    ? { projectId: process.env.GCLOUD_PROJECT ?? "retally-dev" }
    : { credential: applicationDefault() },
);
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

const now = FieldValue.serverTimestamp();

// ---------------------------------------------------------------------------------------------
// 1. Schema registry
// ---------------------------------------------------------------------------------------------
async function writeSchemaRegistry() {
  await db.doc(`_schema/v${SCHEMA_VERSION}`).set(
    {
      version: SCHEMA_VERSION,
      embeddingDimension: EMBEDDING_DIM,
      collections: {
        users: "profile & settings; owner r/w",
        "users/{uid}/receipts": "scanned receipts; owner r/w, soft-delete",
        "users/{uid}/receipts/{id}/lineItems": "rows; collection-group queryable; AI training table",
        "users/{uid}/purchasePatterns": "per-product aggregates; functions write",
        "users/{uid}/insights": "AI output; functions write, client sets status/feedback",
        accounts: "plan/entitlements/devices; functions write",
        merchants: "canonical stores; public read",
        products: "canonical products with embeddings; public read",
      },
      categories: [
        "grocery.produce", "grocery.dairy", "grocery.meat", "grocery.bakery", "grocery.pantry",
        "grocery.frozen", "grocery.beverages", "grocery.snacks", "household", "personal_care",
        "baby", "pet", "pharmacy", "electronics", "clothing", "restaurant", "fuel", "fees", "other",
      ],
      paymentMethods: ["card", "cash", "mobile", "unknown"],
      units: ["each", "kg", "lb", "l", "oz", "pack"],
      insightTypes: ["shopping_list", "price_alert", "monthly_summary", "duplicate_pattern", "budget_tip"],
      updatedAt: now,
    },
    { merge: true },
  );
  console.log(`✔ _schema/v${SCHEMA_VERSION}`);
}

// ---------------------------------------------------------------------------------------------
// 2. Reference data
// ---------------------------------------------------------------------------------------------
const MERCHANTS = [
  { id: "walmart", name: "Walmart", aliases: ["walmart", "wal-mart", "walmart supercenter", "walmart neighborhood market"], category: "grocery", country: "US" },
  { id: "target", name: "Target", aliases: ["target"], category: "retail", country: "US" },
  { id: "costco", name: "Costco Wholesale", aliases: ["costco", "costco wholesale"], category: "warehouse", country: "US" },
  { id: "kroger", name: "Kroger", aliases: ["kroger"], category: "grocery", country: "US" },
  { id: "heb", name: "H-E-B", aliases: ["heb", "h-e-b", "h e b"], category: "grocery", country: "US" },
  { id: "aldi", name: "ALDI", aliases: ["aldi"], category: "grocery", country: "US" },
  { id: "traderjoes", name: "Trader Joe's", aliases: ["trader joes", "trader joe's"], category: "grocery", country: "US" },
  { id: "wholefoods", name: "Whole Foods Market", aliases: ["whole foods", "whole foods market", "wfm"], category: "grocery", country: "US" },
  { id: "cvs", name: "CVS Pharmacy", aliases: ["cvs", "cvs pharmacy"], category: "pharmacy", country: "US" },
  { id: "walgreens", name: "Walgreens", aliases: ["walgreens"], category: "pharmacy", country: "US" },
  { id: "homedepot", name: "The Home Depot", aliases: ["home depot", "the home depot"], category: "retail", country: "US" },
];

const PRODUCTS = [
  { id: "bananas", name: "Bananas", aliases: ["bananas", "banana", "bnna", "org bnna", "organic bananas"], category: "grocery.produce", defaultUnit: "lb" },
  { id: "whole-milk-1gal", name: "Whole Milk (1 gal)", aliases: ["whole milk", "milk whole gal", "gv whole milk", "milk 1 gal"], category: "grocery.dairy", defaultUnit: "each" },
  { id: "eggs-12", name: "Eggs (dozen)", aliases: ["eggs", "large eggs", "lg eggs 12ct", "eggs 12 ct"], category: "grocery.dairy", defaultUnit: "pack" },
  { id: "bread-white", name: "White Bread", aliases: ["bread", "white bread", "sandwich bread"], category: "grocery.bakery", defaultUnit: "each" },
  { id: "chicken-breast", name: "Chicken Breast", aliases: ["chicken breast", "chkn brst", "bnls chicken breast"], category: "grocery.meat", defaultUnit: "lb" },
  { id: "rice-basmati", name: "Basmati Rice", aliases: ["basmati rice", "rice basmati", "bsmti rice"], category: "grocery.pantry", defaultUnit: "lb" },
  { id: "paper-towels", name: "Paper Towels", aliases: ["paper towels", "ppr twls", "bounty"], category: "household", defaultUnit: "pack" },
  { id: "toothpaste", name: "Toothpaste", aliases: ["toothpaste", "crest", "colgate"], category: "personal_care", defaultUnit: "each" },
  { id: "bottled-water-24", name: "Bottled Water (24 pk)", aliases: ["water 24pk", "bottled water", "purified water 24"], category: "grocery.beverages", defaultUnit: "pack" },
  { id: "dish-soap", name: "Dish Soap", aliases: ["dish soap", "dawn", "dish liquid"], category: "household", defaultUnit: "each" },
];

async function seedCatalogs() {
  const batch = db.batch();
  for (const m of MERCHANTS) {
    batch.set(db.doc(`merchants/${m.id}`), { ...m, id: undefined, receiptCount: 0, updatedAt: now }, { merge: true });
  }
  for (const p of PRODUCTS) {
    batch.set(
      db.doc(`products/${p.id}`),
      {
        ...p,
        id: undefined,
        normalizedName: p.name.toLowerCase(),
        priceStats: {},
        // embedding is filled by the normalization function (Vertex/Gemini text-embedding, 768-d).
        updatedAt: now,
      },
      { merge: true },
    );
  }
  await batch.commit();
  console.log(`✔ ${MERCHANTS.length} merchants, ${PRODUCTS.length} products`);
}

// ---------------------------------------------------------------------------------------------
// 3. Demo user tree (emulator / dev only)
// ---------------------------------------------------------------------------------------------
async function seedDemoUser() {
  const uid = "demo-user";
  const receiptId = "rcpt-demo-0001";
  const purchase = Timestamp.fromDate(new Date("2026-09-12T18:41:00Z"));

  const items = [
    { id: "li-1", position: 0, rawDescription: "ORG BNNA 2.31LB", productId: "bananas", normalizedName: "bananas", category: "grocery.produce", quantity: 2.31, unit: "lb", unitPrice: 0.69, lineTotal: 1.59, isDuplicate: false },
    { id: "li-2", position: 1, rawDescription: "GV WHOLE MILK GAL", productId: "whole-milk-1gal", normalizedName: "whole milk (1 gal)", category: "grocery.dairy", quantity: 1, unit: "each", unitPrice: 3.48, lineTotal: 3.48, isDuplicate: false },
    { id: "li-3", position: 2, rawDescription: "LG EGGS 12CT", productId: "eggs-12", normalizedName: "eggs (dozen)", category: "grocery.dairy", quantity: 1, unit: "pack", unitPrice: 2.97, lineTotal: 2.97, isDuplicate: false },
    { id: "li-4", position: 3, rawDescription: "LG EGGS 12CT", productId: "eggs-12", normalizedName: "eggs (dozen)", category: "grocery.dairy", quantity: 1, unit: "pack", unitPrice: 2.97, lineTotal: 2.97, isDuplicate: true, duplicateOfLineId: "li-3" },
    { id: "li-5", position: 4, rawDescription: "BOUNTY PPR TWLS 6", productId: "paper-towels", normalizedName: "paper towels", category: "household", quantity: 1, unit: "pack", unitPrice: 12.98, lineTotal: 12.98, isDuplicate: false },
  ];
  const subtotal = round2(items.reduce((s, i) => s + i.lineTotal, 0));
  const tax = round2(subtotal * 0.0825);
  const total = round2(subtotal + tax);
  const overcharge = round2(items.filter((i) => i.isDuplicate).reduce((s, i) => s + i.lineTotal, 0));
  const categoryTotals = {};
  for (const i of items) categoryTotals[i.category] = round2((categoryTotals[i.category] ?? 0) + i.lineTotal);

  const batch = db.batch();

  batch.set(db.doc(`users/${uid}`), {
    displayName: "Demo Shopper",
    email: "demo@example.com",
    photoUrl: null,
    locale: "en-US",
    currency: "USD",
    timeZone: "America/Chicago",
    settings: { cloudBackup: true, aiPersonalization: true, adsPersonalized: false },
    stats: { receiptCount: 1, lineItemCount: items.length, totalSpent: total, totalOvercharge: overcharge, lastReceiptAt: purchase },
    createdAt: now, updatedAt: now, schemaVersion: SCHEMA_VERSION,
  });

  batch.set(db.doc(`accounts/${uid}`), {
    plan: "free",
    entitlements: { cloudBackup: true, aiInsights: true, adFree: false, exportCsv: false },
    billing: { provider: "none", productId: null, renewsAt: null, expiresAt: null },
    devices: [{ deviceId: "emulator-1", platform: "android", appVersion: "1.0 (1)", lastSeenAt: purchase }],
    authProviders: ["anonymous"],
    dataRetentionDays: 730,
    deletionRequestedAt: null,
    createdAt: now, updatedAt: now,
  });

  batch.set(db.doc(`users/${uid}/receipts/${receiptId}`), {
    storeName: "Walmart Supercenter",
    merchantId: "walmart",
    merchantNameNormalized: "walmart supercenter",
    purchaseDate: purchase,
    purchaseDateLocal: "2026-09-12",
    currency: "USD",
    subtotal, tax, total,
    lineItemCount: items.length,
    paymentMethod: "card",
    analysis: { duplicateCount: 1, overchargeAmount: overcharge, flags: ["duplicate_line"], confidence: 0.92 },
    categoryTotals,
    image: { storagePath: `receipts/${uid}/${receiptId}.jpg`, thumbnailPath: null },
    ocr: {
      rawText: "WALMART SUPERCENTER\nORG BNNA 2.31LB 1.59\nGV WHOLE MILK GAL 3.48\nLG EGGS 12CT 2.97\nLG EGGS 12CT 2.97\nBOUNTY PPR TWLS 6 12.98\nSUBTOTAL 23.99\nTAX 1.98\nTOTAL 25.97\nVISA [REDACTED]",
      engine: "mlkit", appVersion: "1.0 (1)", piiScrubbed: true,
    },
    source: "scan",
    deviceId: "emulator-1",
    createdAt: now, updatedAt: now, deletedAt: null, schemaVersion: SCHEMA_VERSION,
  });

  for (const i of items) {
    const { id, ...rest } = i;
    batch.set(db.doc(`users/${uid}/receipts/${receiptId}/lineItems/${id}`), {
      uid, receiptId, merchantId: "walmart", purchaseDate: purchase,
      ...rest,
      itemNumber: null, brand: null, discount: 0, taxable: true,
      duplicateOfLineId: rest.duplicateOfLineId ?? null,
      userCorrected: false, currency: "USD",
      createdAt: now, updatedAt: now,
    });
  }

  // What onLineItemWrite would compute for this user.
  batch.set(db.doc(`users/${uid}/purchasePatterns/eggs-12`), {
    productId: "eggs-12", normalizedName: "eggs (dozen)", category: "grocery.dairy",
    purchaseCount: 1, firstPurchasedAt: purchase, lastPurchasedAt: purchase,
    avgIntervalDays: null, avgQuantity: 1, avgUnitPrice: 2.97, minUnitPrice: 2.97, maxUnitPrice: 2.97,
    cheapestMerchantId: "walmart", merchantCounts: { walmart: 1 },
    predictedNextPurchaseAt: null, predictionConfidence: 0, updatedAt: now,
  });

  batch.set(db.doc(`users/${uid}/insights/ins-demo-0001`), {
    type: "duplicate_pattern",
    title: "Eggs were charged twice",
    body: "Your Walmart receipt on Sep 12 has LG EGGS 12CT twice. That's $2.97 you can claim back at customer service.",
    payload: { receiptId, lineItemIds: ["li-3", "li-4"], amount: overcharge },
    model: "rules-v1", promptVersion: null,
    inputWindow: { from: purchase, to: purchase },
    status: "new", feedback: null,
    generatedAt: now, expiresAt: null, updatedAt: now,
  });

  await batch.commit();
  console.log(`✔ demo user ${uid} (1 receipt, ${items.length} line items, 1 pattern, 1 insight)`);
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------
(async () => {
  console.log(`Provisioning ReTally schema v${SCHEMA_VERSION} → ${process.env.FIRESTORE_EMULATOR_HOST ? "EMULATOR" : "cloud project"}`);
  await writeSchemaRegistry();
  await seedCatalogs();
  if (DEMO) {
    if (!process.env.FIRESTORE_EMULATOR_HOST && !process.argv.includes("--i-know-this-is-not-prod")) {
      console.warn("↷ skipping --demo against a cloud project (add --i-know-this-is-not-prod to force)");
    } else {
      await seedDemoUser();
    }
  }
  console.log("done");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
