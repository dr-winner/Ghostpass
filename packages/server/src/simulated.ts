import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { reconcilePayments } from '@ghostpass/matcher';
import type { MatchResult } from '@ghostpass/matcher';
import { buildMemo, MAX_MONEY_ZAT } from '@ghostpass/core';

export const SIMULATED_ACCOUNT = 'simulated-payments';
const TIP_HEIGHT = 3_428_200;

/**
 * Dev mode (guide §14): a stand-in for zwatch. Fake outputs pass through the real matcher as a
 * fixture snapshot, so checkouts advance by the same rules as Mainnet payments. The matcher binds the
 * database to this simulated account, so a dev database can never be reused with a real watcher.
 */
export class SimulatedPayments {
  constructor(private readonly db: Database.Database, private readonly clock: () => number) {
    if (process.env.NODE_ENV === 'production') throw new Error('simulated_payments_in_production');
    db.exec(`CREATE TABLE IF NOT EXISTS simulated_outputs (
      txid TEXT PRIMARY KEY, claim_code TEXT NOT NULL, value_zat TEXT NOT NULL, memo TEXT NOT NULL
    )`);
  }

  /** Pays the full price unless `zat` is given (for example to demonstrate an underpayment and top-up). */
  pay(claimCode: string, zat?: bigint): void {
    const co = this.db.prepare('SELECT plan, price_zat, status FROM checkouts WHERE claim_code = ?').get(claimCode) as
      { plan: string; price_zat: number; status: string } | undefined;
    if (!co) throw new Error('unknown_claim');
    if (co.status === 'ISSUED') throw new Error('already_issued');
    const value = zat ?? BigInt(co.price_zat);
    if (value <= 0n || value > MAX_MONEY_ZAT) throw new Error('invalid_amount');
    this.db.prepare('INSERT INTO simulated_outputs (txid, claim_code, value_zat, memo) VALUES (?, ?, ?, ?)')
      .run(randomBytes(32).toString('hex'), claimCode, value.toString(), buildMemo(claimCode, co.plan));
    this.reconcile();
  }

  /** Mirrors forgetting txids after issuance. */
  forget(claimCode: string): void {
    this.db.prepare('DELETE FROM simulated_outputs WHERE claim_code = ?').run(claimCode);
  }

  reconcile(): MatchResult[] {
    const now = this.clock();
    const rows = this.db.prepare('SELECT txid, value_zat, memo FROM simulated_outputs ORDER BY rowid').all() as
      { txid: string; value_zat: string; memo: string }[];
    return reconcilePayments(this.db, {
      v: 1, accountId: SIMULATED_ACCOUNT, mode: 'fixture', tipHeight: TIP_HEIGHT, sinceHeight: 0, complete: true,
      lastSyncAt: new Date(now).toISOString(),
      outputs: rows.map(r => ({ txid: r.txid, pool: 4, outIndex: 0, height: TIP_HEIGHT - 1, confirmations: 2, valueZat: r.value_zat, memoText: r.memo })),
    }, { accountId: SIMULATED_ACCOUNT, allowFixture: true, now });
  }
}
