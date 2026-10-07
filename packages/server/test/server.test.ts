import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import { b64url, formatAuthorization, fromB64url, PLANS } from '@ghostpass/core';
import type { CheckoutResponse, CheckoutStatusResponse, IssueResponse, Plan, Token, WellKnown } from '@ghostpass/core';
import {
  appendKeyLog, blindSign, createGhostpass, installSchema, IssuerKeys, merchantStats, readKeyLog, seal, suite, unseal,
} from '../src/index.ts';
import { acceptsBlinded } from '../src/keys.ts';

const KEK = new Uint8Array(32).fill(7);
const UA = 'u1testmerchantaddress';
const TEST_PLAN: Plan = { id: 'test', label: 'Test plan', priceZat: 100_000n, tokens: 3, mode: 'per-request' };
const OCT_10 = Date.UTC(2026, 9, 10, 12);
const DAY = 24 * 60 * 60 * 1000;

const tempDir = () => mkdtempSync(join(tmpdir(), 'ghostpass-server-test-'));
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function harness(options: { db?: Database.Database; merchant?: string; dir?: string; now?: number } = {}) {
  const dir = options.dir ?? tempDir();
  const clock = { now: options.now ?? OCT_10 };
  const db = options.db ?? new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const errors: string[] = [];
  const gp = createGhostpass({
    db, merchantName: options.merchant ?? 'Test Merchant', merchantAddress: UA, plans: [TEST_PLAN, PLANS.monthly],
    kek: KEK, keyLogPath: join(dir, 'KEYS.json'), payments: { kind: 'simulated' }, secureCookies: false,
    now: () => clock.now, onError: code => errors.push(code),
  });
  await gp.start();
  const app = express();
  app.use(gp.router);
  app.get('/api/price', gp.requireGhostpass(), (_req, res) => { res.json({ price: 42 }); });
  app.post('/session/start', gp.requireGhostpass(), gp.startSession);
  app.get('/posts/1', gp.requireSession({ redirectTo: '/subscribe' }), (_req, res) => { res.send('post'); });
  app.get('/api/session-only', gp.requireSession(), (_req, res) => { res.send('ok'); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    gp, db, clock, base, dir, errors,
    async checkout(plan = 'test') {
      const r = await post(`${base}/v1/checkout`, { plan });
      assert.equal(r.status, 200);
      return await r.json() as CheckoutResponse;
    },
    async status(claimCode: string) {
      return await (await fetch(`${base}/v1/checkout/${claimCode}`)).json() as CheckoutStatusResponse;
    },
    async close(keepDb = false) {
      server.closeAllConnections();
      server.close();
      await gp.stop();
      if (!keepDb) db.close();
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The subscriber side of RFC 9474, as the browser client performs it. */
async function blindTokens(base: string, count: number) {
  const wk = await (await fetch(`${base}/.well-known/ghostpass.json`)).json() as WellKnown;
  const key = wk.keys.find(k => k.period === wk.current);
  assert.ok(key);
  const pk = await crypto.subtle.importKey('spki', fromB64url(key.spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  const pending = await Promise.all(Array.from({ length: count }, async () => {
    const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
    return { prepared, ...(await suite.blind(pk, prepared)) };
  }));
  return { period: key.period, pk, pending, blinded: pending.map(p => b64url(p.blindedMsg)) };
}

async function finalize(b: Awaited<ReturnType<typeof blindTokens>>, response: IssueResponse): Promise<Token[]> {
  return Promise.all(b.pending.map(async (p, i) => {
    const sig = await suite.finalize(b.pk, p.prepared, fromB64url(response.blindSigs[i]!), p.inv);
    return { period: response.period, msg: b64url(p.prepared), sig: b64url(sig) };
  }));
}

async function paidCheckout(h: Awaited<ReturnType<typeof harness>>) {
  const co = await h.checkout();
  assert.equal((await post(`${h.base}/dev/pay/${co.claimCode}`, {})).status, 200);
  return co;
}

const callApi = (base: string, token: Token) => fetch(`${base}/api/price`, { headers: { Authorization: formatAuthorization(token) } });

test('native blind signing is byte-identical to the RFC 9474 library and rejects out-of-range input', async () => {
  const dir = tempDir();
  const db = new Database(':memory:');
  try {
    installSchema(db, 'M');
    const keys = new IssuerKeys(db, 'M', KEK, join(dir, 'KEYS.json'));
    await keys.ensure(OCT_10);
    const signer = keys.signer('2026-10');
    const row = db.prepare("SELECT spki, pkcs8_sealed FROM issuer_keys WHERE period = '2026-10'").get() as { spki: Buffer; pkcs8_sealed: Buffer };
    const sk = await crypto.subtle.importKey('pkcs8', new Uint8Array(unseal(Buffer.from(KEK), '2026-10', row.pkcs8_sealed)), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
    const pk = await crypto.subtle.importKey('spki', new Uint8Array(row.spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
    for (let i = 0; i < 3; i++) {
      const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
      const { blindedMsg, inv } = await suite.blind(pk, prepared);
      const native = blindSign(signer, blindedMsg);
      assert.deepEqual(native, await suite.blindSign(sk, blindedMsg));
      const sig = await suite.finalize(pk, prepared, native, inv);
      assert.equal(await suite.verify(pk, sig, prepared), true);
    }
    assert.equal(acceptsBlinded(signer, new Uint8Array(255)), false);
    assert.equal(acceptsBlinded(signer, signer.modulus), false);
    assert.throws(() => blindSign(signer, new Uint8Array(256).fill(0xff)), /invalid_blinded_message/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sealed issuer keys require the same KEK and period', () => {
  const kek = Buffer.from(KEK);
  const blob = seal(kek, '2026-10', Buffer.from('secret'));
  assert.equal(unseal(kek, '2026-10', blob).toString(), 'secret');
  assert.throws(() => unseal(kek, '2026-11', blob));
  assert.throws(() => unseal(Buffer.alloc(32, 1), '2026-10', blob));
  assert.throws(() => unseal(kek, '2026-10', blob.subarray(0, 28)), /invalid_sealed_key/);
  assert.throws(() => new IssuerKeys(new Database(':memory:'), 'M', new Uint8Array(16), 'unused'), /kek_must_be_32_bytes/);
});

test('key log is append-only: current and next keys are logged once, and a replaced key is refused', async () => {
  const dir = tempDir();
  const log = join(dir, 'KEYS.json');
  const first = new Database(':memory:');
  const second = new Database(':memory:');
  try {
    installSchema(first, 'M');
    const keys = new IssuerKeys(first, 'M', KEK, log);
    await keys.ensure(OCT_10);
    await keys.ensure(OCT_10 + DAY);
    const logged = await readKeyLog(log);
    assert.deepEqual(logged.keys.map(k => [k.merchant, k.period]), [['M', '2026-10'], ['M', '2026-11']]);
    assert.match(readFileSync(log, 'utf8'), /^\{\n {2}"v": 1,/);
    await appendKeyLog(log, [{ merchant: 'Other', period: '2026-10', spkiSha256: 'f'.repeat(64) }]);
    // A lost database would regenerate different keys for logged periods; clients would reject them, so refuse.
    installSchema(second, 'M');
    await assert.rejects(new IssuerKeys(second, 'M', KEK, log).ensure(OCT_10), /key_log_conflict/);
    assert.equal((await readKeyLog(log)).keys.length, 3);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('merchants sharing one key log append concurrently without losing entries', async () => {
  const dir = tempDir();
  const log = join(dir, 'KEYS.json');
  try {
    const entries = Array.from({ length: 8 }, (_, i) => ({ merchant: `M${i}`, period: '2026-10', spkiSha256: String(i).repeat(64) }));
    await Promise.all(entries.map(e => appendKeyLog(log, [e])));
    await Promise.all(entries.map(e => appendKeyLog(log, [e])));
    assert.deepEqual((await readKeyLog(log)).keys.map(k => k.merchant).sort(), entries.map(e => e.merchant));
    await assert.rejects(appendKeyLog(log, [{ ...entries[0]!, spkiSha256: 'f'.repeat(64) }]), /key_log_conflict/);
    assert.equal((await readKeyLog(log)).keys.length, 8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('well-known publishes plans and redeemable, non-future keys oldest first', async () => {
  const h = await harness();
  try {
    let wk = await (await fetch(`${h.base}/.well-known/ghostpass.json`)).json() as WellKnown;
    assert.equal(wk.v, 1);
    assert.equal(wk.merchant, 'Test Merchant');
    assert.equal(wk.current, '2026-10');
    assert.deepEqual(wk.keys.map(k => [k.period, k.redeemUntil]), [['2026-10', '2026-11-15T00:00:00.000Z']]);
    assert.deepEqual(wk.plans, [
      { id: 'test', label: 'Test plan', amountZec: '0.001', tokens: 3, mode: 'per-request' },
      { id: 'monthly', label: '30 days', amountZec: '0.005', tokens: 30, mode: 'session' },
    ]);
    h.clock.now = Date.UTC(2026, 10, 5);
    await h.gp.keys.ensure(h.clock.now);
    wk = await (await fetch(`${h.base}/.well-known/ghostpass.json`)).json() as WellKnown;
    assert.deepEqual(wk.keys.map(k => k.period), ['2026-10', '2026-11']);
    h.clock.now = Date.UTC(2026, 10, 15);
    wk = await (await fetch(`${h.base}/.well-known/ghostpass.json`)).json() as WellKnown;
    assert.deepEqual(wk.keys.map(k => k.period), ['2026-11']);
    assert.equal(await h.gp.keys.publicIfRedeemable('2026-12', h.clock.now), null);
    assert.equal(await h.gp.keys.publicIfRedeemable('2026-10', h.clock.now), null);
  } finally { await h.close(); }
});

test('checkout returns a ZIP 321 request with the GP1 memo and validates input', async () => {
  const h = await harness();
  try {
    const co = await h.checkout('monthly');
    assert.match(co.claimCode, /^[A-Z2-7]{25}[AEIMQUY4]$/);
    assert.equal(co.memo, `GP1 ${co.claimCode} monthly`);
    assert.equal(co.address, UA);
    assert.equal(co.amountZec, '0.005');
    assert.equal(co.expiresAt, OCT_10 + 2 * 60 * 60 * 1000);
    assert.equal(co.uri, `zcash:${UA}?amount=0.005&memo=${b64url(new TextEncoder().encode(co.memo))}&message=Test%20Merchant%20-%2030%20days`);
    assert.deepEqual(await h.status(co.claimCode), { status: 'AWAITING_PAYMENT', paidZec: '0', confirmations: 0 });
    assert.equal((await post(`${h.base}/v1/checkout`, { plan: 'api100' })).status, 400);
    assert.equal((await post(`${h.base}/v1/checkout`, {})).status, 400);
    const bad = await fetch(`${h.base}/v1/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.deepEqual([bad.status, await bad.json()], [400, { error: 'invalid_json' }]);
    assert.equal((await fetch(`${h.base}/v1/checkout/${'A'.repeat(26)}`)).status, 404);
    assert.equal((await fetch(`${h.base}/v1/checkout/not-a-code`)).status, 404);
  } finally { await h.close(); }
});

test('full token round trip: underpay, top up, issue once, redeem once, reject replays and forgeries', async () => {
  const h = await harness();
  try {
    const co = await h.checkout();
    const b = await blindTokens(h.base, 3);
    const issue = (body: unknown) => post(`${h.base}/v1/issue`, body);
    assert.equal((await issue({ claimCode: co.claimCode, period: b.period, blinded: b.blinded })).status, 409);

    await post(`${h.base}/dev/pay/${co.claimCode}`, { zat: '40000' });
    assert.deepEqual(await h.status(co.claimCode), { status: 'UNDERPAID', paidZec: '0.0004', confirmations: 2 });
    await post(`${h.base}/dev/pay/${co.claimCode}`, { zat: '60000' });
    assert.deepEqual(await h.status(co.claimCode), { status: 'CONFIRMED', paidZec: '0.001', confirmations: 2 });
    assert.equal((await post(`${h.base}/dev/pay/${co.claimCode}`, { zat: '0' })).status, 400);

    const wrongCount = await issue({ claimCode: co.claimCode, period: b.period, blinded: b.blinded.slice(1) });
    assert.deepEqual([wrongCount.status, await wrongCount.json()], [400, { error: 'bad_count', expected: 3 }]);
    const wrongPeriod = await issue({ claimCode: co.claimCode, period: '2026-09', blinded: b.blinded });
    assert.deepEqual([wrongPeriod.status, await wrongPeriod.json()], [409, { error: 'period_changed', current: '2026-10' }]);
    const garbage = await issue({ claimCode: co.claimCode, period: b.period, blinded: [b.blinded[0], b.blinded[1], 'AAAA'] });
    assert.equal(garbage.status, 400);
    assert.equal((await h.status(co.claimCode)).status, 'CONFIRMED');

    const issued = await issue({ claimCode: co.claimCode, period: b.period, blinded: b.blinded });
    assert.equal(issued.status, 200);
    const response = await issued.json() as IssueResponse;
    assert.equal(response.period, '2026-10');
    assert.equal(response.blindSigs.length, 3);
    assert.equal((await h.status(co.claimCode)).status, 'ISSUED');
    assert.deepEqual(h.db.prepare('SELECT COUNT(*) AS n FROM payments').get(), { n: 0 });
    assert.deepEqual(h.db.prepare('SELECT COUNT(*) AS n FROM simulated_outputs').get(), { n: 0 });

    // A lost response can be recovered with the identical request; any other request is refused.
    const replay = await issue({ claimCode: co.claimCode, period: b.period, blinded: b.blinded });
    assert.deepEqual(await replay.json(), response);
    const other = await blindTokens(h.base, 3);
    assert.equal((await issue({ claimCode: co.claimCode, period: other.period, blinded: other.blinded })).status, 409);
    assert.equal((await post(`${h.base}/dev/pay/${co.claimCode}`, {})).status, 409);

    const tokens = await finalize(b, response);
    const first = await callApi(h.base, tokens[0]!);
    assert.deepEqual([first.status, await first.json()], [200, { price: 42 }]);
    const again = await callApi(h.base, tokens[0]!);
    assert.deepEqual([again.status, await again.json()], [401, { error: 'token_already_spent' }]);
    assert.equal(again.headers.get('www-authenticate'), 'Ghostpass realm="Test Merchant", keys="/.well-known/ghostpass.json"');
    assert.equal((await callApi(h.base, tokens[1]!)).status, 200);

    const forged = { ...tokens[2]!, sig: b64url(new Uint8Array(256).fill(1)) };
    assert.deepEqual(await (await callApi(h.base, forged)).json(), { error: 'invalid_token' });
    const swapped = { ...tokens[2]!, msg: tokens[0]!.msg };
    assert.equal((await callApi(h.base, swapped)).status, 401);
    const missing = await fetch(`${h.base}/api/price`);
    assert.deepEqual([missing.status, await missing.json()], [401, { error: 'payment_required' }]);
    assert.equal((await callApi(h.base, { ...tokens[2]!, period: '2026-09' })).status, 401);
    assert.equal((await callApi(h.base, tokens[2]!)).status, 200);

    assert.deepEqual(merchantStats(h.db), [{ period: '2026-10', checkoutsPaid: 1, receivedZat: '100000', tokensIssued: 3, tokensRedeemed: 3 }]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('concurrent issuance for one claim code produces exactly one success', async () => {
  const h = await harness();
  try {
    const co = await paidCheckout(h);
    const attempts = await Promise.all([blindTokens(h.base, 3), blindTokens(h.base, 3), blindTokens(h.base, 3)]);
    const results = await Promise.all(attempts.map(b => post(`${h.base}/v1/issue`, { claimCode: co.claimCode, period: b.period, blinded: b.blinded })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
    assert.deepEqual(h.db.prepare('SELECT issued FROM stats').get(), { issued: 3 });
  } finally { await h.close(); }
});

test('session mode: one token opens a 24-hour session cookie', async () => {
  const h = await harness();
  try {
    const co = await paidCheckout(h);
    const b = await blindTokens(h.base, 3);
    const [token] = await finalize(b, await (await post(`${h.base}/v1/issue`, { claimCode: co.claimCode, period: b.period, blinded: b.blinded })).json() as IssueResponse);
    const noSession = await fetch(`${h.base}/posts/1`, { redirect: 'manual' });
    assert.deepEqual([noSession.status, noSession.headers.get('location')], [303, '/subscribe']);
    assert.equal((await fetch(`${h.base}/api/session-only`)).status, 401);

    const started = await fetch(`${h.base}/session/start`, { method: 'POST', headers: { Authorization: formatAuthorization(token!) } });
    assert.equal(started.status, 200);
    const setCookie = started.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^gp_s=[A-Za-z0-9_-]{43}; Max-Age=86400; Path=\/; Expires=.+; HttpOnly; SameSite=Strict$/);
    const cookie = setCookie.split(';')[0]!;
    assert.equal(await (await fetch(`${h.base}/posts/1`, { headers: { cookie } })).text(), 'post');
    assert.equal((await fetch(`${h.base}/session/start`, { method: 'POST', headers: { Authorization: formatAuthorization(token!) } })).status, 401);
    assert.equal((await fetch(`${h.base}/posts/1`, { headers: { cookie: 'gp_s=forged' }, redirect: 'manual' })).status, 303);

    h.clock.now += DAY;
    assert.equal((await fetch(`${h.base}/posts/1`, { headers: { cookie }, redirect: 'manual' })).status, 303);
    h.gp.cleanup();
    assert.deepEqual(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get(), { n: 0 });
  } finally { await h.close(); }
});

test('tokens expire with their redeem window, and spent sets are deleted afterwards', async () => {
  const h = await harness();
  try {
    const co = await paidCheckout(h);
    const b = await blindTokens(h.base, 3);
    const tokens = await finalize(b, await (await post(`${h.base}/v1/issue`, { claimCode: co.claimCode, period: b.period, blinded: b.blinded })).json() as IssueResponse);
    h.clock.now = Date.UTC(2026, 10, 14, 23, 59);
    await h.gp.keys.ensure(h.clock.now);
    assert.equal((await callApi(h.base, tokens[0]!)).status, 200);
    h.clock.now = Date.UTC(2026, 10, 15);
    assert.equal((await callApi(h.base, tokens[1]!)).status, 401);
    assert.deepEqual(h.db.prepare('SELECT COUNT(*) AS n FROM spent_tokens').get(), { n: 1 });
    h.gp.cleanup();
    assert.deepEqual(h.db.prepare('SELECT COUNT(*) AS n FROM spent_tokens').get(), { n: 0 });
  } finally { await h.close(); }
});

test("a token signed by another merchant's key is rejected", async () => {
  const a = await harness({ merchant: 'Merchant A' });
  const b = await harness({ merchant: 'Merchant B' });
  try {
    const co = await paidCheckout(b);
    const blinded = await blindTokens(b.base, 3);
    const tokens = await finalize(blinded, await (await post(`${b.base}/v1/issue`, { claimCode: co.claimCode, period: blinded.period, blinded: blinded.blinded })).json() as IssueResponse);
    assert.deepEqual(await (await callApi(a.base, tokens[0]!)).json(), { error: 'invalid_token' });
    assert.equal((await callApi(b.base, tokens[0]!)).status, 200);
  } finally { await a.close(); await b.close(); }
});

test('late payments after expiry are honoured', async () => {
  const h = await harness();
  try {
    const co = await h.checkout();
    h.clock.now = co.expiresAt + 1;
    assert.equal((await h.status(co.claimCode)).status, 'EXPIRED');
    await post(`${h.base}/dev/pay/${co.claimCode}`, {});
    assert.equal((await h.status(co.claimCode)).status, 'CONFIRMED');
  } finally { await h.close(); }
});

test('issuance failures leave the claim retryable: missing key, signing fault, and crash before response', async () => {
  const dir = tempDir();
  const db = new Database(':memory:');
  const h = await harness({ db, dir });
  try {
    const co = await paidCheckout(h);
    const b = await blindTokens(h.base, 3);
    const body = { claimCode: co.claimCode, period: b.period, blinded: b.blinded };
    const realSigner = h.gp.keys.signer.bind(h.gp.keys);

    Object.assign(h.gp.keys, { signer: () => { throw new Error('issuer_key_unavailable'); } });
    assert.deepEqual(await (await post(`${h.base}/v1/issue`, body)).json(), { error: 'issuer_key_unavailable' });
    assert.equal((await h.status(co.claimCode)).status, 'CONFIRMED');

    // A signer whose public half does not match fails RFC 9474's m == m' check after the claim is taken.
    const wrongPublic = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    Object.assign(h.gp.keys, { signer: (period: string) => ({ ...realSigner(period), publicKey: wrongPublic }) });
    const failed = await post(`${h.base}/v1/issue`, body);
    assert.deepEqual([failed.status, await failed.json()], [500, { error: 'issue_failed' }]);
    assert.equal((await h.status(co.claimCode)).status, 'CONFIRMED');
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM issuances').get(), { n: 0 });

    Object.assign(h.gp.keys, { signer: realSigner });
    db.prepare("UPDATE checkouts SET status = 'ISSUED' WHERE claim_code = ?").run(co.claimCode);
    db.prepare("INSERT INTO issuances (claim_code, request_hash, period, blind_sigs, created_at) VALUES (?, 'x', '2026-10', NULL, 0)").run(co.claimCode);
    await h.close(true);

    const restarted = await harness({ db, dir });
    try {
      assert.equal((await restarted.status(co.claimCode)).status, 'CONFIRMED');
      assert.equal((await post(`${restarted.base}/v1/issue`, body)).status, 200);
      restarted.clock.now += DAY + 1;
      restarted.gp.cleanup();
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM issuances').get(), { n: 0 });
    } finally { await restarted.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('configuration guards: production refuses simulated payments and insecure cookies; addresses, names, and databases are checked', () => {
  const base = { merchantName: 'M', merchantAddress: UA, plans: [TEST_PLAN], kek: KEK, keyLogPath: 'unused', payments: { kind: 'simulated' } as const };
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => createGhostpass({ ...base, db: new Database(':memory:') }), /simulated_payments_in_production/);
    assert.throws(() => createGhostpass({ ...base, db: new Database(':memory:'), secureCookies: false }), /insecure_cookies_in_production/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  assert.throws(() => createGhostpass({ ...base, db: new Database(':memory:'), merchantAddress: 't1transparent' }), /transparent/);
  assert.throws(() => createGhostpass({ ...base, db: new Database(':memory:'), merchantName: 'Bad "name"' }), /invalid_merchant_name/);
  assert.throws(() => createGhostpass({ ...base, db: new Database(':memory:'), plans: [TEST_PLAN, TEST_PLAN] }), /duplicate_plan/);
  const db = new Database(':memory:');
  createGhostpass({ ...base, db });
  assert.throws(() => createGhostpass({ ...base, db, merchantName: 'Other' }), /database_belongs_to_another_merchant/);
});

test('watcher mode exposes no simulated-payment route', async () => {
  const dir = tempDir();
  const db = new Database(':memory:');
  const gp = createGhostpass({
    db, merchantName: 'M', merchantAddress: UA, plans: [TEST_PLAN], kek: KEK, keyLogPath: join(dir, 'KEYS.json'),
    payments: { kind: 'watcher', url: 'http://127.0.0.1:9', accountId: 'merchant', token: 't'.repeat(32) },
  });
  const app = express().use(gp.router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.equal(gp.devMode, false);
    assert.equal(gp.simulatePayment, undefined);
    const r = await post(`http://127.0.0.1:${(server.address() as AddressInfo).port}/dev/pay/${'A'.repeat(26)}`, {});
    assert.equal(r.status, 404);
  } finally {
    server.closeAllConnections();
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
