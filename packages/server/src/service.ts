import express from 'express';
import type { ErrorRequestHandler, RequestHandler, Response, Router } from 'express';
import cookieParser from 'cookie-parser';
import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { forgetIssuedPayments } from '@ghostpass/matcher';
import { PaymentMatcher } from '@ghostpass/matcher/poller';
import {
  assertPlan, b64url, buildMemo, buildZip321, CLAIM_CODE_RE, currentPeriod, fromB64url, isPeriod, MAX_TOKENS_PER_PLAN,
  newClaimCode, parseAuthorization, publicPlan, RSA_MODULUS_BYTES, TOKEN_MSG_BYTES, zatToZec,
} from '@ghostpass/core';
import type {
  CheckoutResponse, CheckoutStatus, CheckoutStatusResponse, IssueResponse, Plan, WellKnown,
} from '@ghostpass/core';
import { installSchema } from './schema.ts';
import { acceptsBlinded, blindSign, IssuerKeys, suite } from './keys.ts';
import type { Signer } from './keys.ts';
import { SimulatedPayments } from './simulated.ts';

export type PaymentSource =
  | { kind: 'watcher'; url: string; accountId: string; token: string; intervalMs?: number }
  | { kind: 'simulated' };

export interface GhostpassConfig {
  db: Database.Database;
  merchantName: string;
  /** MERCHANT_UA: a shielded Unified Address (memos are invalid on transparent addresses). */
  merchantAddress: string;
  plans: readonly Plan[];
  /** 32-byte key-encryption key for issuer private keys at rest. */
  kek: Uint8Array;
  /** KEYS.json to append public key hashes to (guide §15.1). */
  keyLogPath: string;
  payments: PaymentSource;
  /** Session cookies require HTTPS unless this is false (local development only). */
  secureCookies?: boolean;
  checkoutTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
  onError?: (code: string) => void;
}

export const SESSION_COOKIE = 'gp_s';
const ISSUANCE_REPLAY_MS = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
}

interface CheckoutRow {
  claim_code: string; plan: string; price_zat: number; paid_zat: number; min_conf: number;
  status: CheckoutStatus; expires_at: number;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export function createGhostpass(config: GhostpassConfig) {
  const { db, merchantName: merchant, merchantAddress: address } = config;
  const clock = config.now ?? Date.now;
  const onError = config.onError ?? (() => {});
  const checkoutTtl = config.checkoutTtlMs ?? 2 * HOUR;
  const sessionTtl = config.sessionTtlMs ?? 24 * HOUR;
  const secureCookies = config.secureCookies ?? true;

  // The merchant name appears in a quoted WWW-Authenticate realm and in ZIP 321 messages.
  if (!/^[^"\\\x00-\x1f\x7f]{1,80}$/.test(merchant)) throw new Error('invalid_merchant_name');
  buildZip321(address, 1n, '');
  const plans = new Map<string, Plan>();
  for (const plan of config.plans) {
    if (plans.has(plan.id)) throw new Error('duplicate_plan');
    plans.set(plan.id, assertPlan(plan));
  }
  if (!plans.size) throw new Error('no_plans');
  if (!secureCookies && process.env.NODE_ENV === 'production') throw new Error('insecure_cookies_in_production');

  installSchema(db, merchant);
  const keys = new IssuerKeys(db, merchant, config.kek, config.keyLogPath);
  const simulated = config.payments.kind === 'simulated' ? new SimulatedPayments(db, clock) : undefined;
  const matcher = config.payments.kind === 'watcher' ? new PaymentMatcher({
    db, url: config.payments.url, accountId: config.payments.accountId, token: config.payments.token,
    ...(config.payments.intervalMs === undefined ? {} : { intervalMs: config.payments.intervalMs }),
    onError,
  }) : undefined;

  const small = express.json({ limit: '4kb' });
  const router: Router = express.Router();

  router.get('/.well-known/ghostpass.json', (_req, res) => {
    const now = clock();
    const body: WellKnown = { v: 1, merchant, current: currentPeriod(now), keys: keys.published(now), plans: [...plans.values()].map(publicPlan) };
    res.set('Cache-Control', 'no-cache').json(body);
  });

  router.post('/v1/checkout', small, (req, res) => {
    const planId: unknown = (req.body as { plan?: unknown } | undefined)?.plan;
    const plan = typeof planId === 'string' ? plans.get(planId) : undefined;
    if (!plan) throw new HttpError(400, 'unknown_plan');
    const claimCode = newClaimCode();
    const memo = buildMemo(claimCode, plan.id);
    const uri = buildZip321(address, plan.priceZat, memo, `${merchant} - ${plan.label}`);
    const now = clock();
    const expiresAt = now + checkoutTtl;
    db.prepare('INSERT INTO checkouts (claim_code, plan, price_zat, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(claimCode, plan.id, plan.priceZat, now, expiresAt);
    const body: CheckoutResponse = { claimCode, uri, address, amountZec: zatToZec(plan.priceZat), memo, expiresAt };
    res.set('Cache-Control', 'no-store').json(body);
  });

  function checkout(claimCode: unknown): CheckoutRow {
    const row = typeof claimCode === 'string' && CLAIM_CODE_RE.test(claimCode)
      ? db.prepare('SELECT claim_code, plan, price_zat, paid_zat, min_conf, status, expires_at FROM checkouts WHERE claim_code = ?').get(claimCode)
      : undefined;
    if (!row) throw new HttpError(404, 'unknown_claim');
    return row as CheckoutRow;
  }

  function statusOf(co: CheckoutRow): CheckoutStatusResponse {
    // The matcher records expiry on its next poll; report it immediately.
    const status = co.status === 'AWAITING_PAYMENT' && co.expires_at < clock() ? 'EXPIRED' : co.status;
    return { status, paidZec: zatToZec(BigInt(co.paid_zat)), confirmations: co.min_conf };
  }

  router.get('/v1/checkout/:claimCode', (req, res) => {
    res.set('Cache-Control', 'no-store').json(statusOf(checkout(req.params.claimCode)));
  });

  router.post('/v1/issue', express.json({ limit: '1mb' }), (req, res) => {
    const body = (req.body ?? {}) as { claimCode?: unknown; period?: unknown; blinded?: unknown };
    const co = checkout(body.claimCode);
    const { period, blinded } = body;
    if (!isPeriod(period)) throw new HttpError(400, 'invalid_period');
    if (!Array.isArray(blinded) || blinded.length > MAX_TOKENS_PER_PLAN || !blinded.every(b => typeof b === 'string')) {
      throw new HttpError(400, 'invalid_blinded');
    }
    const requestHash = sha256(`${co.claim_code}\n${period}\n${blinded.join(',')}`);
    res.set('Cache-Control', 'no-store');

    // A subscriber whose response was lost retries with the identical request and receives the same signatures.
    const previous = db.prepare('SELECT request_hash, period, blind_sigs FROM issuances WHERE claim_code = ?').get(co.claim_code) as
      { request_hash: string; period: string; blind_sigs: string | null } | undefined;
    if (previous?.blind_sigs && previous.request_hash === requestHash) {
      const replay: IssueResponse = { period: previous.period, blindSigs: JSON.parse(previous.blind_sigs) as string[] };
      return res.json(replay);
    }

    const now = clock();
    if (period !== currentPeriod(now)) throw new HttpError(409, 'period_changed', { current: currentPeriod(now) });
    const plan = plans.get(co.plan);
    if (!plan) throw new HttpError(409, 'plan_unavailable');
    if (blinded.length !== plan.tokens) throw new HttpError(400, 'bad_count', { expected: plan.tokens });
    let signer: Signer;
    try { signer = keys.signer(period); }
    catch { throw new HttpError(503, 'issuer_key_unavailable'); }
    const messages = (blinded as string[]).map(b => {
      let bytes: Uint8Array;
      try { bytes = fromB64url(b); }
      catch { throw new HttpError(400, 'invalid_blinded'); }
      if (!acceptsBlinded(signer, bytes)) throw new HttpError(400, 'invalid_blinded');
      return bytes;
    });

    // Atomic claim BEFORE signing: only one request can move CONFIRMED -> ISSUED.
    const claimed = db.transaction(() => {
      const r = db.prepare("UPDATE checkouts SET status = 'ISSUED', issued_at = ? WHERE claim_code = ? AND status = 'CONFIRMED'").run(now, co.claim_code);
      if (r.changes !== 1) return false;
      db.prepare('DELETE FROM issuances WHERE claim_code = ?').run(co.claim_code);
      db.prepare('INSERT INTO issuances (claim_code, request_hash, period, blind_sigs, created_at) VALUES (?, ?, ?, NULL, ?)')
        .run(co.claim_code, requestHash, period, now);
      return true;
    }).immediate();
    if (!claimed) throw new HttpError(409, 'not_confirmed_or_already_issued');

    let blindSigs: string[];
    try {
      blindSigs = messages.map(m => b64url(blindSign(signer, m)));
      db.transaction(() => {
        db.prepare('UPDATE issuances SET blind_sigs = ? WHERE claim_code = ?').run(JSON.stringify(blindSigs), co.claim_code);
        forgetIssuedPayments(db, co.claim_code);
        simulated?.forget(co.claim_code);
        db.prepare('INSERT INTO stats (period, issued) VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET issued = issued + excluded.issued')
          .run(period, plan.tokens);
      }).immediate();
    } catch {
      releaseClaim(co.claim_code);
      throw new HttpError(500, 'issue_failed');
    }
    const response: IssueResponse = { period, blindSigs };
    res.json(response);
  });

  /** Lets the subscriber retry: used when signing fails, and at startup for claims interrupted by a crash. */
  function releaseClaim(claimCode: string): void {
    db.transaction(() => {
      db.prepare("UPDATE checkouts SET status = 'CONFIRMED', issued_at = NULL WHERE claim_code = ? AND status = 'ISSUED'").run(claimCode);
      db.prepare('DELETE FROM issuances WHERE claim_code = ?').run(claimCode);
    }).immediate();
  }

  if (simulated) {
    router.post('/dev/pay/:claimCode', small, (req, res) => {
      const co = checkout(req.params.claimCode);
      const zat: unknown = (req.body as { zat?: unknown } | undefined)?.zat;
      if (zat !== undefined && (typeof zat !== 'string' || !/^[1-9][0-9]{0,15}$/.test(zat))) throw new HttpError(400, 'invalid_amount');
      try { simulated.pay(co.claim_code, zat === undefined ? undefined : BigInt(zat)); }
      catch (error) {
        const code = (error as Error).message;
        throw code === 'already_issued' ? new HttpError(409, code) : code === 'invalid_amount' ? new HttpError(400, code) : error;
      }
      res.set('Cache-Control', 'no-store').json(statusOf(checkout(co.claim_code)));
    });
  }

  router.use(((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code, ...error.extra });
      return;
    }
    const e = error as { type?: string };
    if (e.type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_json' }); return; }
    if (e.type === 'entity.too.large') { res.status(413).json({ error: 'body_too_large' }); return; }
    onError('ghostpass_request_failed');
    res.status(500).json({ error: 'internal' });
  }) as ErrorRequestHandler);

  function challenge(res: Response, error: string) {
    res.set('WWW-Authenticate', `Ghostpass realm="${merchant}", keys="/.well-known/ghostpass.json"`);
    res.set('Cache-Control', 'no-store').status(401).json({ error });
  }

  /** Verifies one token and records it as spent before the protected handler runs. */
  function requireGhostpass(): RequestHandler {
    return async (req, res, next) => {
      const token = parseAuthorization(req.get('authorization'));
      if (!token) return challenge(res, 'payment_required');
      let fresh: boolean;
      try {
        const pk = await keys.publicIfRedeemable(token.period, clock());
        if (!pk) return challenge(res, 'payment_required');
        let msg: Uint8Array;
        let sig: Uint8Array;
        try { msg = fromB64url(token.msg); sig = fromB64url(token.sig); }
        catch { return challenge(res, 'invalid_token'); }
        if (msg.length !== TOKEN_MSG_BYTES || sig.length !== RSA_MODULUS_BYTES || !(await suite.verify(pk, sig, msg))) {
          return challenge(res, 'invalid_token');
        }
        fresh = db.transaction(() => {
          const spent = db.prepare('INSERT OR IGNORE INTO spent_tokens (period, token_hash) VALUES (?, ?)').run(token.period, sha256(msg));
          if (spent.changes !== 1) return false;
          db.prepare('INSERT INTO stats (period, redeemed) VALUES (?, 1) ON CONFLICT(period) DO UPDATE SET redeemed = redeemed + 1').run(token.period);
          return true;
        }).immediate();
      } catch {
        onError('redeem_failed');
        return void res.set('Cache-Control', 'no-store').status(503).json({ error: 'redeemer_unavailable' });
      }
      if (!fresh) return challenge(res, 'token_already_spent');
      next();
    };
  }

  /** POST handler placed after requireGhostpass(): one token opens a session cookie (session mode). */
  const startSession: RequestHandler = (_req, res) => {
    const id = randomBytes(32).toString('base64url');
    const expiresAt = clock() + sessionTtl;
    db.prepare('INSERT INTO sessions (id_hash, expires_at) VALUES (?, ?)').run(sha256(id), expiresAt);
    res.cookie(SESSION_COOKIE, id, { httpOnly: true, secure: secureCookies, sameSite: 'strict', maxAge: sessionTtl, path: '/' });
    res.set('Cache-Control', 'no-store').json({ ok: true, expiresAt });
  };

  const parseCookies = cookieParser();
  function requireSession(options: { redirectTo?: string } = {}): RequestHandler {
    return (req, res, next) => parseCookies(req, res, (error?: unknown) => {
      if (error) return next(error);
      const id: unknown = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
      const row = typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id)
        ? db.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?').get(sha256(id)) as { expires_at: number } | undefined
        : undefined;
      if (row && row.expires_at > clock()) return next();
      res.set('Cache-Control', 'no-store');
      if (options.redirectTo) return res.redirect(303, options.redirectTo);
      res.status(401).json({ error: 'session_required' });
    });
  }

  /** Guide §15.3: expired sessions, spent sets past their redeem window, and old issuance replays are deleted. */
  function cleanup(): void {
    const now = clock();
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      db.prepare('DELETE FROM spent_tokens WHERE period IN (SELECT period FROM issuer_keys WHERE redeem_until <= ?)').run(now);
      db.prepare('DELETE FROM issuances WHERE blind_sigs IS NOT NULL AND created_at <= ?').run(now - ISSUANCE_REPLAY_MS);
    }).immediate();
  }

  let hourly: NodeJS.Timeout | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    // A claim marked ISSUED without stored signatures was interrupted before any response was sent.
    const interrupted = db.prepare('SELECT claim_code FROM issuances WHERE blind_sigs IS NULL').all() as { claim_code: string }[];
    for (const { claim_code } of interrupted) releaseClaim(claim_code);
    await keys.ensure(clock());
    cleanup();
    started = true;
    hourly = setInterval(() => {
      keys.ensure(clock()).catch(() => onError('key_rotation_failed'));
      try { cleanup(); } catch { onError('cleanup_failed'); }
    }, HOUR);
    hourly.unref();
    if (simulated) {
      simulated.reconcile();
      reconcileTimer = setInterval(() => {
        try { simulated.reconcile(); } catch { onError('simulated_reconcile_failed'); }
      }, 20_000);
      reconcileTimer.unref();
    }
    matcher?.start();
  }

  async function stop(): Promise<void> {
    started = false;
    clearInterval(hourly);
    clearInterval(reconcileTimer);
    await matcher?.stop();
  }

  return {
    router, requireGhostpass, startSession, requireSession, start, stop, cleanup,
    keys, devMode: simulated !== undefined, merchant,
    /** Dev mode only: simulate a payment without an HTTP request (tests and scripts). */
    simulatePayment: simulated ? (claimCode: string, zat?: bigint) => simulated.pay(claimCode, zat) : undefined,
  };
}

export type Ghostpass = ReturnType<typeof createGhostpass>;
