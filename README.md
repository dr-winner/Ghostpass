# Ghostpass

Unlinkable subscriptions paid in shielded ZEC, built for ZECATHON (Shielded Payments track).

A subscriber pays once in shielded ZEC and receives a batch of blind-signed access
tokens. Each visit or API call spends one token. The merchant can check that a token
is valid, paid for and unspent, but because the tokens were signed blind it cannot
link a token to the payment that bought it, or tokens to each other. There is no
account, email or password. Network metadata, timing and small anonymity sets
remain privacy limits (see [Honest limits](#honest-limits)).

Demo video: not recorded yet.

## The problem

Subscriptions need accounts: a newsletter knows every article you read, under your
email address, from the day you signed up. Paying with a public cryptocurrency does
not help, because the payment itself is public and links to your other activity.
Ghostpass keeps the payment shielded and makes each use of the subscription
unlinkable to that payment.

## Try it in 2 minutes (dev mode)

Requires Node 24.14.1 and pnpm 10.33.0 (`corepack enable`). No ZEC or Zcash tools needed.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

| URL | What it is |
| --- | --- |
| http://127.0.0.1:3000 | **The Quiet Letter**, a newsletter in session mode: one token opens a 24-hour reading session |
| http://127.0.0.1:3001 | **Private Price API**, per-request mode: every API call spends one token |
| http://127.0.0.1:3002 | Dashboard with aggregate statistics; the password for the run is printed in the terminal |

Dev mode shows a red **DEV MODE: payments are simulated** banner. Press **Pay**, then
**Simulate full payment** (or an underpayment first, to see the top-up path). The
browser blinds its token requests, receives blind signatures, and stores the tokens
in IndexedDB. The simulated payment goes through the same matcher code as a Mainnet payment.
In the API demo, **Export one token as a curl command** gives a command that works once;
run it twice to see the replay rejected with `401 token_already_spent`.

Dev mode refuses to start with `NODE_ENV=production`, shows a placeholder address
that wallets reject, keeps its keys and key log in `.local/dev/`, and shortens the
first-use privacy delay from 1–10 minutes to 5–15 seconds.

## Real payment (Mainnet)

1. Build the pinned `zcash-devtool` and create the merchant wallet with
   `pnpm setup:wallet`. It imports only the viewing key into zwatch and writes `.env`
   with the watcher settings, `MERCHANT_ACCOUNT_ID` and `MERCHANT_UA`. See
   [the watcher guide](docs/watcher-api.md#merchant-wallet-and-native-tool).
2. Add `GP_KEK_HEX` (`openssl rand -hex 32`), `GP_ADMIN_PASSWORD` and `GP_KEYS_URL`
   to `.env` ([.env.example](.env.example) lists every setting).
3. Run `pnpm start:watcher`, then `NODE_ENV=production pnpm start:demo`, behind a TLS
   reverse proxy: session cookies are `Secure`, and access logs must not record IP addresses.
4. On first start, the merchants append the key hashes for this month and next to
   [KEYS.json](KEYS.json). Commit and push it before taking payments: browsers refuse
   any issuer key that is not in the public log.
5. Scan the checkout QR code with Zodl and pay. Two confirmations later, the browser receives its tokens.

Configuration, endpoints and deployment notes: [docs/merchant-server.md](docs/merchant-server.md).

## How it works

```
Subscriber browser                                    Merchant side
 ├─ checkout widget ── POST /v1/checkout ───────────▶ Ghostpass service (packages/server)
 │    ZIP 321 QR: amount + memo "GP1 <claim> <plan>"   ├─ checkouts (claim codes)
 ├─ pays from Zodl ── shielded tx ─▶ chain ─▶ zwatch (viewing key) ─▶ matcher
 ├─ checks the key against the public KEYS.json
 ├─ POST /v1/issue (blinded messages) ──────────────▶ issuer (monthly RSA blind-signature keys)
 ├─ token wallet (IndexedDB)
 └─ Authorization: Ghostpass v=1, period, msg, sig ─▶ redeemer (signature + spent set)
```

- **Checkout:** a random 26-character claim code goes into the payment memo. The
  browser saves it at once: until tokens are issued it is the subscriber's only receipt.
- **Payment:** zwatch watches the merchant's viewing key; the matcher credits a
  checkout from memos and counts confirmations, top-ups and late payments.
- **Issuance:** after two confirmations, the browser sends blinded random messages and
  the server signs them once per claim code (RSABSSA-SHA384-PSS-Randomized, RFC 9474).
  The payment's transaction IDs are then deleted from the merchant database.
- **Redemption:** each request carries one unblinded token; the server verifies the
  signature and records the token's hash as spent.

## What leaks to whom

| Who | What they learn |
| --- | --- |
| Blockchain observer | That a shielded transaction happened, plus its fee and size. Not the sender, recipient, amount or memo. |
| Merchant at payment time | Claim code X paid amount A at time T. |
| Merchant when a token is used | A valid token for period P was used at time T2. It cannot be linked to X or to other tokens. |
| Merchant overall | How many subscribers there are per period. |
| Network observer | IP addresses, unless the subscriber uses Tor or a VPN. |

The merchant database has **no column linking a claim code to a spent token**:

```sql
CREATE TABLE checkouts (
  claim_code TEXT PRIMARY KEY, plan TEXT NOT NULL, price_zat INTEGER NOT NULL,
  paid_zat INTEGER NOT NULL DEFAULT 0, min_conf INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, issued_at INTEGER
);
-- Deleted once the checkout is ISSUED, so transaction IDs are not kept.
CREATE TABLE payments (
  txid TEXT NOT NULL, pool INTEGER NOT NULL, out_index INTEGER NOT NULL,
  claim_code TEXT NOT NULL REFERENCES checkouts(claim_code),
  value_zat INTEGER NOT NULL, confirmations INTEGER NOT NULL, height INTEGER NOT NULL,
  PRIMARY KEY (txid, pool, out_index)
);
-- No timestamps or request data: only "this token was used".
CREATE TABLE spent_tokens (period TEXT NOT NULL, token_hash TEXT NOT NULL, PRIMARY KEY (period, token_hash));
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE stats (period TEXT PRIMARY KEY, issued INTEGER NOT NULL DEFAULT 0, redeemed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE issuer_keys (period TEXT PRIMARY KEY, spki BLOB NOT NULL, pkcs8_sealed BLOB NOT NULL, redeem_until INTEGER NOT NULL);
-- Blind signatures kept for 24 hours so a lost response can be retried; blinded values reveal nothing about tokens.
CREATE TABLE issuances (claim_code TEXT PRIMARY KEY, request_hash TEXT NOT NULL, period TEXT NOT NULL, blind_sigs TEXT, created_at INTEGER NOT NULL);
```

Other privacy measures: a random 1–10 minute delay before a new pass is first used,
fixed price tiers, no third-party scripts, fonts or analytics, no request logging,
and deletion of spent-token hashes once a period's redeem window closes.
**Key consistency:** a dishonest merchant could give each subscriber a different key
and recognise them later. Before blinding, the browser fetches the public
[KEYS.json](KEYS.json) from this repository and refuses any key that is not the single
logged key for that merchant and month (see the key-consistency discussion in RFC 9576).

## Mainnet evidence

No Mainnet subscriptions yet. The guide's target is at least five real subscriptions
paid from Zodl across both plans, including one topped-up underpayment and one late
payment. Their transaction IDs will be listed here.

## Honest limits

- **Small anonymity set at launch.** With few subscribers, timing can link payment and use.
- **Key consistency** depends on subscribers' browsers checking the published hashes,
  and the page code itself is served by the merchant.
- **Tokens are bearer tokens.** They can be shared or stolen from the browser.
- **No automatic renewal.** Zcash has no pull payments; every renewal is a fresh payment.
- **Duplicate payments after issuance stay with the merchant.** A second payment with
  an already-used memo is not credited.
- **Confirmations are a settlement assumption.** A reorganization deeper than two
  blocks after issuance cannot revoke tokens already handed out.
- **Two browser tabs can race** for the same token; the server rejects the second use.
- **zcash-devtool is prototyping software.** Keep only small amounts in the merchant wallet.
- Each merchant database must be served by a single process.

## Team

| Owner | Scope |
| --- | --- |
| dr-winner | `zwatch`, merchant wallet setup, payment matcher, confirmations and payment edge cases, privacy review, deployment support |
| Gwill ([big14way](https://github.com/big14way)), lead | Core package, blind-token issuer and redeemer, browser token wallet, demo merchants, dashboard, submission materials |

## Repository layout

| Path | Contents | Owner |
| --- | --- | --- |
| `packages/core` | Encoding, ZIP 321 URIs, plans, GP1 memos, periods, the Authorization header, key-log format | Gwill |
| `packages/server` | Monthly keys, checkout, issuer, redeemer, sessions, dev-mode payments | Gwill |
| `packages/client` | Token wallet, blind issuance, key check, `ghostFetch`, checkout widget | Gwill |
| `packages/demo-web` | Shared configuration, page layout and security headers for the demos | Gwill |
| `apps/newsletter`, `apps/api-demo`, `apps/dashboard` | The two demo merchants and the dashboard | Gwill |
| `packages/watcher-contract`, `packages/matcher`, `zwatch/` | Watcher API types, payment matching, payment watcher | dr-winner |

## Commands

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dev              # demo merchants and dashboard with simulated payments
pnpm start:demo       # demo merchants and dashboard with real payments, using .env
pnpm demo:payments    # simulated underpayment and top-up through the matcher, no server
pnpm dev:watcher      # zwatch HTTP API with fixture payments
pnpm start:watcher    # zwatch with the real viewing-only wallet, using .env
pnpm check:tools      # toolchain check
pnpm setup:wallet     # create the encrypted merchant wallet and import its viewing key
```

dr-winner's local toolchain and empty encrypted merchant wallet have been prepared.
Before funding, back up the two wallet files listed in the [integration guide](docs/watcher-api.md#merchant-wallet-and-native-tool).

## Project documents

- [Original build guide](docs/build-guide.md): Gwill's proposal, preserved unchanged.
- [Working plan](docs/project-plan.md): responsibilities, milestones, and verification gates.
- [Merchant server, client and demos](docs/merchant-server.md): endpoints, configuration, and where the implementation departs from the guide.
- [Watcher API and integration guide](docs/watcher-api.md): running zwatch and the matcher.

The guide specifies the Shielded Payments track, a 28 October 2026 deadline, and
a target submission date of 27 October. Event rules and dates still need confirmation.

## Orca workspace

Use the **Zecaton — Ghostpass** workspace as the project hub. The primary checkout
is `/Users/procoder/Projects/Ghostpass`, and `main` is the base branch for new task
workspaces.

Setup and archive scripts are empty, and setup is skipped by default. Run
`pnpm install --frozen-lockfile` in a fresh task workspace. The merchant wallet
and `.env` remain local to the primary checkout.

New task workspaces use Orca's standard workspace directory. The existing Codex
session can help with planning, implementation, testing, and submission materials.

dr-winner's commits use the `dr-winner` GitHub identity and Gwill's use `big14way`;
agent attribution rules are recorded in [AGENTS.md](AGENTS.md).

## Credits

[blindrsa-ts](https://github.com/cloudflare/blindrsa-ts) (Apache-2.0) with
[sjcl](https://github.com/bitwiseshiftleft/sjcl) (BSD-2-Clause or GPL-2.0),
[zcash-devtool](https://github.com/zcash/zcash-devtool) (MIT or Apache-2.0),
[qrcode](https://github.com/soldair/node-qrcode) (MIT), [idb-keyval](https://github.com/jakearchibald/idb-keyval) (Apache-2.0),
[Express](https://expressjs.com) and cookie-parser (MIT), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (MIT),
and [esbuild](https://esbuild.github.io) (MIT). The project's own license has not been chosen yet.
