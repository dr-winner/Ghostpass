import { PLAN_ID_RE } from './memo.ts';
import { zatToZec } from './zip321.ts';

export type PlanMode = 'session' | 'per-request';

export interface Plan { id: string; label: string; priceZat: bigint; tokens: number; mode: PlanMode }

/** JSON form of a plan: bigint amounts are always converted with zatToZec. */
export interface PublicPlan { id: string; label: string; amountZec: string; tokens: number; mode: PlanMode }

export const MAX_TOKENS_PER_PLAN = 1000;

export const PLANS = {
  monthly: { id: 'monthly', label: '30 days', priceZat: 500_000n, tokens: 30, mode: 'session' },
  api100: { id: 'api100', label: '100 API calls', priceZat: 200_000n, tokens: 100, mode: 'per-request' },
} as const satisfies Record<string, Plan>;

export function assertPlan(plan: Plan): Plan {
  if (!PLAN_ID_RE.test(plan.id)) throw new Error('invalid_plan_id');
  if (!plan.label.trim() || plan.label.length > 80) throw new Error('invalid_plan_label');
  if (plan.priceZat <= 0n) throw new Error('invalid_plan_price');
  zatToZec(plan.priceZat);
  if (!Number.isSafeInteger(plan.tokens) || plan.tokens < 1 || plan.tokens > MAX_TOKENS_PER_PLAN) throw new Error('invalid_plan_tokens');
  if (plan.mode !== 'session' && plan.mode !== 'per-request') throw new Error('invalid_plan_mode');
  return plan;
}

export function publicPlan(plan: Plan): PublicPlan {
  return { id: plan.id, label: plan.label, amountZec: zatToZec(plan.priceZat), tokens: plan.tokens, mode: plan.mode };
}
