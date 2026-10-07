# Merchant server, client and demos

Status: implemented and tested locally in dev mode, including a real browser run of
both demo merchants. No Mainnet payment has been processed yet. This covers the
lead's components (guide §§9–12, 14, 15); zwatch and the matcher are documented in
[watcher-api.md](watcher-api.md).

## Packages

| Package | Role |
| --- | --- |
| `@ghostpass/core` | Browser-safe helpers shared by both sides: canonical base64url and base32, `buildZip321`, plans, GP1 memos, monthly periods, the `Authorization: Ghostpass` header, the `KEYS.json` format |
| `@ghostpass/server` | `createGhostpass(config)`: an Express router plus `requireGhostpass()`, `startSession`, `requireSession()`, `start()` and `stop()` |
| `@ghostpass/client` | `GhostpassClient` (checkout, issuance, token wallet, `ghostFetch`) and `mountCheckout` (the checkout widget) |
| `@ghostpass/demo-web` | Environment configuration, page layout, security headers and asset bundling for the demo apps |

Adding Ghostpass to an Express API:

```ts
const gp = createGhostpass({ db, merchantName, merchantAddress, plans, kek, keyLogPath, payments });
await gp.start();
app.use(gp.router);
app.get('/api/v1/price', gp.requireGhostpass(), handler);
```

## Endpoints

| Method | Path | Request → response |
| --- | --- | --- |
| GET | `/.well-known/ghostpass.json` | `{v: 1, merchant, current, keys: [{period, spki, redeemUntil}], plans: [{id, label, amountZec, tokens, mode}]}`; keys are the redeemable ones up to the current period, oldest first |
| POST | `/v1/checkout` | `{plan}` → `{claimCode, uri, address, amountZec, memo, expiresAt}` |
| GET | `/v1/checkout/:claimCode` | `{status, paidZec, confirmations}`; an unpaid checkout past `expiresAt` reports `EXPIRED` immediately |
| POST | `/v1/issue` | `{claimCode, period, blinded: [base64url]}` → `{period, blindSigs: [base64url]}` |
| POST | `/dev/pay/:claimCode` | Dev mode only. Optional `{zat: "<decimal>"}` pays part of the price; otherwise the full price |
| any | routes behind `requireGhostpass()` | `Authorization: Ghostpass v=1, period=YYYY-MM, msg=<base64url>, sig=<base64url>` |

Errors are JSON `{error: "code"}`. Issuance returns `400 bad_count` (with `expected`),
`400 invalid_blinded`, `404 unknown_claim`, `409 period_changed` (with `current`),
`409 not_confirmed_or_already_issued`, `500 issue_failed`, or `503 issuer_key_unavailable`.
The redeemer returns `401` with `WWW-Authenticate: Ghostpass realm="<merchant>", keys="/.well-known/ghostpass.json"`
and `payment_required`, `invalid_token` or `token_already_spent`; it returns `503` if its database fails.
`requireSession()` redirects (303) or returns `401 session_required`.

## Protocol details

- **Keys:** one RSA-2048 key per UTC month, RSABSSA-SHA384-PSS-Randomized. Keys for the
  current and the next month are created at startup and hourly, so the next month's
  key hash can be published before it is needed. Private keys are sealed with
  AES-256-GCM under `GP_KEK_HEX`, with the period as associated data.
- **Tokens:** the client signs a 32-byte random nonce; randomized preparation adds a
  32-byte prefix, so a token message is exactly 64 bytes and a signature 256 bytes.
  Tokens of period P are accepted until 00:00 UTC on the 15th of the following month.
- **Issuance:** the checkout moves from `CONFIRMED` to `ISSUED` atomically before
  signing. The blind signatures are stored for 24 hours under a hash of the request,
  so a subscriber whose response was lost retries the identical request and receives
  the same signatures. A signing failure, or a crash before signatures are stored,
  returns the checkout to `CONFIRMED`. The client saves its blinded request before
  sending it, and re-blinds only after `409 period_changed`.
- **Key log:** `KEYS.json` is `{v: 1, keys: [{merchant, period, spkiSha256}]}`. The
  server appends new entries and refuses to start if a logged merchant and month has a
  different key. The client accepts a key only if exactly one entry matches the merchant
  and month and its hash equals the served key; `finalize()` then verifies every
  signature under that key.
- **Sessions:** one token buys a 24-hour `gp_s` cookie (`HttpOnly`, `SameSite=Strict`,
  `Secure` in real mode). Only the SHA-256 of the session ID is stored.
- **Cleanup (hourly):** expired sessions, spent-token hashes for periods past their
  redeem window, and stored issuance responses older than 24 hours.

## Configuration

`pnpm dev` needs no configuration. `pnpm start:demo` reads `.env`:

| Setting | Meaning |
| --- | --- |
| `MERCHANT_UA` | Shielded Unified Address in every checkout (written by `pnpm setup:wallet`) |
| `ZWATCH_URL`, `ZWATCH_API_TOKEN`, `MERCHANT_ACCOUNT_ID` | Loopback zwatch the matcher polls |
| `GP_KEK_HEX` | 32-byte hex key-encryption key for issuer private keys |
| `GP_KEYS_URL` | `https` URL of the public `KEYS.json` that browsers check |
| `GP_KEYS_LOG` | Local `KEYS.json` the merchants append to (default `KEYS.json`) |
| `GP_ADMIN_PASSWORD` | Dashboard password, 16+ characters |
| `GP_NEWSLETTER_DB`, `GP_API_DEMO_DB` | Database paths (default `.local/<app>.sqlite`) |
| `GP_HOST`, `NEWSLETTER_PORT`, `API_DEMO_PORT`, `DASHBOARD_PORT` | Bind address (default `127.0.0.1`) and ports (3000–3002) |
| `GP_DEV_FAKE_PAYMENTS` | `1` enables simulated payments; refused with `NODE_ENV=production` |

Both demo merchants use the same wallet and zwatch account. Each database credits
only its own claim codes.

## Deployment notes

- Run zwatch and the demos on one host, bound to `127.0.0.1`, behind a TLS reverse
  proxy. The apps trust `X-Forwarded-*` only from loopback. Configure the proxy not to
  log IP addresses; the apps log no requests.
- After first start, and whenever a new month's key appears, commit `KEYS.json` to
  the public repository before subscribers need that key. Raw GitHub files are cached
  for a few minutes.
- Back up each merchant database together with `GP_KEK_HEX`. A lost database means new
  keys for months already logged, and the server refuses to start rather than serve
  keys that browsers would reject.
- Run one process per merchant database. Merchants that share a `GP_KEYS_LOG` file
  must run in the same process (as `pnpm start:demo` does), which serializes appends.

## Where this departs from the guide

| Guide | Implementation | Reason |
| --- | --- | --- |
| `suite.blindSign` from blindrsa-ts | OpenSSL raw RSA with RFC 9474's `m == m'` check | The library's pure-JS signing took about 330 ms per token, blocking the server for over 30 s per 100-token issuance. A test checks the output is byte-identical to the library's |
| One merchant offering both plans | Two merchants with separate databases and keys | With one key, cheap API tokens could open newsletter sessions |
| Claim marked `ISSUED` before signing, no recovery | Stored responses, idempotent retry, and release on failure or restart | A lost response would otherwise cost the subscriber the pass |
| `KEYS.json` as a list of hashes | Exactly one entry per merchant and month, next month pre-generated | A list alone would let a merchant log one key per subscriber |
| Payments keyed by `(txid, out_index)` | `(txid, pool, out_index)` from the matcher | Output indexes repeat across shielded pools |
| `/dev/pay` inserts a payment row | Simulated outputs are fed to the real matcher | The matcher rebuilds the ledger from each snapshot, so inserted rows would be erased |
| Next.js demo apps | Express with server-rendered pages and one bundled script | The redeemer and session middleware are Express handlers; no extra framework is needed |
| First-use delay 1–10 minutes | Same in real mode; 5–15 seconds in dev mode | Lets judges try dev mode without waiting |
