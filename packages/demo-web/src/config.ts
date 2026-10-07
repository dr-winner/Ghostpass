import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PaymentSource } from '@ghostpass/server';

export interface MerchantEnv {
  devMode: boolean;
  merchantName: string;
  merchantAddress: string;
  kek: Uint8Array;
  dbPath: string;
  keyLogPath: string;
  /** Where browsers fetch KEYS.json: the public repository in real mode, this server in dev mode. */
  keysUrl: string;
  payments: PaymentSource;
  secureCookies: boolean;
  host: string;
  port: number;
  privacyDelayMs: [number, number];
}

type Env = Record<string, string | undefined>;

/** Wallets reject this address, so a dev-mode QR code can never send real ZEC. */
export const DEV_PLACEHOLDER_ADDRESS = 'u1devmodesimulatedpaymentsonlynotarealaddress';
export const DEV_DIR = '.local/dev';

export function devModeEnabled(env: Env = process.env): boolean {
  const flag = env.GP_DEV_FAKE_PAYMENTS;
  if (flag !== undefined && flag !== '' && flag !== '0' && flag !== '1') throw new Error('GP_DEV_FAKE_PAYMENTS must be 1 or 0');
  const on = flag === '1';
  if (on && env.NODE_ENV === 'production') throw new Error('Refusing to start: GP_DEV_FAKE_PAYMENTS=1 is not allowed with NODE_ENV=production');
  return on;
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env (see .env.example)`);
  return value;
}

function port(env: Env, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a TCP port`);
  return value;
}

function kekFromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('GP_KEK_HEX must be 32 bytes of hex (openssl rand -hex 32)');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Dev mode keeps a local key-encryption key so the dev database survives restarts. */
function devKek(env: Env, devDir: string): Uint8Array {
  if (env.GP_KEK_HEX) return kekFromHex(env.GP_KEK_HEX);
  const path = resolve(devDir, 'kek.hex');
  try { return kekFromHex(readFileSync(path, 'utf8').trim()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const hex = randomBytes(32).toString('hex');
  writeFileSync(path, `${hex}\n`, { mode: 0o600, flag: 'wx' });
  return kekFromHex(hex);
}

export function merchantEnv(app: { slug: string; name: string; portVar: string; defaultPort: number }, env: Env = process.env): MerchantEnv {
  const devMode = devModeEnabled(env);
  const common = { merchantName: app.name, host: env.GP_HOST ?? '127.0.0.1', port: port(env, app.portVar, app.defaultPort) };
  let config: MerchantEnv;
  if (devMode) {
    const devDir = resolve(env.GP_DEV_DIR ?? DEV_DIR);
    config = {
      ...common, devMode, merchantAddress: DEV_PLACEHOLDER_ADDRESS, kek: devKek(env, devDir),
      dbPath: resolve(devDir, `${app.slug}.sqlite`), keyLogPath: resolve(devDir, 'KEYS.json'), keysUrl: '/dev/KEYS.json',
      payments: { kind: 'simulated' }, secureCookies: false,
      // Shortened so judges can try the flow; real mode uses the guide's 1-10 minutes.
      privacyDelayMs: [5_000, 15_000],
    };
  } else {
    const token = required(env, 'ZWATCH_API_TOKEN');
    if (token.length < 32) throw new Error('ZWATCH_API_TOKEN must be at least 32 characters');
    const keysUrl = required(env, 'GP_KEYS_URL');
    if (!/^https:\/\//.test(keysUrl)) throw new Error('GP_KEYS_URL must be an https URL of the public KEYS.json');
    config = {
      ...common, devMode, merchantAddress: required(env, 'MERCHANT_UA'), kek: kekFromHex(required(env, 'GP_KEK_HEX')),
      dbPath: resolve(env[`GP_${app.slug.toUpperCase().replace(/-/g, '_')}_DB`] ?? `.local/${app.slug}.sqlite`),
      keyLogPath: resolve(env.GP_KEYS_LOG ?? 'KEYS.json'), keysUrl,
      payments: { kind: 'watcher', url: required(env, 'ZWATCH_URL'), accountId: required(env, 'MERCHANT_ACCOUNT_ID'), token },
      secureCookies: true, privacyDelayMs: [60_000, 600_000],
    };
  }
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  return config;
}
