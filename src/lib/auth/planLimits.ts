import type { PlanId } from "@/lib/auth/subscription";

/** Bir /api/analyze isteğinde birleştirilebilecek max oran kriteri sayısı. */
export const MAX_CRITERIA: Record<PlanId, number> = {
  starter: 3,
  pro: 8,
  analyst: 15,
  team: 25,
};

/** Günlük (UTC gün) analiz arama limiti. */
export const DAILY_SEARCH_LIMIT: Record<PlanId, number> = {
  starter: 20,
  pro: 100,
  analyst: 500,
  team: 2000,
};

const FALLBACK_PLAN: PlanId = "starter";

export function maxCriteriaForPlan(plan: PlanId | null | undefined): number {
  return MAX_CRITERIA[plan ?? FALLBACK_PLAN] ?? MAX_CRITERIA[FALLBACK_PLAN];
}

export function dailySearchLimitForPlan(plan: PlanId | null | undefined): number {
  return DAILY_SEARCH_LIMIT[plan ?? FALLBACK_PLAN] ?? DAILY_SEARCH_LIMIT[FALLBACK_PLAN];
}
