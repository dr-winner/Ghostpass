import QRCode from 'qrcode';
import type { CheckoutResponse, CheckoutStatusResponse, PublicPlan } from '@ghostpass/core';
import { GhostpassError } from './client.ts';
import type { GhostpassClient, PendingCheckout } from './client.ts';

export interface CheckoutWidgetOptions {
  client: GhostpassClient;
  plan: PublicPlan;
  /** Shows "simulate payment" controls. The server only accepts them in dev mode. */
  devMode: boolean;
  /** Called after tokens are stored. */
  onReady?: (count: number) => void;
  pollMs?: number;
}

type Child = Node | string;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

function copyButton(text: string): HTMLElement {
  const button = h('button', { type: 'button', class: 'gp-copy' }, 'Copy');
  button.addEventListener('click', () => {
    void navigator.clipboard.writeText(text).then(() => { button.textContent = 'Copied'; }, () => { button.textContent = 'Copy failed'; });
  });
  return button;
}

async function qr(uri: string): Promise<Node> {
  const svg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const node = document.importNode(doc.documentElement, true);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', 'Zcash payment request QR code');
  return node;
}

function describe(s: CheckoutStatusResponse): string {
  switch (s.status) {
    case 'AWAITING_PAYMENT': return 'Waiting for your payment.';
    case 'DETECTED': return `Payment seen (${s.paidZec} ZEC). Waiting for 2 confirmations.`;
    case 'CONFIRMED': return 'Payment confirmed. Getting your tokens.';
    case 'UNDERPAID': return `Received ${s.paidZec} ZEC, less than the price. Send the difference with the same memo.`;
    case 'EXPIRED': return 'This checkout expired unpaid. A payment that arrives later is still honoured.';
    case 'ISSUED': return 'Tokens were already issued for this claim code.';
  }
}

function explain(error: unknown): string {
  const code = error instanceof GhostpassError ? error.code : 'network_error';
  if (code.startsWith('key_')) return `Stopped: the merchant's signing key does not match the public key log (${code}). Your claim code is still valid.`;
  if (code === 'unexpected_merchant') return 'Stopped: this page is configured for a different merchant.';
  return `Something went wrong (${code}). Your claim code is saved; reload the page to retry.`;
}

/** Guide §11.2: checkout, QR code, memo with copy button, status polling, and token issuance. */
export function mountCheckout(root: HTMLElement, options: CheckoutWidgetOptions) {
  const { client, plan } = options;
  const pollMs = options.pollMs ?? 10_000;
  let stopCurrent: (() => void) | undefined;

  /** Other saved checkouts for this plan, newest first. They stay saved so late payments still yield tokens. */
  async function others(current: string): Promise<PendingCheckout[]> {
    return (await client.pending()).filter(p => p.plan === plan.id && p.checkout && p.claimCode !== current).sort((a, b) => b.createdAt - a.createdAt);
  }

  function render(pending: PendingCheckout) {
    stopCurrent?.();
    let stopped = false;
    const co: CheckoutResponse = pending.checkout;
    const status = h('p', { class: 'gp-status', role: 'status' }, 'Checking payment status.');
    const qrSlot = h('div', { class: 'gp-qr' });
    const view = h('section', { class: 'gp-checkout' },
      h('h3', {}, `${plan.label}: ${co.amountZec} ZEC`),
      qrSlot,
      h('p', {}, 'Scan with a shielded Zcash wallet such as Zodl, or pay manually:'),
      h('dl', {},
        h('dt', {}, 'Amount'), h('dd', {}, h('code', {}, `${co.amountZec} ZEC`)),
        h('dt', {}, 'Address'), h('dd', {}, h('code', { class: 'gp-wrap' }, co.address), copyButton(co.address)),
        h('dt', {}, 'Memo'), h('dd', {}, h('code', { class: 'gp-wrap' }, co.memo), copyButton(co.memo)),
        h('dt', {}, 'Claim code'), h('dd', {}, h('code', {}, co.claimCode), copyButton(co.claimCode)),
      ),
      h('p', { class: 'gp-note' }, 'Save this claim code. Until your tokens arrive it is your only receipt. If your wallet ignores the memo, paste it in by hand.'),
      status,
    );
    if (options.devMode) {
      const full = h('button', { type: 'button' }, 'Simulate full payment');
      const part = h('button', { type: 'button' }, 'Simulate underpayment');
      full.addEventListener('click', () => { void client.simulatePayment(co.claimCode).then(tick, e => { status.textContent = explain(e); }); });
      part.addEventListener('click', () => { void client.simulatePayment(co.claimCode, '1000').then(tick, e => { status.textContent = explain(e); }); });
      view.append(h('div', { class: 'gp-dev' }, h('strong', {}, 'DEV MODE: payments are simulated. '), full, part));
    }
    const again = h('button', { type: 'button', class: 'secondary' }, 'Start a new checkout');
    again.addEventListener('click', () => { again.setAttribute('disabled', ''); void start(); });
    const switcher = h('p', { class: 'gp-note' });
    view.append(h('p', {}, again), switcher);
    void others(co.claimCode).then(list => {
      if (!list.length) return;
      switcher.replaceChildren('Other saved checkouts: ', ...list.map(p => {
        const b = h('button', { type: 'button', class: 'gp-copy' }, `${p.claimCode.slice(0, 6)}\u2026`);
        b.addEventListener('click', () => render(p));
        return b;
      }));
    });
    root.replaceChildren(view);
    void qr(co.uri).then(node => qrSlot.replaceChildren(node), () => qrSlot.replaceChildren('QR code unavailable; use the details below.'));

    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    async function tick() {
      if (busy || stopped) return;
      busy = true;
      clearTimeout(timer);
      try {
        const s = await client.checkoutStatus(co.claimCode);
        status.textContent = describe(s);
        if (s.status === 'CONFIRMED' || (s.status === 'ISSUED' && await client.hasIssuingState(co.claimCode))) {
          const count = await client.obtainTokens(co.claimCode, plan.tokens);
          status.textContent = `Ready: ${count} tokens stored in this browser.`;
          options.onReady?.(count);
          return;
        }
        if (s.status === 'ISSUED') {
          await client.removePending(co.claimCode);
          return;
        }
      } catch (error) {
        status.textContent = explain(error);
        if (error instanceof GhostpassError && (error.code.startsWith('key_') || error.code === 'unexpected_merchant' || error.code === 'unknown_claim')) return;
      } finally { busy = false; }
      if (!stopped) timer = setTimeout(() => { void tick(); }, pollMs);
    }
    stopCurrent = () => { stopped = true; clearTimeout(timer); };
    void tick();
  }

  async function start() {
    try {
      const co = await client.startCheckout(plan.id);
      const pending = (await client.pending()).find(p => p.claimCode === co.claimCode);
      if (pending) render(pending);
    } catch (error) {
      root.replaceChildren(h('p', { class: 'gp-status' }, explain(error)));
    }
  }

  /** Resumes the newest unfinished checkout for this plan, or shows the subscribe button. */
  async function mount() {
    const [pending] = await others('');
    if (pending) return render(pending);
    const button = h('button', { type: 'button', class: 'gp-buy' }, `Pay ${plan.amountZec} ZEC for ${plan.label} (${plan.tokens} tokens)`);
    button.addEventListener('click', () => { button.setAttribute('disabled', ''); void start(); });
    root.replaceChildren(button);
  }

  return { mount, start };
}
