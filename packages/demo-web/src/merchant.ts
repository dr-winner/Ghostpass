import { readFile } from 'node:fs/promises';
import { createGhostpass, openDatabase } from '@ghostpass/server';
import type { Plan } from '@ghostpass/core';
import type { MerchantEnv } from './config.ts';
import type { PageConfig } from './browser.ts';
import { baseApp, serveAssets } from './http.ts';

/** Shared wiring for a demo merchant: its own database, keys, and Ghostpass endpoints. */
export async function createMerchantApp(env: MerchantEnv, options: { plans: Plan[]; browserEntry: URL; tag: string }) {
  const db = openDatabase(env.dbPath);
  const onError = (code: string) => { console.error(`[${options.tag}] ${code}`); };
  const gp = createGhostpass({
    db, merchantName: env.merchantName, merchantAddress: env.merchantAddress, plans: options.plans, kek: env.kek,
    keyLogPath: env.keyLogPath, payments: env.payments, secureCookies: env.secureCookies, onError,
  });
  try {
    await gp.start();
    const app = baseApp(env.keysUrl);
    app.use(gp.router);
    if (env.devMode) {
      // Dev keys are throwaway, so their log stays local; real keys are checked against the public repository.
      app.get('/dev/KEYS.json', async (_req, res) => {
        res.type('json').set('Cache-Control', 'no-store').send(await readFile(env.keyLogPath));
      });
    }
    await serveAssets(app, options.browserEntry, !env.devMode);
    const pageConfig = (planId: string): PageConfig => ({
      merchant: env.merchantName, keysUrl: env.keysUrl, devMode: env.devMode, planId, privacyDelayMs: env.privacyDelayMs,
    });
    return {
      app, gp, db, onError, pageConfig,
      async close() { await gp.stop(); db.close(); },
    };
  } catch (error) {
    await gp.stop();
    db.close();
    throw error;
  }
}
