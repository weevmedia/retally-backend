# ReTally Firestore data model (v1)

Firestore is a document database, so there is no DDL. This file **is** the schema: the app,
the Cloud Functions and the AI jobs all follow it, `firestore.rules` enforces who may touch
what, `firestore.indexes.json` declares the queries we promise to support, and
`scripts/provision.mjs` writes the schema registry document plus reference data.

Design goals, in order: (1) a user can only ever read their own tree; (2) every line item is
queryable **across all users** with a single collection-group query, which is what the AI
jobs need; (3) raw OCR text is kept (training data) but payment identifiers never are;
(4) per-user aggregates are precomputed so "what should I buy this week" is a read, not a scan.

```
/_schema/v1                                 ← registry: version + collection list (read-only)
/users/{uid}                                ← profile & settings           (owner r/w)
/users/{uid}/receipts/{receiptId}           ← one scanned receipt          (owner r/w)
/users/{uid}/receipts/{receiptId}/lineItems/{lineId}   ← one row on it     (owner r/w)
/users/{uid}/purchasePatterns/{productId}   ← per-user, per-product stats  (owner r, functions w)
/users/{uid}/insights/{insightId}           ← AI output shown in the app   (owner r, functions w)
/accounts/{uid}                             ← plan, entitlements, devices  (owner r, functions w)
/merchants/{merchantId}                     ← canonical store catalog      (all r, functions w)
/products/{productId}                       ← canonical product catalog    (all r, functions w)
```

## users/{uid}
Document id = Firebase Auth uid. One per signed-in user; anonymous auth users get one too so
their receipts survive a reinstall once they link an email.

| field | type | notes |
|---|---|---|
| displayName | string? | from the auth provider, editable |
| email | string? | lower-cased; null for anonymous |
| photoUrl | string? | |
| locale | string | BCP-47, e.g. `en-US`; drives currency/date parsing |
| currency | string | ISO-4217 default for new receipts |
| timeZone | string | IANA, e.g. `America/Chicago` |
| settings.cloudBackup | bool | user turned on sync |
| settings.aiPersonalization | bool | consent to use their receipts for their own insights |
| settings.adsPersonalized | bool | mirrors UMP consent for reporting |
| stats.receiptCount | int | maintained by function `onReceiptWrite` |
| stats.lineItemCount | int | |
| stats.totalSpent | number | in `currency` |
| stats.totalOvercharge | number | money the app caught |
| stats.lastReceiptAt | timestamp? | |
| createdAt / updatedAt | timestamp | server timestamps |
| schemaVersion | int | 1 |

## accounts/{uid}
Separated from the profile because it is written by billing/functions, never by the client.

| field | type | notes |
|---|---|---|
| plan | `free` \| `pro` | |
| entitlements | map<string,bool> | `cloudBackup`, `aiInsights`, `adFree`, `exportCsv` |
| billing.provider | `none` \| `play` \| `appstore` | |
| billing.productId | string? | store SKU |
| billing.renewsAt / expiresAt | timestamp? | |
| devices | array<map> | `{deviceId, platform, appVersion, lastSeenAt}` capped at 10 |
| authProviders | array<string> | `google.com`, `apple.com`, `anonymous` |
| dataRetentionDays | int | default 730; drives the purge job |
| deletionRequestedAt | timestamp? | set by "delete my account"; purge after 30 d |
| createdAt / updatedAt | timestamp | |

## users/{uid}/receipts/{receiptId}
Document id = the app's `Receipt.id` (client-generated UUID) so offline edits merge cleanly.

| field | type | notes |
|---|---|---|
| storeName | string | exactly as printed |
| merchantId | string? | → `/merchants/{merchantId}` after normalization |
| merchantNameNormalized | string | lower-case, punctuation stripped; queryable before merchantId exists |
| purchaseDate | timestamp | from the receipt; falls back to scan time |
| purchaseDateLocal | string | `YYYY-MM-DD` in the user's zone; lets grouping/aggregation skip TZ math |
| currency | string | ISO-4217 |
| subtotal / tax / total | number | `total` is what was charged |
| lineItemCount | int | mirrors the subcollection size |
| paymentMethod | `card` \| `cash` \| `mobile` \| `unknown` | **category only — no card numbers, no last-4** |
| analysis.duplicateCount | int | |
| analysis.overchargeAmount | number | sum of duplicate rows |
| analysis.flags | array<string> | `duplicate_line`, `price_mismatch`, `total_mismatch`, `tax_anomaly` |
| analysis.confidence | number 0-1 | parser confidence |
| categoryTotals | map<string,number> | `grocery: 42.10, household: 8.99` — feeds spend breakdowns |
| image.storagePath | string? | `users/{uid}/receipts/{receiptId}.jpg` in Cloud Storage |
| image.thumbnailPath | string? | |
| ocr.rawText | string | full recognizer output, PII-scrubbed (see below) |
| ocr.engine | string | `mlkit` \| `vision` |
| ocr.appVersion | string | for re-parsing old receipts with a better parser |
| ocr.piiScrubbed | bool | must be true before write; rules reject otherwise |
| embedding | vector(768)? | receipt-level embedding (store + items); written by function |
| source | `scan` \| `manual` \| `import` | |
| deviceId | string | |
| createdAt / updatedAt / deletedAt | timestamp | soft delete: keep 30 d for undo, then purge |
| schemaVersion | int | |

## users/{uid}/receipts/{receiptId}/lineItems/{lineId}
Document id = the app's `ReceiptItem.id`. This is the AI training table; every row is
reachable with `collectionGroup("lineItems")`.

| field | type | notes |
|---|---|---|
| uid | string | **denormalized** — required for collection-group queries and rules |
| receiptId | string | denormalized |
| merchantId | string? | denormalized |
| purchaseDate | timestamp | denormalized so cross-user time-series need no join |
| position | int | order on the receipt |
| rawDescription | string | exactly as printed, e.g. `ORG BNNA 2LB` |
| itemNumber | string? | SKU/PLU as printed |
| normalizedName | string | `organic bananas` — function-written, lower-case |
| productId | string? | → `/products/{productId}` |
| category | string | taxonomy below |
| brand | string? | |
| quantity | number | default 1 |
| unit | `each` \| `kg` \| `lb` \| `l` \| `oz` \| `pack` | |
| unitPrice | number | |
| lineTotal | number | quantity × unitPrice minus discounts |
| discount | number | 0 if none |
| taxable | bool? | |
| isDuplicate | bool | what ReTally flags |
| duplicateOfLineId | string? | the row it duplicates |
| userCorrected | bool | user edited name/price — the highest-value training signal |
| categoryCorrected | bool | shopper picked `category` by hand — AI/keyword tagging never changes it |
| currency | string | denormalized |
| embedding | vector(768)? | of `rawDescription` → product matching |
| createdAt / updatedAt | timestamp | |

## users/{uid}/purchasePatterns/{productId}
Precomputed by `onLineItemWrite`; the shopping-list model reads this, not raw items.

| field | type | notes |
|---|---|---|
| productId / normalizedName / category | | |
| purchaseCount | int | |
| firstPurchasedAt / lastPurchasedAt | timestamp | |
| avgIntervalDays | number? | mean gap between purchases (needs ≥ 2) |
| avgQuantity / avgUnitPrice | number | |
| minUnitPrice / maxUnitPrice | number | + `cheapestMerchantId` |
| merchantCounts | map<string,int> | where they buy it |
| predictedNextPurchaseAt | timestamp? | `lastPurchasedAt + avgIntervalDays` |
| predictionConfidence | number 0-1 | |
| updatedAt | timestamp | |

## users/{uid}/insights/{insightId}
Everything the AI says to the user is stored, with provenance, so it can be audited and
so thumbs-up/down becomes training feedback.

| field | type | notes |
|---|---|---|
| type | `shopping_list` \| `price_alert` \| `monthly_summary` \| `duplicate_pattern` \| `budget_tip` | |
| title / body | string | rendered in the app |
| payload | map | typed per `type`, e.g. shopping_list → `items: [{productId, name, qty, reason}]` |
| model / promptVersion | string | e.g. `gemini-1.5-flash`, `sl-v3` |
| inputWindow.from / to | timestamp | which receipts it was computed from |
| status | `new` \| `seen` \| `dismissed` \| `acted` | |
| feedback | `up` \| `down` \| null | |
| generatedAt / expiresAt | timestamp | |

## merchants/{merchantId}
| field | type | notes |
|---|---|---|
| name | string | canonical display name |
| aliases | array<string> | normalized strings seen on receipts (`wal-mart`, `walmart supercenter`) |
| category | `grocery` \| `pharmacy` \| `warehouse` \| `restaurant` \| `fuel` \| `retail` \| `other` | |
| country | string? | ISO-3166 |
| logoUrl | string? | |
| receiptCount | int | popularity, function-maintained |

## products/{productId}
| field | type | notes |
|---|---|---|
| name | string | canonical, e.g. `Organic Bananas` |
| normalizedName | string | |
| aliases | array<string> | raw descriptions that map here |
| category / subcategory | string | |
| brand | string? | |
| defaultUnit | string | |
| priceStats | map<merchantId, {avg, min, max, n, updatedAt}> | cross-user price index → price alerts |
| embedding | vector(768) | for nearest-neighbour matching of new raw descriptions |
| updatedAt | timestamp | |

## Category taxonomy (v1)
`grocery.produce`, `grocery.dairy`, `grocery.meat`, `grocery.bakery`, `grocery.pantry`,
`grocery.frozen`, `grocery.beverages`, `grocery.snacks`, `household`, `personal_care`,
`baby`, `pet`, `pharmacy`, `electronics`, `clothing`, `restaurant`, `fuel`, `fees`, `other`.
Store the dotted string in `category`; query prefix with `>= "grocery."` and `< "grocery/"`.

## PII rules (enforced in the parser and in `firestore.rules`)
Before a receipt is written, `ocr.rawText` and `lineItems.rawDescription` must have card
numbers (`\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}`, `****1234`, `XXXX 1234`), auth codes,
loyalty ids and phone numbers replaced with `[REDACTED]`. `paymentMethod` is a category
only. The rules reject a receipt whose `ocr.piiScrubbed` is not `true`.

## How the AI jobs use this
* **Product normalization**: new `lineItems.rawDescription` → embedding → KNN on
  `products.embedding` → set `productId`, `normalizedName`, `category`. Human corrections
  (`userCorrected = true`) are appended to `products.aliases`.
* **Shopping list** (`functions/src/shopping`, signed-in users only): receipts from the last
  180 days → generic items by string/partial match (`organic bananas` = `ORG BNNA` = `banana`),
  Gemini names only the lines that stay unresolved (cached in `/itemAliases/{sha256(raw)}`) →
  per-item interval/price/store stats and per-store profiles → Gemini decides each store's list
  (validated; arithmetic fallback) → `insights/shopping_list_{storeKey}` with
  `payload: {storeKey, storeName, dueHere[], alsoHere[], frequent[], usualShoppingDay, decidedBy}`.
  Rebuilt after receipts sync (debounced 3 min), every morning at 7:00 local, and on demand via
  the `getShoppingList({storeName?})` callable. Job state: `/shoppingListJobs/{uid}`
  (function-only).
* **Price alerts**: compare `lineItems.unitPrice` with `products.priceStats[merchantId].avg`.
* **Training exports**: enable the *Stream Firestore to BigQuery* extension on
  `users/{uid}/receipts/{receiptId}/lineItems` for SQL analytics over all rows.

## Food recalls (not stored)

Recalls are public data and are **not** kept in Firestore. `getRecalls` fetches the FDA recalls
RSS feed (food only; drug/device/cosmetic items filtered out) and the USDA FSIS Recall API live,
keeps the last 60 days (max 50, newest first) in function memory for 6 hours, and flags
"you may have bought this" against the signed-in shopper's recent line items. The old
`/recalls` and `/recallsMeta` collections are no longer read or written and can be deleted.

## users/{uid}/insights/priceDrops  (functions w)

Written daily by `processPriceDrops` (05:30 America/New_York). Items the user bought in the
last 30 days that newer ReTally receipts — from any shopper — show cheaper at the same store
chain (matched by printed item number, else printed description). Served to the app as
`price_drop` nudges by `getNudges`; ignored once older than 3 days or 30 days past purchase.

| field | type | notes |
|---|---|---|
| type | string | `price_drops` |
| drops | array | `{ id, receiptId, storeName, item, paid, current, drop, purchasedAt, seenAt }` (ms times), biggest drop first, max 5 |
| generatedAt | timestamp | run time |

`system/priceDrops` holds `{ uids, ranAt, lines }` so users whose drops ended get their doc removed.
Needs collection-group indexes on `receipts.purchaseDate` and `lineItems.purchaseDate` (see firestore.indexes.json).

## itemAliases/{sha256(raw lower-cased)}  (functions only)

Shared cache per distinct receipt line text. `name` (generic product name, null = not a product)
is written by the Smart List naming pass; `category` (+ `categoryModel`, `categorizedAt`) by the
`categorizeItems` callable. Both write with merge, so neither overwrites the other.
Categories: grocery, household, personal_care, health, baby, pet, alcohol, electronics, clothing,
home, other (the app adds `uncategorized` for lines not classified yet).

## users/{uid}/devices/{installationId}  (functions w, owner r)

One doc per app install, written by the `registerDevice` callable on sign-in (guests too) and at
most daily after. `installationId` is a random id the app makes on first launch, so a reinstall
shows up as a new device.

| field | type | notes |
|---|---|---|
| uid | string | owner (denormalized for the admin collection-group read) |
| installationId | string | same as the doc id |
| platform | string | `android` \| `ios` |
| model | string | e.g. `Google Pixel 8`, `iPhone15,2` |
| osVersion | string | e.g. `15`, `18.1` |
| appVersion | string | e.g. `1.4.0 (42)` |
| firstSeenAt | timestamp | first registration |
| lastSeenAt | timestamp | latest registration |

`deviceOwners/{installationId}` → `{ uid, updatedAt }` (functions only) tracks the current owner;
signing into another account on the same phone moves the device there.
