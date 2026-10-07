// Issuer keys rotate per calendar month (UTC). Tokens stay redeemable until 00:00 UTC on the 15th of the next month.
export const PERIOD_RE = /^([0-9]{4})-(0[1-9]|1[0-2])$/;

function parse(period: string): [number, number] {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error('invalid_period');
  return [Number(m[1]), Number(m[2])];
}

export function isPeriod(value: unknown): value is string {
  return typeof value === 'string' && PERIOD_RE.test(value);
}

export function currentPeriod(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function nextPeriod(period: string): string {
  const [y, m] = parse(period);
  return currentPeriod(Date.UTC(y, m, 1));
}

/** Date.UTC rolls month 12 over to January of the following year. */
export function redeemUntil(period: string): number {
  const [y, m] = parse(period);
  return Date.UTC(y, m, 15);
}
