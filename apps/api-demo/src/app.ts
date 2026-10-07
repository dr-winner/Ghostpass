import { PLANS } from '@ghostpass/core';
import { createMerchantApp, esc, finish, page } from '@ghostpass/demo-web';
import type { MerchantEnv } from '@ghostpass/demo-web';

export const API_DEMO = { slug: 'api-demo', name: 'Private Price API', portVar: 'API_DEMO_PORT', defaultPort: 3001 };

/** Clearly labelled sample data: the point of the demo is the payment, not the dataset. */
const SAMPLE_PRICES = [
  { item: 'coffee', zec: '0.01' },
  { item: 'paperback book', zec: '0.12' },
  { item: 'train ticket', zec: '0.35' },
];

/** Demo 2 (guide §12): per-request mode. Every API call spends one token. */
export async function createApiDemo(env: MerchantEnv) {
  const m = await createMerchantApp(env, { plans: [PLANS.api100], browserEntry: new URL('./browser.ts', import.meta.url), tag: API_DEMO.slug });
  const { app, gp } = m;
  const site = env.merchantName;

  app.get('/', (_req, res) => {
    res.type('html').send(page({
      title: 'Pay per call', site, devMode: env.devMode, script: true, config: m.pageConfig(PLANS.api100.id), body: `
<h1>${esc(site)}</h1>
<p>A small API where every call costs one blind-signed token. Buy ${PLANS.api100.tokens} calls with shielded ZEC; no API key, account or email.
Calls cannot be linked to your payment or to each other.</p>
<div class="card">
  <p id="wallet">Loading your tokens.</p>
  <button type="button" id="call">Call GET /api/v1/price (spends 1 token)</button>
  <button type="button" id="export" class="secondary">Export one token as a curl command</button>
  <p id="call-status" role="status"></p>
  <pre id="output" hidden></pre>
</div>
<h2>Buy calls</h2>
<div id="checkout" class="card"><p>Loading checkout.</p></div>
<p class="note">An exported token is removed from this browser and works exactly once. A second use is rejected with 401.</p>`,
    }));
  });

  app.get('/api/v1/price', gp.requireGhostpass(), (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      service: site, dataset: 'sample', note: 'Sample prices for the Ghostpass demo. This response cost one unlinkable token.',
      servedAt: new Date().toISOString(), prices: SAMPLE_PRICES,
    });
  });

  finish(app, site, env.devMode, m.onError);
  return m;
}
