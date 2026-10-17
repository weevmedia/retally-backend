# ReTally backend — Firestore

| file | purpose |
|---|---|
| `SCHEMA.md` | The data model. Read this first; everything else implements it. |
| `firestore.rules` | Owner-only access, field validation, PII guard. |
| `firestore.indexes.json` | Composite + vector indexes for the app and AI queries. |
| `storage.rules` | Receipt images, owner-only, 8 MB cap. |
| `scripts/provision.mjs` | Writes the schema registry, seeds merchants/products, optional demo tree. |

## First-time setup
```bash
npm i -g firebase-tools
firebase login
cd backend/firestore
firebase use --add            # pick the ReTally project you created
npm install
```

## Try it locally first
```bash
npm run emulators             # Auth + Firestore + Storage emulators, UI at http://localhost:4000
npm run provision:emulator    # in a second terminal: schema + catalogs + demo user
```

## Deploy to the real project
```bash
npm run deploy                # rules + indexes + storage rules
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json npm run provision
```
Vector indexes take a few minutes to build; `firebase firestore:indexes` shows status.
Never commit `serviceAccount.json` (it is in `.gitignore`).

## Free-tier notes
Spark plan covers: 1 GiB Firestore, 50k reads / 20k writes / 20k deletes per day, 5 GB Storage.
A receipt with 20 line items costs ~22 writes, so ~900 receipts/day before you pay anything.
Vector search and the BigQuery export extension need the Blaze (pay-as-you-go) plan, which
still has the same free allowances — you only pay above them.
