import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { formatAuthorization } from '../packages/core/src/index.ts';
import { GhostpassClient, memoryStore } from '../packages/client/src/index.ts';
import { DEV_PLACEHOLDER_ADDRESS, merchantEnv } from '../packages/demo-web/src/index.ts';
import type { MerchantEnv } from '../packages/demo-web/src/index.ts';
import { createNewsletter, NEWSLETTER } from '../apps/newsletter/src/app.ts';
import { API_DEMO, createApiDemo } from '../apps/api-demo/src/app.ts';
import { createDashboard } from '../apps/dashboard/src/app.ts';
import { POSTS } from '../apps/newsletter/src/posts.ts';

const KEK_HEX = '11'.repeat(32);

function devEnv(dir: string, app: { slug: string; name: string }): MerchantEnv {
  return {
    devMode: true, merchantName: app.name, merchantAddress: DEV_PLACEHOLDER_ADDRESS, kek: Buffer.from(KEK_HEX, 'hex'),
    dbPath: join(dir, `${app.slug}.sqlite`), keyLogPath: join(dir, 'KEYS.json'), keysUrl: '/dev/KEYS.json',
    payments: { kind: 'simulated' }, secureCookies: false, host: '127.0.0.1', port: 0, privacyDelayMs: [0, 0],
  };
}

async function listen(app: Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function stop(server: Server) {
  server.closeAllConnections();
  server.close();
}

async function subscribe(base: string, merchant: string, plan: string, tokens: number) {
  const client = new GhostpassClient({ base, merchant, keysUrl: `${base}/dev/KEYS.json`, store: memoryStore(), privacyDelayMs: [0, 0] });
  const co = await client.startCheckout(plan);
  assert.equal((await client.simulatePayment(co.claimCode)).status, 'CONFIRMED');
  assert.equal(await client.obtainTokens(co.claimCode, tokens), tokens);
  return client;
}

test('newsletter: checkout, simulated payment, issuance, session, protected post, and replay rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostpass-integration-'));
  const newsletter = await createNewsletter(devEnv(dir, NEWSLETTER));
  const { server, base } = await listen(newsletter.app);
  try {
    const subscribe_ = await fetch(`${base}/subscribe`);
    const html = await subscribe_.text();
    assert.equal(subscribe_.status, 200);
    assert.match(html, /DEV MODE: payments are simulated/);
    assert.match(html, /<script type="application\/json" id="gp-config">\{"merchant":"The Quiet Letter","keysUrl":"\/dev\/KEYS.json","devMode":true,"planId":"monthly"/);
    assert.match(subscribe_.headers.get('content-security-policy') ?? '', /^default-src 'none'; script-src 'self';/);
    assert.equal(subscribe_.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(subscribe_.headers.get('x-powered-by'), null);
    const js = await fetch(`${base}/assets/app.js`);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.ok((await js.text()).length > 10_000);
    assert.equal((await fetch(`${base}/assets/style.css`)).status, 200);

    const post = `${base}/posts/${POSTS[0]!.slug}`;
    const locked = await fetch(post, { redirect: 'manual' });
    assert.deepEqual([locked.status, locked.headers.get('location')], [303, '/subscribe']);

    const client = await subscribe(base, 'The Quiet Letter', 'monthly', 30);
    const token = await client.takeToken();
    const start = () => fetch(`${base}/session/start`, { method: 'POST', headers: { Authorization: formatAuthorization(token) } });
    const opened = await start();
    assert.equal(opened.status, 200);
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0]!;
    const reading = await fetch(post, { headers: { cookie } });
    assert.equal(reading.status, 200);
    assert.match(await reading.text(), new RegExp(POSTS[0]!.title));
    const replay = await start();
    assert.deepEqual([replay.status, await replay.json()], [401, { error: 'token_already_spent' }]);
    assert.equal((await client.summary()).count, 29);
    assert.equal((await fetch(`${base}/posts/no-such-post`, { headers: { cookie } })).status, 404);

    const log = JSON.parse(readFileSync(join(dir, 'KEYS.json'), 'utf8')) as { keys: { merchant: string }[] };
    assert.deepEqual(await (await fetch(`${base}/dev/KEYS.json`)).json(), log);
    assert.ok(log.keys.every(k => k.merchant === 'The Quiet Letter'));
  } finally {
    stop(server);
    await newsletter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API demo and dashboard: per-request tokens, replay rejection, and authenticated aggregate stats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostpass-integration-'));
  const newsletterEnv = devEnv(dir, NEWSLETTER);
  const apiEnv = devEnv(dir, API_DEMO);
  const newsletter = await createNewsletter(newsletterEnv);
  const api = await createApiDemo(apiEnv);
  const password = 'correct horse battery staple';
  const dashboard = await createDashboard({
    merchants: [{ name: 'The Quiet Letter', dbPath: newsletterEnv.dbPath }, { name: 'Private Price API', dbPath: apiEnv.dbPath }],
    password, devMode: true,
  });
  const n = await listen(newsletter.app);
  const a = await listen(api.app);
  const d = await listen(dashboard);
  try {
    const client = await subscribe(a.base, 'Private Price API', 'api100', 100);
    const first = await client.ghostFetch(`${a.base}/api/v1/price`);
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { dataset: string }).dataset, 'sample');
    const token = await client.takeToken();
    const call = () => fetch(`${a.base}/api/v1/price`, { headers: { Authorization: formatAuthorization(token) } });
    assert.equal((await call()).status, 200);
    const again = await call();
    assert.equal(again.status, 401);
    assert.match(again.headers.get('www-authenticate') ?? '', /^Ghostpass realm="Private Price API"/);
    // A token from one merchant is worthless at the other: each has its own keys.
    const newsletterClient = await subscribe(n.base, 'The Quiet Letter', 'monthly', 30);
    const foreign = await fetch(`${a.base}/api/v1/price`, { headers: { Authorization: formatAuthorization(await newsletterClient.takeToken()) } });
    assert.equal(foreign.status, 401);

    const auth = (user: string, pass: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });
    const anonymous = await fetch(d.base);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Basic realm="Ghostpass dashboard"/);
    assert.equal((await fetch(d.base, { headers: auth('admin', 'wrong password!!!') })).status, 401);
    assert.equal((await fetch(`${d.base}/assets/style.css`)).status, 401);
    const overview = await fetch(d.base, { headers: auth('anyone', password) });
    assert.equal(overview.status, 200);
    const html = await overview.text();
    assert.match(html, /Simulated payments: no wallet is connected/);
    assert.match(html, /<h2>Private Price API<\/h2><table>[\s\S]*<td>\d{4}-\d{2}<\/td><td>1<\/td><td>0.002<\/td><td>100<\/td><td>2<\/td>/);
    assert.match(html, /<h2>The Quiet Letter<\/h2><table>[\s\S]*<td>1<\/td><td>0.005<\/td><td>30<\/td><td>0<\/td>/);
    assert.doesNotMatch(html, /[A-Z2-7]{25}[AEIMQUY4]/);
    await assert.rejects(createDashboard({ merchants: [], password: 'short', devMode: true }), /at least 16/);
  } finally {
    for (const s of [n.server, a.server, d.server]) stop(s);
    await newsletter.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('environment: dev mode is refused in production and real mode requires its settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghostpass-env-'));
  try {
    const app = NEWSLETTER;
    assert.throws(() => merchantEnv(app, { GP_DEV_FAKE_PAYMENTS: '1', NODE_ENV: 'production' }), /not allowed with NODE_ENV=production/);
    assert.throws(() => merchantEnv(app, { GP_DEV_FAKE_PAYMENTS: 'true' }), /must be 1 or 0/);
    const dev = merchantEnv(app, { GP_DEV_FAKE_PAYMENTS: '1', GP_DEV_DIR: dir, GP_KEK_HEX: KEK_HEX, NEWSLETTER_PORT: '4000' });
    assert.deepEqual([dev.devMode, dev.port, dev.payments.kind, dev.secureCookies, dev.dbPath], [true, 4000, 'simulated', false, join(dir, 'newsletter.sqlite')]);
    const generated = merchantEnv(app, { GP_DEV_FAKE_PAYMENTS: '1', GP_DEV_DIR: dir });
    assert.equal(merchantEnv(app, { GP_DEV_FAKE_PAYMENTS: '1', GP_DEV_DIR: dir }).kek.length, 32);
    assert.deepEqual(generated.kek, merchantEnv(app, { GP_DEV_FAKE_PAYMENTS: '1', GP_DEV_DIR: dir }).kek);

    const real = {
      MERCHANT_UA: 'u1real', GP_KEK_HEX: KEK_HEX, ZWATCH_URL: 'http://127.0.0.1:8787', MERCHANT_ACCOUNT_ID: 'acct',
      ZWATCH_API_TOKEN: 'x'.repeat(32), GP_KEYS_URL: 'https://raw.githubusercontent.com/big14way/Ghostpass/main/KEYS.json',
      GP_NEWSLETTER_DB: join(dir, 'real', 'newsletter.sqlite'),
    };
    const ok = merchantEnv(app, real);
    assert.deepEqual([ok.devMode, ok.payments.kind, ok.secureCookies, ok.privacyDelayMs], [false, 'watcher', true, [60_000, 600_000]]);
    assert.throws(() => merchantEnv(app, { ...real, MERCHANT_UA: '' }), /Set MERCHANT_UA/);
    assert.throws(() => merchantEnv(app, { ...real, GP_KEK_HEX: 'abc' }), /GP_KEK_HEX/);
    assert.throws(() => merchantEnv(app, { ...real, ZWATCH_API_TOKEN: 'short' }), /at least 32/);
    assert.throws(() => merchantEnv(app, { ...real, GP_KEYS_URL: 'http://example.com/KEYS.json' }), /https/);
    assert.throws(() => merchantEnv(app, { ...real, NEWSLETTER_PORT: '70000' }), /TCP port/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
