import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64url, fromB64url, base32, sha256hex, zatToZec, buildZip321, buildMemo, parseMemo, newClaimCode,
  PLANS, assertPlan, publicPlan, currentPeriod, nextPeriod, redeemUntil,
  formatAuthorization, parseAuthorization, keyLog, loggedKeyHash,
} from '../src/index.ts';
import { parsePaymentMemo } from '../../watcher-contract/src/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

test('zatToZec formats exact decimal ZEC', () => {
  assert.equal(zatToZec(500000n), '0.005');
  assert.equal(zatToZec(100000000n), '1');
  assert.equal(zatToZec(1n), '0.00000001');
  assert.equal(zatToZec(0n), '0');
  assert.equal(zatToZec(2_100_000_000_000_000n), '21000000');
  assert.throws(() => zatToZec(-1n));
  assert.throws(() => zatToZec(2_100_000_000_000_001n));
});

test('buildZip321 emits unpadded base64url memos and percent-encoded messages', () => {
  const uri = buildZip321('u1abc', 500000n, 'GP1 test', 'The Quiet Letter - 30 days');
  assert.equal(uri, 'zcash:u1abc?amount=0.005&memo=R1AxIHRlc3Q&message=The%20Quiet%20Letter%20-%2030%20days');
  assert.doesNotMatch(new URL(uri).searchParams.get('memo')!, /=/);
  assert.equal(new TextDecoder().decode(fromB64url(new URL(uri).searchParams.get('memo')!)), 'GP1 test');
  assert.equal(buildZip321('t1abc', 1n), 'zcash:t1abc?amount=0.00000001');
});

test('buildZip321 rejects oversized memos, memos to transparent addresses, and invalid inputs', () => {
  assert.doesNotThrow(() => buildZip321('u1abc', 1n, 'x'.repeat(512)));
  assert.throws(() => buildZip321('u1abc', 1n, 'x'.repeat(513)), /memo_too_long/);
  assert.throws(() => buildZip321('u1abc', 1n, 'é'.repeat(257)), /memo_too_long/);
  assert.throws(() => buildZip321('t1abc', 1n, 'memo'), /transparent/);
  assert.throws(() => buildZip321('tex1abc', 1n, 'memo'), /transparent/);
  assert.throws(() => buildZip321('u1abc?amount=9', 1n), /invalid_address/);
  assert.throws(() => buildZip321('u1abc', 0n), /positive/);
});

test('base32 matches RFC 4648 vectors and claim codes are canonical', () => {
  assert.equal(base32(bytes('f')), 'MY');
  assert.equal(base32(bytes('foobar')), 'MZXW6YTBOI');
  assert.equal(base32(new Uint8Array(16).fill(0xff)), '7'.repeat(25) + '4');
  for (let i = 0; i < 200; i++) {
    const code = newClaimCode();
    assert.equal(code.length, 26);
    assert.match(code, /^[A-Z2-7]{25}[AEIMQUY4]$/);
  }
});

test('base64url round trips and rejects non-canonical input', () => {
  assert.equal(b64url(Uint8Array.of(0xfb, 0xff)), '-_8');
  assert.deepEqual(fromB64url('-_8'), Uint8Array.of(0xfb, 0xff));
  const random = crypto.getRandomValues(new Uint8Array(257));
  assert.deepEqual(fromB64url(b64url(random)), random);
  for (const bad of ['-_9', 'abc$', 'a', 'ab==', '+/8']) assert.throws(() => fromB64url(bad), /invalid_base64url/);
});

test('sha256hex matches the FIPS 180-2 vector', async () => {
  assert.equal(await sha256hex(bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('memo parsing agrees with the matcher parser', () => {
  const code = newClaimCode();
  assert.equal(buildMemo(code, 'monthly'), `GP1 ${code} monthly`);
  assert.deepEqual(parseMemo(buildMemo(code, 'api100')), { claimCode: code, planId: 'api100' });
  assert.throws(() => buildMemo('A'.repeat(25) + 'B', 'monthly'), /invalid_claim_code/);
  assert.throws(() => buildMemo(code, 'Monthly'), /invalid_plan_id/);
  const cases = [
    `GP1 ${code} monthly`, `GP1 ${code} monthly\n`, `GP1 ${code} monthly extra`, `gp1 ${code} monthly`,
    `GP1 ${'A'.repeat(25)}B monthly`, `GP1 ${'A'.repeat(26)} ${'a'.repeat(64)}`, `GP1 ${'A'.repeat(26)} ${'a'.repeat(65)}`,
    `GP1 ${code} api-100`, ` GP1 ${code} monthly`, '', null,
  ];
  for (const text of cases) assert.deepEqual(parseMemo(text), parsePaymentMemo(text), String(text));
});

test('plans validate and serialize without bigint', () => {
  for (const plan of Object.values(PLANS)) assertPlan(plan);
  assert.deepEqual(publicPlan(PLANS.monthly), { id: 'monthly', label: '30 days', amountZec: '0.005', tokens: 30, mode: 'session' });
  assert.equal(JSON.stringify(publicPlan(PLANS.api100)), '{"id":"api100","label":"100 API calls","amountZec":"0.002","tokens":100,"mode":"per-request"}');
  assert.throws(() => assertPlan({ ...PLANS.monthly, id: 'api-100' }));
  assert.throws(() => assertPlan({ ...PLANS.monthly, priceZat: 0n }));
  assert.throws(() => assertPlan({ ...PLANS.monthly, tokens: 0 }));
  assert.throws(() => assertPlan({ ...PLANS.monthly, tokens: 1001 }));
});

test('periods roll over months and years in UTC', () => {
  assert.equal(currentPeriod(Date.UTC(2026, 9, 5, 12)), '2026-10');
  assert.equal(currentPeriod(Date.UTC(2026, 9, 31, 23, 59, 59, 999)), '2026-10');
  assert.equal(currentPeriod(Date.UTC(2026, 10, 1)), '2026-11');
  assert.equal(nextPeriod('2026-10'), '2026-11');
  assert.equal(nextPeriod('2026-12'), '2027-01');
  assert.equal(new Date(redeemUntil('2026-10')).toISOString(), '2026-11-15T00:00:00.000Z');
  assert.equal(new Date(redeemUntil('2026-12')).toISOString(), '2027-01-15T00:00:00.000Z');
  for (const bad of ['2026-13', '2026-00', '2026-1', '26-10']) assert.throws(() => redeemUntil(bad), /invalid_period/);
});

test('Authorization header round trips and rejects variants', () => {
  const token = { period: '2026-10', msg: b64url(new Uint8Array(64).fill(1)), sig: b64url(new Uint8Array(256).fill(2)) };
  const header = formatAuthorization(token);
  assert.deepEqual(parseAuthorization(header), token);
  for (const bad of [
    header.replace('v=1', 'v=2'), header.replace('2026-10', '2026-13'), header.replace(', msg', ',msg'),
    `${header} `, header.replace('Ghostpass', 'Bearer'), header.replace(/sig=.*/, 'sig='), undefined, null,
  ]) assert.equal(parseAuthorization(bad), null);
  assert.throws(() => formatAuthorization({ ...token, msg: 'a+b' }), /invalid_token/);
});

test('key log requires exactly one well-formed entry per merchant and period', () => {
  const h = 'a'.repeat(64);
  const log = keyLog({ v: 1, keys: [{ merchant: 'M', period: '2026-10', spkiSha256: h }, { merchant: 'N', period: '2026-10', spkiSha256: 'b'.repeat(64) }] });
  assert.equal(loggedKeyHash(log, 'M', '2026-10'), h);
  assert.throws(() => loggedKeyHash(log, 'M', '2026-11'), /key_not_logged/);
  const doubled = keyLog({ v: 1, keys: [...log.keys, { merchant: 'M', period: '2026-10', spkiSha256: 'c'.repeat(64) }] });
  assert.throws(() => loggedKeyHash(doubled, 'M', '2026-10'), /key_log_ambiguous/);
  for (const bad of [null, { v: 2, keys: [] }, { v: 1, keys: [{ merchant: 'M', period: '2026-10', spkiSha256: 'A'.repeat(64) }] }]) {
    assert.throws(() => keyLog(bad), /invalid_key_log/);
  }
});
