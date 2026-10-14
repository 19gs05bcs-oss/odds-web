import "server-only";
import { NextResponse } from "next/server";
import { getSessionUser, getProfile } from "@/lib/auth/session";
import { isAdminEmail } from "@/lib/auth/subscription";
import { maxCriteriaForPlan, dailySearchLimitForPlan } from "@/lib/auth/planLimits";
import { consumeSearchQuota } from "@/lib/searchUsage";

type EnforceOk = { ok: true; userId: string };
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
export type EnforceOpts = {
  /**
   * Günlük arama hakkı bu çağrıda düşsün mü? Sayfa değiştirme / filtre gibi
   * önbellekten servis edilen isteklerde false döndürülür (kullanıcı id'si verilir).
   * Varsayılan: true.
   */
  consumeQuota?: boolean | ((userId: string) => boolean);
};

export async function enforceAnalyzeSearchLimits(
  criteriaCount: number,
  opts: EnforceOpts = {},
): Promise<EnforceOk | EnforceFail> {
  const user = await getSessionUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 }),
    };
  }

  if (isAdminEmail(user.email ?? "")) {
    return { ok: true, userId: user.id };
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

  const shouldConsume =
    typeof opts.consumeQuota === "function"
      ? opts.consumeQuota(user.id)
      : opts.consumeQuota !== false;
  if (!shouldConsume) return { ok: true, userId: user.id };

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

  return { ok: true, userId: user.id };
}
