import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { RequestHandler } from 'express';
import { zatToZec } from '@ghostpass/core';
import { merchantStats, openDatabase } from '@ghostpass/server';
import type { PeriodStats } from '@ghostpass/server';
import { decimalZat, integer, object } from '@ghostpass/watcher-contract';
import { baseApp, esc, finish, page, serveStyle } from '@ghostpass/demo-web';

export const DASHBOARD = { portVar: 'DASHBOARD_PORT', defaultPort: 3002 };

export interface DashboardOptions {
  merchants: { name: string; dbPath: string }[];
  /** HTTP Basic password; any user name is accepted. Serve only over HTTPS outside localhost. */
  password: string;
  devMode: boolean;
  watcher?: { url: string; accountId: string; token: string };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

function basicAuth(password: string): RequestHandler {
  if (password.length < 16) throw new Error('GP_ADMIN_PASSWORD must be at least 16 characters');
  const expected = sha256(password);
  return (req, res, next) => {
    const m = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(req.get('authorization') ?? '');
    const decoded = m?.[1] ? Buffer.from(m[1], 'base64').toString('utf8') : '';
    const colon = decoded.indexOf(':');
    if (colon < 0 || !timingSafeEqual(sha256(decoded.slice(colon + 1)), expected)) {
      res.set('WWW-Authenticate', 'Basic realm="Ghostpass dashboard", charset="UTF-8"').status(401).type('text').send('Authentication required');
      return;
    }
    res.set('Cache-Control', 'no-store');
    next();
  };
}

async function walletBalance(w: NonNullable<DashboardOptions['watcher']>): Promise<string> {
  try {
    const url = new URL(`/accounts/${encodeURIComponent(w.accountId)}/balance`, w.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return 'unavailable (zwatch must be on loopback)';
    const r = await fetch(url, { headers: { Authorization: `Bearer ${w.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!r.ok) return `unavailable (zwatch returned ${r.status})`;
    const b = object(await r.json());
    const confirmed = zatToZec(BigInt(decimalZat(b.confirmedZat)));
    const pending = zatToZec(BigInt(decimalZat(b.pendingZat)));
    return `${confirmed} ZEC spendable, ${pending} ZEC pending (zwatch tip height ${integer(b.tipHeight, 'tip_height')})`;
  } catch {
    return 'unavailable (zwatch did not respond)';
  }
}

function table(rows: PeriodStats[]): string {
  if (!rows.length) return '<p class="note">No paid checkouts or tokens yet.</p>';
  return `<table>
<thead><tr><th>Period</th><th>Checkouts paid</th><th>ZEC received</th><th>Tokens issued</th><th>Tokens redeemed</th></tr></thead>
<tbody>
${rows.map(r => `<tr><td>${esc(r.period)}</td><td>${r.checkoutsPaid}</td><td>${esc(zatToZec(BigInt(r.receivedZat)))}</td><td>${r.tokensIssued}</td><td>${r.tokensRedeemed}</td></tr>`).join('\n')}
</tbody>
</table>`;
}

function merchantSection(m: DashboardOptions['merchants'][number]): string {
  let body: string;
  if (!existsSync(m.dbPath)) body = '<p class="note">Not started yet.</p>';
  else {
    try {
      const db = openDatabase(m.dbPath, { readonly: true });
      try { body = table(merchantStats(db)); }
      finally { db.close(); }
    } catch { body = '<p class="error">Database unavailable.</p>'; }
  }
  return `<section class="card"><h2>${esc(m.name)}</h2>${body}</section>`;
}

/** Guide §12: aggregate statistics only. The schema has no per-subscriber rows to show. */
export async function createDashboard(o: DashboardOptions) {
  const app = baseApp('');
  app.use(basicAuth(o.password));
  await serveStyle(app);
  const site = 'Ghostpass dashboard';

  app.get('/', async (_req, res) => {
    const balance = o.watcher ? await walletBalance(o.watcher) : 'Simulated payments: no wallet is connected.';
    res.type('html').send(page({
      title: 'Overview', site, devMode: o.devMode, body: `
<h1>Merchant overview</h1>
<p>Per month: checkouts created that month and paid in full, ZEC they received, and tokens issued and redeemed.</p>
<p class="card">Merchant wallet (viewing key via zwatch): <strong>${esc(balance)}</strong></p>
${o.merchants.map(merchantSection).join('\n')}
<p class="note">There are no per-subscriber rows here because none exist: the database has no column linking a payment to a spent token.</p>`,
    }));
  });

  finish(app, site, o.devMode, code => { console.error(`[dashboard] ${code}`); });
  return app;
}
