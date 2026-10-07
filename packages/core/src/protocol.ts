import type { PublicPlan } from './plans.ts';
import { isPeriod } from './period.ts';

/** RSABSSA-SHA384-PSS-Randomized (RFC 9474) with 2048-bit monthly keys. */
export const SUITE_NAME = 'RSABSSA-SHA384-PSS-Randomized';
export const RSA_MODULUS_BITS = 2048;
export const RSA_MODULUS_BYTES = RSA_MODULUS_BITS / 8;
/** The client signs a 32-byte random nonce; Randomized preparation prepends 32 more random bytes. */
export const TOKEN_NONCE_BYTES = 32;
export const TOKEN_MSG_BYTES = 64;

export type CheckoutStatus = 'AWAITING_PAYMENT' | 'DETECTED' | 'CONFIRMED' | 'UNDERPAID' | 'EXPIRED' | 'ISSUED';

export interface Token { period: string; msg: string; sig: string }

export interface WellKnownKey { period: string; spki: string; redeemUntil: string }
export interface WellKnown { v: 1; merchant: string; current: string; keys: WellKnownKey[]; plans: PublicPlan[] }

export interface CheckoutResponse { claimCode: string; uri: string; address: string; amountZec: string; memo: string; expiresAt: number }
export interface CheckoutStatusResponse { status: CheckoutStatus; paidZec: string; confirmations: number }
export interface IssueRequest { claimCode: string; period: string; blinded: string[] }
export interface IssueResponse { period: string; blindSigs: string[] }

const AUTH_RE = /^Ghostpass v=1, period=([0-9]{4}-(?:0[1-9]|1[0-2])), msg=([A-Za-z0-9_-]{1,1024}), sig=([A-Za-z0-9_-]{1,1024})$/;

export function formatAuthorization(token: Token): string {
  const value = `Ghostpass v=1, period=${token.period}, msg=${token.msg}, sig=${token.sig}`;
  if (!AUTH_RE.test(value)) throw new Error('invalid_token');
  return value;
}

export function parseAuthorization(header: string | null | undefined): Token | null {
  const m = AUTH_RE.exec(header ?? '');
  return m && m[1] && m[2] && m[3] ? { period: m[1], msg: m[2], sig: m[3] } : null;
}

/**
 * KEYS.json: an append-only public log of issuer key hashes. A client accepts a key only when
 * the log holds exactly one entry for that merchant and period and its hash matches the served key.
 */
export interface KeyLogEntry { merchant: string; period: string; spkiSha256: string }
export interface KeyLog { v: 1; keys: KeyLogEntry[] }

export function keyLog(value: unknown): KeyLog {
  const o = value as Partial<KeyLog> | null;
  if (typeof o !== 'object' || o === null || o.v !== 1 || !Array.isArray(o.keys)) throw new Error('invalid_key_log');
  for (const k of o.keys as unknown[]) {
    const e = k as Partial<KeyLogEntry> | null;
    if (typeof e !== 'object' || e === null || typeof e.merchant !== 'string' || !e.merchant ||
        !isPeriod(e.period) || typeof e.spkiSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.spkiSha256)) {
      throw new Error('invalid_key_log');
    }
  }
  return { v: 1, keys: (o.keys as KeyLogEntry[]).map(k => ({ merchant: k.merchant, period: k.period, spkiSha256: k.spkiSha256 })) };
}

export function loggedKeyHash(log: KeyLog, merchant: string, period: string): string {
  const matches = log.keys.filter(k => k.merchant === merchant && k.period === period);
  if (matches.length !== 1 || !matches[0]) throw new Error(matches.length ? 'key_log_ambiguous' : 'key_not_logged');
  return matches[0].spkiSha256;
}
