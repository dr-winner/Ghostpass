import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import express from 'express';
import type { ErrorRequestHandler, Express, RequestHandler } from 'express';

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

/**
 * Guide §15.3: no third-party scripts, fonts, or analytics, and no request logging (so no IP addresses).
 * Scripts and styles come only from this origin; the public key log may be fetched from its own origin.
 */
export function securityHeaders(keysUrl: string): RequestHandler {
  const connect = ["'self'"];
  if (/^https:\/\//.test(keysUrl)) connect.push(new URL(keysUrl).origin);
  const csp = [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", `connect-src ${connect.join(' ')}`,
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    });
    next();
  };
}

export interface PageOptions {
  title: string;
  site: string;
  devMode: boolean;
  body: string;
  /** Exposed to the page script as JSON; never executed. */
  config?: unknown;
  script?: boolean;
  nav?: string;
}

export function page(o: PageOptions): string {
  const config = o.config === undefined ? '' :
    `<script type="application/json" id="gp-config">${JSON.stringify(o.config).replace(/</g, '\\u003c')}</script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(o.title)} · ${esc(o.site)}</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
${o.devMode ? '<div class="dev-banner" role="alert">DEV MODE: payments are simulated</div>' : ''}
<header class="site"><a class="brand" href="/">${esc(o.site)}</a>${o.nav ?? ''}</header>
<main>
${o.body}
</main>
<footer class="site">Paid with shielded ZEC through Ghostpass. No accounts, no email, no tracking. For network privacy, use Tor Browser or a VPN.</footer>
${config}
${o.script ? '<script type="module" src="/assets/app.js"></script>' : ''}
</body>
</html>
`;
}

export async function bundle(entry: URL, minify: boolean): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(entry)], bundle: true, write: false, format: 'esm', platform: 'browser',
    target: 'es2022', minify, legalComments: 'none', logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error('bundle_failed');
  return output.text;
}

export async function serveStyle(app: Express): Promise<void> {
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  app.get('/assets/style.css', (_req, res) => { res.type('text/css').set('Cache-Control', 'no-cache').send(css); });
}

/** Serves the page script and the shared stylesheet. */
export async function serveAssets(app: Express, entry: URL, minify: boolean): Promise<void> {
  const js = await bundle(entry, minify);
  app.get('/assets/app.js', (_req, res) => { res.type('text/javascript').set('Cache-Control', 'no-cache').send(js); });
  await serveStyle(app);
}

export function finish(app: Express, site: string, devMode: boolean, onError: (code: string) => void): void {
  app.use((_req, res) => {
    res.status(404).type('html').send(page({ title: 'Not found', site, devMode, body: '<h1>Not found</h1><p><a href="/">Home</a></p>' }));
  });
  app.use(((_error, _req, res, next) => {
    if (res.headersSent) return next(_error);
    onError('request_failed');
    res.status(500).type('html').send(page({ title: 'Error', site, devMode, body: '<h1>Something went wrong</h1>' }));
  }) as ErrorRequestHandler);
}

export function baseApp(keysUrl: string): Express {
  const app = express();
  app.disable('x-powered-by');
  // TLS terminates at a local reverse proxy; trust only loopback for X-Forwarded-*.
  app.set('trust proxy', 'loopback');
  app.use(securityHeaders(keysUrl));
  return app;
}
