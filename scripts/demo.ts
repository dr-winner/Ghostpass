import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { loadEnvFile } from 'node:process';
import type { Express } from 'express';
import { devModeEnabled, merchantEnv } from '../packages/demo-web/src/index.ts';
import { createNewsletter, NEWSLETTER } from '../apps/newsletter/src/app.ts';
import { API_DEMO, createApiDemo } from '../apps/api-demo/src/app.ts';
import { createDashboard, DASHBOARD } from '../apps/dashboard/src/app.ts';

// Starts both demo merchants and the dashboard. `pnpm dev` sets GP_DEV_FAKE_PAYMENTS=1 (simulated payments).
try { loadEnvFile('.env'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const devMode = devModeEnabled();
const newsletterEnv = merchantEnv(NEWSLETTER);
const apiEnv = merchantEnv(API_DEMO);
let password = process.env.GP_ADMIN_PASSWORD ?? '';
if (!password) {
  if (!devMode) throw new Error('Set GP_ADMIN_PASSWORD (16+ characters) in .env for the dashboard');
  password = randomBytes(12).toString('base64url');
}
const dashboardPort = Number(process.env[DASHBOARD.portVar] ?? DASHBOARD.defaultPort);
if (!Number.isSafeInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) throw new Error(`${DASHBOARD.portVar} must be a TCP port`);

const newsletter = await createNewsletter(newsletterEnv);
const api = await createApiDemo(apiEnv);
const dashboard = await createDashboard({
  merchants: [{ name: newsletterEnv.merchantName, dbPath: newsletterEnv.dbPath }, { name: apiEnv.merchantName, dbPath: apiEnv.dbPath }],
  password, devMode,
  ...(newsletterEnv.payments.kind === 'watcher' ? { watcher: newsletterEnv.payments } : {}),
});

async function listen(app: Express, host: string, port: number): Promise<Server> {
  const server = app.listen(port, host);
  await once(server, 'listening');
  return server;
}

const servers = [
  await listen(newsletter.app, newsletterEnv.host, newsletterEnv.port),
  await listen(api.app, apiEnv.host, apiEnv.port),
  await listen(dashboard, newsletterEnv.host, dashboardPort),
];
if (devMode) console.log('DEV MODE: payments are simulated. No real Zcash wallet is connected.');
console.log(`${newsletterEnv.merchantName}: http://${newsletterEnv.host}:${newsletterEnv.port}`);
console.log(`${apiEnv.merchantName}: http://${apiEnv.host}:${apiEnv.port}`);
console.log(`Dashboard: http://${newsletterEnv.host}:${dashboardPort}`);
if (!process.env.GP_ADMIN_PASSWORD) console.log(`Dashboard password for this run (any user name): ${password}`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  void Promise.all([newsletter.close(), api.close()]).then(() => { process.exitCode = 0; });
});
