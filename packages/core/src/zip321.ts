import { b64url } from './encoding.ts';

export const MAX_MONEY_ZAT = 2_100_000_000_000_000n;
export const MAX_MEMO_BYTES = 512;

export function zatToZec(zat: bigint): string {
  if (zat < 0n || zat > MAX_MONEY_ZAT) throw new Error('invalid_amount');
  const whole = zat / 100_000_000n;
  const frac = (zat % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Single-payment ZIP 321 URI: zcash:<address>?amount=<ZEC>&memo=<base64url>&message=<pct-encoded>. */
export function buildZip321(address: string, zat: bigint, memoText?: string, message?: string): string {
  if (!/^[A-Za-z0-9]+$/.test(address)) throw new Error('zip321_invalid_address');
  if (zat <= 0n) throw new Error('zip321_amount_must_be_positive');
  const params: string[] = [`amount=${zatToZec(zat)}`];
  if (memoText !== undefined) {
    // ZIP 321 makes the whole URI invalid when a memo is attached to a transparent (t-addr or TEX) address.
    if (address.startsWith('t')) throw new Error('zip321_memo_on_transparent_address');
    const memo = new TextEncoder().encode(memoText);
    if (memo.length > MAX_MEMO_BYTES) throw new Error('zip321_memo_too_long');
    params.push(`memo=${b64url(memo)}`);
  }
  if (message) params.push(`message=${encodeURIComponent(message)}`);
  return `zcash:${address}?${params.join('&')}`;
}
