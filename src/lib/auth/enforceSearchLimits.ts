import "server-only";
import { NextResponse } from "next/server";
import { getSessionUser, getProfile } from "@/lib/auth/session";
import { isAdminEmail } from "@/lib/auth/subscription";
import { maxCriteriaForPlan, dailySearchLimitForPlan } from "@/lib/auth/planLimits";
import { consumeSearchQuota } from "@/lib/searchUsage";

type EnforceOk = { ok: true };
type EnforceFail = { ok: false; response: NextResponse };

/**
 * /api/analyze için plan bazlı sınırlar:
 *  - kriter sayısı (query.criteria.length) plan tavanını aşamaz
 *  - günlük arama kotası (search_usage tablosu) aşılamaz
 * Admin e-postaları her iki sınırdan da muaf.
 * NOT: /api/fixtures, /api/archive-table, /api/smart-analysis gibi rotalar
 * middleware'de zaten üyelik/Smart Analysis kontrolünden geçiyor — bu
 * fonksiyon sadece /api/analyze'e özel ek sınırları uygular.
 */
export async function enforceAnalyzeSearchLimits(
  criteriaCount: number,
): Promise<EnforceOk | EnforceFail> {
  const user = await getSessionUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 }),
    };
  }

  if (isAdminEmail(user.email ?? "")) {
    return { ok: true };
  }

  const profile = await getProfile(user.id);
  const plan = profile?.plan_id ?? null;

  const maxCriteria = maxCriteriaForPlan(plan);
  if (criteriaCount > maxCriteria) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: `Planınız bir aramada en fazla ${maxCriteria} kriteri destekliyor (${criteriaCount} gönderildi). Daha fazlası için planınızı yükseltin.`,
          code: "CRITERIA_LIMIT",
          limit: maxCriteria,
        },
        { status: 403 },
      ),
    };
  }

  const dailyLimit = dailySearchLimitForPlan(plan);
  const quota = await consumeSearchQuota(user.id, dailyLimit);
  if (!quota.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: `Günlük arama limitinize ulaştınız (${quota.used}/${quota.limit}). Yarın sıfırlanır ya da planınızı yükseltin.`,
          code: "DAILY_LIMIT",
          limit: quota.limit,
          used: quota.used,
        },
        { status: 429 },
      ),
    };
  }

  return { ok: true };
}
