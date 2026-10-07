import Database from 'better-sqlite3';
import { installPaymentTables } from '@ghostpass/matcher';

export function openDatabase(path: string, options: { readonly?: boolean } = {}): Database.Database {
  const db = new Database(path, { readonly: options.readonly === true, fileMustExist: options.readonly === true });
  db.pragma('busy_timeout = 5000');
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

/**
 * Guide §13 schema. There is deliberately no column linking a claim code (payment) to a spent token.
 * The payment ledger comes from the matcher and differs from the guide: its key includes the shielded pool.
 * `issuances` holds blind signatures for 24 hours so a subscriber whose response was lost can retry with
 * the identical blinded request; blinded values are uniformly random and reveal nothing about tokens.
 */
export function installSchema(db: Database.Database, merchant: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkouts (
      claim_code  TEXT PRIMARY KEY,
      plan        TEXT    NOT NULL,
      price_zat   INTEGER NOT NULL,
      paid_zat    INTEGER NOT NULL DEFAULT 0,
      min_conf    INTEGER NOT NULL DEFAULT 0,
      status      TEXT    NOT NULL DEFAULT 'AWAITING_PAYMENT',
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      issued_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS issuer_keys (
      period       TEXT PRIMARY KEY,
      spki         BLOB    NOT NULL,
      pkcs8_sealed BLOB    NOT NULL,
      redeem_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spent_tokens (
      period     TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      PRIMARY KEY (period, token_hash)
    );
    CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS stats (
      period   TEXT PRIMARY KEY,
      issued   INTEGER NOT NULL DEFAULT 0,
      redeemed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS issuances (
      claim_code   TEXT PRIMARY KEY REFERENCES checkouts(claim_code),
      request_hash TEXT    NOT NULL,
      period       TEXT    NOT NULL,
      blind_sigs   TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  installPaymentTables(db);
  // One merchant per database: refuse to mix two merchants' keys, checkouts, or spent sets.
  db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('merchant', ?)").run(merchant);
  const bound = db.prepare("SELECT v FROM meta WHERE k = 'merchant'").get() as { v: string };
  if (bound.v !== merchant) throw new Error('database_belongs_to_another_merchant');
}
