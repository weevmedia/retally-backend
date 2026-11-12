# ReTally API reference (local only)

Swagger UI for every Cloud Function, from `openapi.yaml`. It lives outside
`firestore/hosting/`, so `firebase deploy --only hosting` never publishes it.

## View it

From the repo root:

```bash
python3 -m http.server 8088 --bind 127.0.0.1 --directory docs/api
```

Then open http://localhost:8088 (Ctrl+C to stop). Bound to 127.0.0.1, so it isn't
reachable from other machines on your network.

Opening `index.html` straight from Finder doesn't work: the browser blocks loading
`openapi.yaml` from a `file://` page.

## Keep it current

The spec is written by hand. When you add or change a function in `functions/src`,
update `openapi.yaml` too.
