import {
  constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  privateDecrypt, publicEncrypt, randomBytes, timingSafeEqual,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import type Database from 'better-sqlite3';
import { b64url, currentPeriod, keyLog, nextPeriod, redeemUntil, RSA_MODULUS_BITS, RSA_MODULUS_BYTES } from '@ghostpass/core';
import type { KeyLog, KeyLogEntry, WellKnownKey } from '@ghostpass/core';

export const suite = RSABSSA.SHA384.PSS.Randomized();

// Private keys are encrypted at rest with a 32-byte key-encryption key; the period is bound as associated data.
export function seal(kek: Buffer, period: string, data: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(`ghostpass-issuer-key:${period}`));
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function unseal(kek: Buffer, period: string, blob: Buffer): Buffer {
  if (blob.length <= 28) throw new Error('invalid_sealed_key');
  const d = createDecipheriv('aes-256-gcm', kek, blob.subarray(0, 12));
  d.setAAD(Buffer.from(`ghostpass-issuer-key:${period}`));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export interface Signer { period: string; privateKey: KeyObject; publicKey: KeyObject; modulus: Buffer }

/** RFC 9474 RSASP1 inputs must be modulus-length integers below n; check before any checkout state changes. */
export function acceptsBlinded(signer: Signer, blinded: Uint8Array): boolean {
  return blinded.length === RSA_MODULUS_BYTES && Buffer.compare(Buffer.from(blinded), signer.modulus) < 0;
}

/**
 * RFC 9474 BlindSign using OpenSSL's raw RSA operation (blinded, CRT) instead of the library's
 * pure-JS bignums, which take about 300 ms per signature. Step 4 rejects faulty CRT results.
 */
export function blindSign(signer: Signer, blinded: Uint8Array): Uint8Array {
  if (!acceptsBlinded(signer, blinded)) throw new Error('invalid_blinded_message');
  const s = privateDecrypt({ key: signer.privateKey, padding: constants.RSA_NO_PADDING }, blinded);
  const m = publicEncrypt({ key: signer.publicKey, padding: constants.RSA_NO_PADDING }, s);
  if (s.length !== RSA_MODULUS_BYTES || m.length !== RSA_MODULUS_BYTES || !timingSafeEqual(m, blinded)) {
    throw new Error('signing_failure');
  }
  return new Uint8Array(s);
}

export async function readKeyLog(path: string): Promise<KeyLog> {
  try { return keyLog(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, keys: [] };
    throw error;
  }
}

// Merchants in one process may share a log file; serialize read-modify-write per file.
const logQueues = new Map<string, Promise<void>>();

/** Appends missing entries; a different hash for an already logged merchant and period is fatal. */
export function appendKeyLog(path: string, entries: KeyLogEntry[]): Promise<void> {
  const file = resolve(path);
  const next = (logQueues.get(file) ?? Promise.resolve()).catch(() => {}).then(() => appendNow(file, entries));
  logQueues.set(file, next);
  const settle = () => { if (logQueues.get(file) === next) logQueues.delete(file); };
  void next.then(settle, settle);
  return next;
}

async function appendNow(path: string, entries: KeyLogEntry[]): Promise<void> {
  const log = await readKeyLog(path);
  let changed = false;
  for (const entry of entries) {
    const logged = log.keys.filter(k => k.merchant === entry.merchant && k.period === entry.period);
    if (logged.length > 1 || (logged[0] && logged[0].spkiSha256 !== entry.spkiSha256)) throw new Error('key_log_conflict');
    if (!logged.length) {
      log.keys.push(entry);
      changed = true;
    }
  }
  if (!changed) return;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(log, null, 2)}\n`);
  await rename(tmp, path);
}

interface KeyRow { period: string; spki: Buffer; pkcs8_sealed: Buffer; redeem_until: number }

export class IssuerKeys {
  private readonly kek: Buffer;
  private readonly signers = new Map<string, Signer>();
  private readonly verifiers = new Map<string, CryptoKey>();
  private ensuring: Promise<void> | undefined;

  constructor(private readonly db: Database.Database, private readonly merchant: string, kek: Uint8Array, private readonly logPath: string) {
    if (kek.length !== 32) throw new Error('kek_must_be_32_bytes');
    this.kek = Buffer.from(kek);
  }

  private row(period: string): KeyRow | undefined {
    return this.db.prepare('SELECT period, spki, pkcs8_sealed, redeem_until FROM issuer_keys WHERE period = ?').get(period) as KeyRow | undefined;
  }

  /** Startup and hourly: the current and next period have keys, every redeemable key is logged, and the KEK unseals them. */
  ensure(now: number): Promise<void> {
    this.ensuring ??= this.doEnsure(now).finally(() => { this.ensuring = undefined; });
    return this.ensuring;
  }

  private async doEnsure(now: number): Promise<void> {
    const current = currentPeriod(now);
    for (const period of [current, nextPeriod(current)]) {
      if (this.row(period)) continue;
      const { privateKey, publicKey } = await suite.generateKey({ publicExponent: Uint8Array.from([1, 0, 1]), modulusLength: RSA_MODULUS_BITS });
      const spki = Buffer.from(await crypto.subtle.exportKey('spki', publicKey));
      const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey));
      try {
        this.db.prepare('INSERT INTO issuer_keys (period, spki, pkcs8_sealed, redeem_until) VALUES (?, ?, ?, ?)')
          .run(period, spki, seal(this.kek, period, pkcs8), redeemUntil(period));
      } finally { pkcs8.fill(0); }
    }
    const rows = this.db.prepare('SELECT period, spki FROM issuer_keys WHERE redeem_until > ? ORDER BY period').all(now) as Pick<KeyRow, 'period' | 'spki'>[];
    await appendKeyLog(this.logPath, rows.map(r => ({
      merchant: this.merchant, period: r.period, spkiSha256: createHash('sha256').update(r.spki).digest('hex'),
    })));
    this.signer(current);
  }

  /** Keys published in /.well-known: not future periods, still inside their redeem window, oldest first. */
  published(now: number): WellKnownKey[] {
    const rows = this.db.prepare('SELECT period, spki, redeem_until FROM issuer_keys WHERE period <= ? AND redeem_until > ? ORDER BY period')
      .all(currentPeriod(now), now) as Omit<KeyRow, 'pkcs8_sealed'>[];
    return rows.map(r => ({ period: r.period, spki: b64url(r.spki), redeemUntil: new Date(r.redeem_until).toISOString() }));
  }

  async publicIfRedeemable(period: string, now: number): Promise<CryptoKey | null> {
    const row = this.row(period);
    if (!row || period > currentPeriod(now) || row.redeem_until <= now) return null;
    let key = this.verifiers.get(period);
    if (!key) {
      key = await crypto.subtle.importKey('spki', new Uint8Array(row.spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
      this.verifiers.set(period, key);
    }
    return key;
  }

  signer(period: string): Signer {
    const cached = this.signers.get(period);
    if (cached) return cached;
    const row = this.row(period);
    if (!row) throw new Error('issuer_key_unavailable');
    const pkcs8 = unseal(this.kek, period, row.pkcs8_sealed);
    let privateKey: KeyObject;
    try { privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }); }
    finally { pkcs8.fill(0); }
    const publicKey = createPublicKey({ key: row.spki, format: 'der', type: 'spki' });
    const modulus = Buffer.from(publicKey.export({ format: 'jwk' }).n ?? '', 'base64url');
    if (privateKey.asymmetricKeyType !== 'rsa' || modulus.length !== RSA_MODULUS_BYTES) throw new Error('unsupported_issuer_key');
    const signer = { period, privateKey, publicKey, modulus };
    this.signers.set(period, signer);
    return signer;
  }
}
