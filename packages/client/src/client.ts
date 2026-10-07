import { RSABSSA } from '@cloudflare/blindrsa-ts';
import {
  b64url, formatAuthorization, fromB64url, isPeriod, keyLog, loggedKeyHash, MAX_TOKENS_PER_PLAN, redeemUntil, sha256hex,
  TOKEN_NONCE_BYTES,
} from '@ghostpass/core';
import type { CheckoutResponse, CheckoutStatusResponse, IssueResponse, Token, WellKnown, WellKnownKey } from '@ghostpass/core';
import { indexedDbStore } from './storage.ts';
import type { KeyValueStore } from './storage.ts';

const suite = RSABSSA.SHA384.PSS.Randomized();

export class GhostpassError extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown> = {}) {
    super(code);
    this.name = 'GhostpassError';
  }
}

export interface PendingCheckout { claimCode: string; plan: string; createdAt: number; checkout: CheckoutResponse }

/** Saved before /v1/issue is called, so a lost response can be retried with the identical request. */
interface IssuingState { period: string; prepared: string[]; inv: string[]; blinded: string[] }

export interface ClientOptions {
  /** Merchant origin; empty for same-origin pages. */
  base?: string;
  /** Merchant name as published in KEYS.json and /.well-known/ghostpass.json. */
  merchant: string;
  /** Public KEYS.json, fetched from the public repository rather than from the merchant (guide §15.1). */
  keysUrl: string;
  store?: KeyValueStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Random first-use delay after issuance, in milliseconds (guide §15.2). Defaults to 1–10 minutes. */
  privacyDelayMs?: readonly [number, number];
}

const KEY = {
  tokens: 'gp.tokens',
  notBefore: 'gp.notBefore',
  pending: 'gp.pending',
  issuing: (claimCode: string) => `gp.issuing.${claimCode}`,
};

export class GhostpassClient {
  private readonly base: string;
  private readonly merchant: string;
  private readonly keysUrl: string;
  private readonly store: KeyValueStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly delay: readonly [number, number];

  constructor(options: ClientOptions) {
    this.base = options.base ?? '';
    this.merchant = options.merchant;
    this.keysUrl = options.keysUrl;
    this.store = options.store ?? indexedDbStore;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.delay = options.privacyDelayMs ?? [60_000, 600_000];
    const [min, max] = this.delay;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min || max > 0xffff_ffff) {
      throw new GhostpassError('invalid_privacy_delay');
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T & { error?: string } }> {
    const r = await this.fetchImpl(`${this.base}${path}`, { ...init, cache: 'no-store' });
    const body = await r.json().catch(() => ({})) as T & { error?: string };
    return { status: r.status, body };
  }

  private post<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async wellKnown(): Promise<WellKnown> {
    const { status, body } = await this.request<WellKnown>('/.well-known/ghostpass.json');
    if (status !== 200 || body.v !== 1 || !isPeriod(body.current) || !Array.isArray(body.keys) || !Array.isArray(body.plans)) {
      throw new GhostpassError('merchant_metadata_unavailable');
    }
    if (body.merchant !== this.merchant) throw new GhostpassError('unexpected_merchant');
    return body;
  }

  /** Refuses a key unless the public log holds exactly one entry for this merchant and period, with the same hash. */
  async checkKeyConsistency(key: WellKnownKey): Promise<void> {
    let expected: string;
    try {
      const r = await this.fetchImpl(this.keysUrl, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new Error('key_log_unavailable');
      expected = loggedKeyHash(keyLog(await r.json()), this.merchant, key.period);
    } catch (error) {
      throw new GhostpassError(error instanceof Error && /^key_/.test(error.message) ? error.message : 'key_log_unavailable');
    }
    if (await sha256hex(fromB64url(key.spki)) !== expected) throw new GhostpassError('key_inconsistent');
  }

  /** Starts a checkout and saves its claim code at once: until tokens are issued it is the only receipt. */
  async startCheckout(plan: string): Promise<CheckoutResponse> {
    const { status, body } = await this.post<CheckoutResponse>('/v1/checkout', { plan });
    if (status !== 200) throw new GhostpassError(body.error ?? 'checkout_failed');
    await this.store.set(KEY.pending, [...await this.pending(), { claimCode: body.claimCode, plan, createdAt: this.now(), checkout: body }]);
    return body;
  }

  async checkoutStatus(claimCode: string): Promise<CheckoutStatusResponse> {
    const { status, body } = await this.request<CheckoutStatusResponse>(`/v1/checkout/${encodeURIComponent(claimCode)}`);
    if (status !== 200) throw new GhostpassError(body.error ?? 'status_failed');
    return body;
  }

  /** Dev mode only: the merchant simulates a payment for this claim. */
  async simulatePayment(claimCode: string, zat?: string): Promise<CheckoutStatusResponse> {
    const { status, body } = await this.post<CheckoutStatusResponse>(`/dev/pay/${encodeURIComponent(claimCode)}`, zat === undefined ? {} : { zat });
    if (status !== 200) throw new GhostpassError(body.error ?? 'simulated_payment_failed');
    return body;
  }

  async pending(): Promise<PendingCheckout[]> {
    return (await this.store.get(KEY.pending) as PendingCheckout[] | undefined) ?? [];
  }

  async removePending(claimCode: string): Promise<void> {
    await this.store.set(KEY.pending, (await this.pending()).filter(p => p.claimCode !== claimCode));
  }

  /** True when a blinded request was sent for this claim; obtainTokens() will retry it after a lost response. */
  async hasIssuingState(claimCode: string): Promise<boolean> {
    return (await this.store.get(KEY.issuing(claimCode))) !== undefined;
  }

  private async blind(pk: CryptoKey, period: string, count: number): Promise<IssuingState> {
    const state: IssuingState = { period, prepared: [], inv: [], blinded: [] };
    for (let i = 0; i < count; i++) {
      const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(TOKEN_NONCE_BYTES)));
      const { blindedMsg, inv } = await suite.blind(pk, prepared);
      state.prepared.push(b64url(prepared));
      state.inv.push(b64url(inv));
      state.blinded.push(b64url(blindedMsg));
    }
    return state;
  }

  /** Blinds `count` random messages, has them signed for a CONFIRMED claim, and stores the unblinded tokens. */
  async obtainTokens(claimCode: string, count: number): Promise<number> {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_TOKENS_PER_PLAN) throw new GhostpassError('invalid_count');
    let meta = await this.wellKnown();
    let state = await this.store.get(KEY.issuing(claimCode)) as IssuingState | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = meta.keys.find(k => k.period === (state?.period ?? meta.current));
      if (!key) {
        if (!state) throw new GhostpassError('no_current_key');
        await this.store.del(KEY.issuing(claimCode));
        state = undefined;
        continue;
      }
      await this.checkKeyConsistency(key);
      const pk = await crypto.subtle.importKey('spki', fromB64url(key.spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
      if (!state || state.blinded.length !== count) {
        state = await this.blind(pk, key.period, count);
        await this.store.set(KEY.issuing(claimCode), state);
      }
      const issuing = state;
      const { status, body } = await this.post<IssueResponse>('/v1/issue', { claimCode, period: issuing.period, blinded: issuing.blinded });
      if (status === 409 && body.error === 'period_changed') {
        // The server stored no signatures for this request, so it is safe to discard and re-blind under the new key.
        await this.store.del(KEY.issuing(claimCode));
        state = undefined;
        meta = await this.wellKnown();
        continue;
      }
      if (status !== 200) throw new GhostpassError(body.error ?? 'issue_failed', { status });
      if (body.period !== issuing.period || !Array.isArray(body.blindSigs) || body.blindSigs.length !== issuing.blinded.length) {
        throw new GhostpassError('invalid_issue_response');
      }
      let tokens: Token[];
      try {
        // finalize() verifies each signature under the logged key, so a merchant cannot tag tokens with another key.
        tokens = await Promise.all(issuing.prepared.map(async (msg, i) => {
          const sig = await suite.finalize(pk, fromB64url(msg), fromB64url(body.blindSigs[i]!), fromB64url(issuing.inv[i]!));
          return { period: issuing.period, msg, sig: b64url(sig) };
        }));
      } catch { throw new GhostpassError('invalid_signature'); }
      await this.store.set(KEY.tokens, [...await this.allTokens(), ...tokens]);
      await this.store.set(KEY.notBefore, this.now() + this.randomDelay());
      await this.store.del(KEY.issuing(claimCode));
      await this.removePending(claimCode);
      return tokens.length;
    }
    throw new GhostpassError('issue_retry_exhausted');
  }

  private randomDelay(): number {
    const [min, max] = this.delay;
    return min + (crypto.getRandomValues(new Uint32Array(1))[0]! % (max - min + 1));
  }

  private async allTokens(): Promise<Token[]> {
    return (await this.store.get(KEY.tokens) as Token[] | undefined) ?? [];
  }

  /** Tokens still inside their period's redeem window. */
  async tokens(): Promise<Token[]> {
    const now = this.now();
    return (await this.allTokens()).filter(t => redeemUntil(t.period) > now);
  }

  async summary(): Promise<{ count: number; redeemableUntil: number | null; notBefore: number }> {
    const tokens = await this.tokens();
    const until = tokens.map(t => redeemUntil(t.period));
    return {
      count: tokens.length,
      redeemableUntil: until.length ? Math.min(...until) : null,
      notBefore: (await this.store.get(KEY.notBefore) as number | undefined) ?? 0,
    };
  }

  /** Removes one token (oldest period first) before it is used, so a token is never sent twice. */
  async takeToken(): Promise<Token> {
    const notBefore = (await this.store.get(KEY.notBefore) as number | undefined) ?? 0;
    if (this.now() < notBefore) throw new GhostpassError('privacy_delay', { until: notBefore });
    const usable = (await this.tokens()).sort((a, b) => a.period.localeCompare(b.period));
    const token = usable.shift();
    await this.store.set(KEY.tokens, usable);
    if (!token) throw new GhostpassError('no_tokens');
    return token;
  }

  /** fetch() that spends one token in the Authorization header. Two tabs may race; the server rejects the second use. */
  async ghostFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.takeToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', formatAuthorization(token));
    return this.fetchImpl(input, { ...init, headers });
  }
}
