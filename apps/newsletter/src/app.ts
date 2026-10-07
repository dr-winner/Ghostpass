import { PLANS } from '@ghostpass/core';
import { createMerchantApp, esc, finish, page } from '@ghostpass/demo-web';
import type { MerchantEnv } from '@ghostpass/demo-web';
import { POSTS } from './posts.ts';

export const NEWSLETTER = { slug: 'newsletter', name: 'The Quiet Letter', portVar: 'NEWSLETTER_PORT', defaultPort: 3000 };

const nav = '<nav><a href="/">Posts</a><a href="/subscribe">Subscribe</a></nav>';

/** Demo 1 (guide §12): session mode. One token opens a 24-hour reading session. */
export async function createNewsletter(env: MerchantEnv) {
  const m = await createMerchantApp(env, { plans: [PLANS.monthly], browserEntry: new URL('./browser.ts', import.meta.url), tag: NEWSLETTER.slug });
  const { app, gp } = m;
  const site = env.merchantName;
  const render = (title: string, body: string, script = false) =>
    page({ title, site, devMode: env.devMode, body, nav, script, ...(script ? { config: m.pageConfig(PLANS.monthly.id) } : {}) });

  app.get('/', (_req, res) => {
    res.type('html').send(render('Posts', `
<h1>${esc(site)}</h1>
<p>A small newsletter about privacy, paid for with shielded ZEC. No account, email or password.</p>
<ul class="posts">
${POSTS.map(p => `<li><a href="/posts/${esc(p.slug)}">${esc(p.title)}</a><br><span class="note">${esc(p.summary)}</span></li>`).join('\n')}
</ul>
<p><a href="/subscribe">Subscribe or open a reading session</a></p>`));
  });

  app.get('/subscribe', (_req, res) => {
    res.type('html').send(render('Subscribe', `
<h1>Subscribe</h1>
<p>Pay once in shielded ZEC and your browser receives ${PLANS.monthly.tokens} blind-signed tokens. Each token opens a 24-hour reading session.
We can check a token is paid for and unused, but cannot link it to your payment or to your other tokens.</p>
<div class="card">
  <p id="wallet">Loading your tokens.</p>
  <button type="button" id="open-session">Open a 24-hour reading session (spends 1 token)</button>
  <p id="session-status" role="status"></p>
</div>
<h2>Buy a pass</h2>
<div id="checkout" class="card"><p>Loading checkout.</p></div>
<p class="note">Renewal: Zcash cannot pull money from a wallet, so every renewal is a fresh payment from you.</p>
<p class="note">Tokens live only in this browser. They are bearer tokens: anyone who copies them can use them.</p>`, true));
  });

  app.post('/session/start', gp.requireGhostpass(), gp.startSession);

  app.get('/posts/:slug', gp.requireSession({ redirectTo: '/subscribe' }), (req, res, next) => {
    const post = POSTS.find(p => p.slug === req.params.slug);
    if (!post) return next();
    res.set('Cache-Control', 'no-store').type('html').send(render(post.title, `
<article>
<h1>${esc(post.title)}</h1>
${post.paragraphs.map(p => `<p>${esc(p)}</p>`).join('\n')}
</article>
<p><a href="/">All posts</a></p>`));
  });

  finish(app, site, env.devMode, m.onError);
  return m;
}
