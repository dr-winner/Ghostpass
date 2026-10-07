# Ghostpass working plan

Source: [the original build guide](build-guide.md), supplied on 5 October 2026.
This plan organizes the proposal; it does not establish that its external facts,
CLI flags, code examples, or event rules have been verified.

## First milestone: watcher contract and development setup

- [ ] Coordinate the pnpm monorepo scaffold with the lead, Gwill.
- [x] Check the local Node, pnpm, Rust, SQLite, and native build toolchain.
- [ ] Verify current Zcash software and network requirements against upstream sources.
- [x] Select and pin the exact watcher tool revision in `versions.lock`.
- [x] Verify wallet creation, viewing-key import, sync, and memo retrieval commands using that revision.
- [ ] Freeze the watcher API with Gwill before implementation diverges.

## dr-winner's implementation scope

1. **Merchant wallet:** establish a shielded receiving address and a viewing-only
   account for the watcher. Keep seeds, spending keys, viewing keys, and wallet
   databases out of source control. Actual wallet funding and transactions remain
   separate operations from repository setup.
2. **Watcher:** implement a service bound to `127.0.0.1`, importing viewing keys,
   syncing accounts, and exposing received amounts, memos, and confirmations.
3. **Matcher:** consume watcher outputs, validate the GP1 memo and plan, count
   payments without duplicates, and handle underpayments, top-ups, late payments,
   confirmations, and chain reorganizations.
4. **Integration:** connect the watcher and matcher to the lead's checkout and
   issuance flow. Start with simulated payments; validate real payments once the
   toolchain and wallet are ready.
5. **Privacy and deployment:** review retained data, key consistency, timing and
   network leaks; support deployment with TLS and the stated logging policy.

NEAR Intents remains optional, after the shielded-payment flow works end to end.

## Proposed watcher API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/accounts` | Import `{name, ufvk, birthday}` and return `{accountId}` |
| GET | `/accounts/:id/balance` | Return `{confirmedZat, pendingZat, tipHeight}` |
| GET | `/accounts/:id/received?sinceHeight=N` | Return `{tipHeight, outputs}` |
| GET | `/health` | Return `{tipHeight, lastSyncAt}` |

Each received output includes `txid`, `outIndex`, `pool`, `height`,
`confirmations`, `valueZat`, and nullable `memoText`. Amounts in zatoshis are
decimal strings. Confirm numeric types, pool identifiers, query boundaries,
error responses, and synchronization behavior when freezing the contract.

## Verification gates before adopting the examples

- Confirm event deadline, track, repository visibility, and participation rules.
- Confirm upgrade activation claims, shielded-pool behavior, fees, wallet support,
  and supported tool versions from current primary sources.
- Inspect the pinned wallet database schema; verify memo availability, output
  ownership, pool codes, transaction ID byte order, and chain-tip meaning.
- Ensure matcher output identity includes the shielded pool as well as transaction
  ID and output index. The guide's SQL key omits the pool.
- Design reorganization recovery to remove or revise orphaned payments and revisit
  confirmed checkouts. Re-reading recent blocks alone does not establish recovery.
- Define crash and response-loss recovery for issuance. The example marks a claim
  issued before signing but has no durable response-retrieval mechanism.
- Verify the blind-signature library API and complete a token round trip before
  adopting key generation and import examples.
- Check browser token persistence and concurrent spending before claiming reliable
  multi-tab behavior; the guide explicitly accepts a race for its demo.

## Proposed delivery milestones

Dates below are from the guide, rather than independently confirmed commitments.

| Date | Target |
| --- | --- |
| 6–7 October | Toolchain, wallet preparation, watcher API agreement, initial import and sync |
| 10–12 October | Received payments with memos, watcher acceptance check, matcher integration |
| 13–16 October | Confirmations, underpayments and top-ups, late payments, data cleanup |
| 17–20 October | Privacy review and deployment |
| 21–23 October | End-to-end payment evidence and fixes; optional work only if ready |
| 24–27 October | README, demonstration video, evidence review, target submission |

## Acceptance checks

- [ ] Watcher reports the expected amount and memo, and transaction IDs match the wallet.
- [x] Underpayments become paid after a valid top-up; late payments advance expired checkouts (automated tests).
- [x] Duplicate outputs do not increase credit; reorganized outputs cannot retain stale credit (automated tests).
- [x] Issuance and redemption tests cover concurrency, failure recovery, replay, and expired keys.
- [x] Simulated-payment mode cannot start in production and is clearly labeled locally.
- [x] Both demo merchants work; public key consistency checks are exercised (dev mode with real blind tokens, checked in Chrome; Mainnet run pending).
- [ ] Real-payment evidence, privacy limits, dependency versions, and setup instructions are documented.

## Implementation checkpoint

- `zwatch/`: authenticated loopback API, fixture backend, serialized native sync
  and memo enhancement, read-only wallet adapter, complete/stale snapshot checks.
- `packages/watcher-contract/`: validated API types, decimal amounts, memo decoding.
- `packages/matcher/`: atomic full-snapshot reconciliation, payment state handling,
  issued-payment cleanup, and a serialized polling helper.
- Merchant wallet created locally with an encrypted seed; zwatch imported its
  viewing key and completed an empty Mainnet sync with zero balance.
- The next real-payment acceptance check is guide §7.4; no payment has been sent.
- Read `docs/watcher-api.md` before integrating with the lead's server. The API
  and pool-inclusive payment schema still need agreement with the lead.

## Lead implementation checkpoint (Gwill)

- `packages/core/`: canonical encodings, ZIP 321 URIs, plans, GP1 memos (parsed
  exactly like the matcher), monthly periods, Authorization header, key-log format.
- `packages/server/`: monthly blind-RSA keys sealed at rest, checkout and status,
  atomic and retryable issuance, redeemer with spent set, sessions, hourly cleanup,
  dev-mode payments through the real matcher. It uses the matcher's pool-inclusive
  ledger and poller as documented in `docs/watcher-api.md`.
- `packages/client/`: token wallet, blind issuance with lost-response retry, public
  key-log check, privacy delay, `ghostFetch`, checkout widget.
- `apps/`: The Quiet Letter (session mode), Private Price API (per-request mode),
  dashboard; `pnpm dev` runs them with simulated payments.
- The verification gates on issuance recovery, the blind-signature round trip, and
  browser token persistence are covered by tests and a browser run. Multi-tab
  spending still races, as the guide accepts.
- Details and departures from the guide: `docs/merchant-server.md`.
- Next: a real Mainnet subscription once the watcher acceptance check (guide §7.4) passes.
