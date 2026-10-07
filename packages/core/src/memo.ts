import { base32 } from './encoding.ts';

// Sixteen random bytes in base32: the final character carries three data bits and two zero bits.
export const CLAIM_CODE_RE = /^[A-Z2-7]{25}[AEIMQUY4]$/;
export const PLAN_ID_RE = /^[a-z0-9]{1,64}$/;
export const MEMO_RE = /^GP1 ([A-Z2-7]{25}[AEIMQUY4]) ([a-z0-9]{1,64})$/;

export function newClaimCode(): string {
  return base32(crypto.getRandomValues(new Uint8Array(16)));
}

export function buildMemo(claimCode: string, planId: string): string {
  if (!CLAIM_CODE_RE.test(claimCode)) throw new Error('invalid_claim_code');
  if (!PLAN_ID_RE.test(planId)) throw new Error('invalid_plan_id');
  return `GP1 ${claimCode} ${planId}`;
}

/** Must accept exactly what the matcher's parsePaymentMemo accepts. */
export function parseMemo(text: string | null): { claimCode: string; planId: string } | null {
  const m = MEMO_RE.exec(text ?? '');
  return m && m[1] && m[2] ? { claimCode: m[1], planId: m[2] } : null;
}
