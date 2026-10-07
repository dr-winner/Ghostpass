import type Database from 'better-sqlite3';

export interface PeriodStats {
  period: string;
  /** Checkouts created in this month that were paid in full and confirmed (including those already issued). */
  checkoutsPaid: number;
  /** Sum of those checkouts' payments, in zatoshis, as a decimal string. */
  receivedZat: string;
  tokensIssued: number;
  tokensRedeemed: number;
}

/** Aggregate counts only: the schema has no per-subscriber rows to show. Works on a read-only database. */
export function merchantStats(db: Database.Database): PeriodStats[] {
  const checkouts = db.prepare(`
    SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS period, COUNT(*) AS paid, SUM(paid_zat) AS received
    FROM checkouts WHERE status IN ('CONFIRMED', 'ISSUED') GROUP BY period`).all() as { period: string; paid: number; received: number }[];
  const tokens = db.prepare('SELECT period, issued, redeemed FROM stats').all() as { period: string; issued: number; redeemed: number }[];
  const byPeriod = new Map<string, PeriodStats>();
  const entry = (period: string) => {
    let e = byPeriod.get(period);
    if (!e) {
      e = { period, checkoutsPaid: 0, receivedZat: '0', tokensIssued: 0, tokensRedeemed: 0 };
      byPeriod.set(period, e);
    }
    return e;
  };
  for (const c of checkouts) Object.assign(entry(c.period), { checkoutsPaid: c.paid, receivedZat: String(c.received) });
  for (const t of tokens) Object.assign(entry(t.period), { tokensIssued: t.issued, tokensRedeemed: t.redeemed });
  return [...byPeriod.values()].sort((a, b) => b.period.localeCompare(a.period));
}
