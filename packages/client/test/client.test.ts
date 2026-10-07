import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import { createGhostpass } from '@ghostpass/server';
import type { Plan } from '@ghostpass/core';
import { GhostpassClient, GhostpassError, memoryStore } from '../src/index.ts';
import type { ClientOptions } from '../src/index.ts';

const PLAN: Plan = { id: 'test', label: 'Test plan', priceZat: 100_000n, tokens: 3, mode: 'per-request' };
const MERCHANT = 'Client Test Merchant';
const OCT_10 = Date.UTC(2026, 9, 10, 12);

async function merchant() {
  const dir = mkdtempSync(join(tmpdir(), 'ghostpass-client-test-'));
  const clock = { now: OCT_10 };
  const db = new Database(':memory:');
  const gp = createGhostpass({
    db, merchantName: MERCHANT, merchantAddress: 'u1clienttest', plans: [PLAN], kek: new Uint8Array(32).fill(3),
    keyLogPath: join(dir, 'KEYS.json'), payments: { kind: 'simulated' }, secureCookies: false, now: () => clock.now,
  });
  await gp.start();
  const app = express();
  app.use(gp.router);
  app.get('/KEYS.json', (_req, res) => { res.type('json').send(readFileSync(join(dir, 'KEYS.json'))); });
  app.get('/api/price', gp.requireGhostpass(), (_req, res) => { res.json({ price: 42 }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (overrides: Partial<ClientOptions> = {}) => new GhostpassClient({
    base, merchant: MERCHANT, keysUrl: `${base}/KEYS.json`, store: memoryStore(), now: () => clock.now, privacyDelayMs: [60_000, 600_000], ...overrides,
  });
  return {
    gp, db, dir, clock, base, client,
    async close() {
      server.closeAllConnections();
      server.close();
      await gp.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof GhostpassError && e.code === code);

test('subscriber flow: checkout, pending receipt, issuance, privacy delay, spending, and exhaustion', async () => {
  const m = await merchant();
  try {
    const c = m.client();
    const co = await c.startCheckout('test');
    assert.deepEqual((await c.pending()).map(p => [p.claimCode, p.plan, p.checkout.memo]), [[co.claimCode, 'test', `GP1 ${co.claimCode} test`]]);
    assert.equal((await c.checkoutStatus(co.claimCode)).status, 'AWAITING_PAYMENT');
    await rejectsWith(c.obtainTokens(co.claimCode, 3), 'not_confirmed_or_already_issued');
    assert.equal(await c.hasIssuingState(co.claimCode), true);

    assert.equal((await c.simulatePayment(co.claimCode)).status, 'CONFIRMED');
    assert.equal(await c.obtainTokens(co.claimCode, 3), 3);
    assert.deepEqual(await c.pending(), []);
    assert.equal(await c.hasIssuingState(co.claimCode), false);
    const summary = await c.summary();
    assert.equal(summary.count, 3);
    assert.equal(summary.redeemableUntil, Date.UTC(2026, 10, 15));
    assert.ok(summary.notBefore >= OCT_10 + 60_000 && summary.notBefore <= OCT_10 + 600_000);

    await rejectsWith(c.ghostFetch(`${m.base}/api/price`), 'privacy_delay');
    assert.equal((await c.summary()).count, 3);
    m.clock.now = summary.notBefore;
    for (let i = 0; i < 3; i++) {
      const r = await c.ghostFetch(`${m.base}/api/price`);
      assert.deepEqual([r.status, await r.json()], [200, { price: 42 }]);
    }
    await rejectsWith(c.ghostFetch(`${m.base}/api/price`), 'no_tokens');
    await rejectsWith(c.startCheckout('nope'), 'unknown_plan');
    await rejectsWith(c.checkoutStatus('A'.repeat(26)), 'unknown_claim');
  } finally { await m.close(); }
});

test('a key missing from, or different in, the public log stops issuance before anything is sent', async () => {
  const m = await merchant();
  try {
    const co = await m.client().startCheckout('test');
    m.gp.simulatePayment!(co.claimCode);
    const elsewhere = join(m.dir, 'other.json');
    const serve = (log: unknown) => {
      writeFileSync(elsewhere, JSON.stringify(log));
      return async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith('/KEYS.json') ? new Response(readFileSync(elsewhere)) : fetch(input, init);
    };
    await rejectsWith(m.client({ fetch: serve({ v: 1, keys: [] }) }).obtainTokens(co.claimCode, 3), 'key_not_logged');
    const forged = { v: 1, keys: [{ merchant: MERCHANT, period: '2026-10', spkiSha256: '0'.repeat(64) }] };
    await rejectsWith(m.client({ fetch: serve(forged) }).obtainTokens(co.claimCode, 3), 'key_inconsistent');
    await rejectsWith(m.client({ fetch: serve('not json') }).obtainTokens(co.claimCode, 3), 'key_log_unavailable');
    await rejectsWith(m.client({ merchant: 'Someone Else' }).obtainTokens(co.claimCode, 3), 'unexpected_merchant');
    assert.equal((await m.client().checkoutStatus(co.claimCode)).status, 'CONFIRMED');
  } finally { await m.close(); }
});

test('a lost issuance response is recovered by retrying the identical blinded request', async () => {
  const m = await merchant();
  try {
    let drop = true;
    const lossy = async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await fetch(input, init);
      if (drop && String(input).endsWith('/v1/issue')) {
        drop = false;
        await r.arrayBuffer();
        throw new TypeError('network connection lost');
      }
      return r;
    };
    const c = m.client({ fetch: lossy });
    const co = await c.startCheckout('test');
    m.gp.simulatePayment!(co.claimCode);
    await assert.rejects(c.obtainTokens(co.claimCode, 3), /network connection lost/);
    assert.equal((await c.checkoutStatus(co.claimCode)).status, 'ISSUED');
    assert.equal(await c.hasIssuingState(co.claimCode), true);
    assert.equal(await c.obtainTokens(co.claimCode, 3), 3);
    m.clock.now += 600_000;
    assert.equal((await c.ghostFetch(`${m.base}/api/price`)).status, 200);
  } finally { await m.close(); }
});

test('a month boundary during issuance re-blinds under the new key', async () => {
  const m = await merchant();
  try {
    let rolled = false;
    const rolling = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!rolled && String(input).endsWith('/v1/issue')) {
        rolled = true;
        m.clock.now = Date.UTC(2026, 10, 1, 0, 0, 1);
      }
      return fetch(input, init);
    };
    const c = m.client({ fetch: rolling });
    const co = await c.startCheckout('test');
    m.gp.simulatePayment!(co.claimCode);
    assert.equal(await c.obtainTokens(co.claimCode, 3), 3);
    assert.deepEqual((await c.tokens()).map(t => t.period), ['2026-11', '2026-11', '2026-11']);
  } finally { await m.close(); }
});

test('tokens are spent oldest period first and dropped after their redeem window', async () => {
  const m = await merchant();
  try {
    const c = m.client({ privacyDelayMs: [0, 0] });
    const first = await c.startCheckout('test');
    m.gp.simulatePayment!(first.claimCode);
    await c.obtainTokens(first.claimCode, 3);
    m.clock.now = Date.UTC(2026, 10, 3);
    await m.gp.keys.ensure(m.clock.now);
    const second = await c.startCheckout('test');
    m.gp.simulatePayment!(second.claimCode);
    await c.obtainTokens(second.claimCode, 3);
    assert.deepEqual((await c.tokens()).map(t => t.period), ['2026-10', '2026-10', '2026-10', '2026-11', '2026-11', '2026-11']);
    assert.equal((await c.takeToken()).period, '2026-10');
    assert.equal((await c.summary()).redeemableUntil, Date.UTC(2026, 10, 15));
    m.clock.now = Date.UTC(2026, 10, 15);
    assert.deepEqual((await c.tokens()).map(t => t.period), ['2026-11', '2026-11', '2026-11']);
    assert.equal((await c.ghostFetch(`${m.base}/api/price`)).status, 200);
    assert.equal((await c.summary()).count, 2);
  } finally { await m.close(); }
});

test('client options are validated', () => {
  const base = { merchant: 'M', keysUrl: 'https://example.invalid/KEYS.json', store: memoryStore() };
  assert.throws(() => new GhostpassClient({ ...base, privacyDelayMs: [10, 5] }), GhostpassError);
  assert.throws(() => new GhostpassClient({ ...base, privacyDelayMs: [-1, 5] }), GhostpassError);
  return rejectsWith(new GhostpassClient(base).obtainTokens('A'.repeat(26), 0), 'invalid_count');
});
