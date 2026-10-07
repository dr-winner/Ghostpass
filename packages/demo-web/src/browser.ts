import { GhostpassClient, GhostpassError } from '@ghostpass/client';
import { mountCheckout } from '@ghostpass/client/widget';
import type { PublicPlan } from '@ghostpass/core';

export interface PageConfig {
  merchant: string;
  keysUrl: string;
  devMode: boolean;
  planId: string;
  privacyDelayMs: [number, number];
}

export function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

export function pageConfig(): PageConfig {
  return JSON.parse(byId('gp-config').textContent ?? '') as PageConfig;
}

export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function explain(error: unknown): string {
  if (error instanceof GhostpassError) {
    if (error.code === 'privacy_delay') return `Your pass activates at ${when(Number(error.detail.until))} (privacy delay, so your payment and first use are not linked by time).`;
    if (error.code === 'no_tokens') return 'No tokens left: buy a new pass below. Zcash cannot pull payments, so renewal is always a fresh payment.';
    return `Error: ${error.code}`;
  }
  return 'Network error. Please retry.';
}

/** Mounts the checkout widget for the page's plan and keeps the "N tokens left" line current. */
export async function setupMerchantPage(): Promise<{ client: GhostpassClient; plan: PublicPlan; refresh: () => Promise<void> }> {
  const cfg = pageConfig();
  const client = new GhostpassClient({ merchant: cfg.merchant, keysUrl: cfg.keysUrl, privacyDelayMs: cfg.privacyDelayMs });
  const wallet = byId('wallet');
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function refresh() {
    const s = await client.summary();
    const lines = [s.count && s.redeemableUntil
      ? `${s.count} token${s.count === 1 ? '' : 's'} left · redeemable until ${when(s.redeemableUntil)}.`
      : 'No tokens in this browser yet.'];
    clearTimeout(timer);
    if (s.count && Date.now() < s.notBefore) {
      lines.push(`Activates at ${when(s.notBefore)} (privacy delay).`);
      timer = setTimeout(() => { void refresh(); }, s.notBefore - Date.now() + 500);
    }
    wallet.textContent = lines.join(' ');
  }
  const meta = await client.wellKnown();
  const plan = meta.plans.find(p => p.id === cfg.planId);
  if (!plan) throw new Error('plan_not_offered');
  await mountCheckout(byId('checkout'), { client, plan, devMode: cfg.devMode, onReady: () => { void refresh(); } }).mount();
  await refresh();
  return { client, plan, refresh };
}
