export type PlanId = "starter" | "pro" | "analyst" | "team";

export type ProfileRow = {
  id: string;
  email: string | null;
  plan_id: PlanId | null;
  subscription_status: string;
  is_admin?: boolean | null;
  lemon_customer_id: string | null;
  lemon_subscription_id: string | null;
  lemon_variant_id: string | null;
  current_period_end: string | null;
};

/** Lemon Squeezy statuses that grant product access. */
const ACTIVE_STATUSES = new Set([
  "active",
  "on_trial",
  "past_due",
  "paused",
]);

export function adminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS || "bcsezgin1@gmail.com";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().has(email.toLowerCase());
}

export function hasMemberAccess(
  profile: Pick<ProfileRow, "subscription_status" | "is_admin"> | null | undefined,
  email?: string | null,
): boolean {
  if (email && isAdminEmail(email)) return true;
  if (!profile) return false;
  if (profile.is_admin) return true;
  return ACTIVE_STATUSES.has(profile.subscription_status);
}

const PLAN_RANK: Record<PlanId, number> = {
  starter: 1,
  pro: 2,
  analyst: 3,
  team: 4,
};

export function planRank(plan: PlanId | null | undefined): number {
  if (!plan) return 0;
  return PLAN_RANK[plan] ?? 0;
}

/** Minimum plan tier (starter < pro < analyst < team). */
export function hasPlanAccess(
  profile:
    | Pick<ProfileRow, "subscription_status" | "is_admin" | "plan_id">
    | null
    | undefined,
  email: string | null | undefined,
  minPlan: PlanId,
): boolean {
  if (email && isAdminEmail(email)) return true;
  if (!hasMemberAccess(profile, email)) return false;
  if (profile?.is_admin) return true;
  return planRank(profile?.plan_id) >= planRank(minPlan);
}

/** Pro, Analyst, Team, or admin — not Starter ($9). */
export function hasSmartAnalysisAccess(
  profile:
    | Pick<ProfileRow, "subscription_status" | "is_admin" | "plan_id">
    | null
    | undefined,
  email?: string | null,
): boolean {
  return hasPlanAccess(profile, email ?? null, "pro");
}

/** @deprecated use hasMemberAccess */
export function hasActiveSubscription(
  profile: Pick<ProfileRow, "subscription_status" | "is_admin"> | null | undefined,
): boolean {
  return hasMemberAccess(profile);
}

export function mapLemonStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === "cancelled") return "cancelled";
  if (s === "expired") return "expired";
  if (s === "unpaid") return "unpaid";
  if (s === "past_due") return "past_due";
  if (s === "paused") return "paused";
  if (s === "on_trial") return "on_trial";
  return "active";
}

export function planFromVariantId(variantId: string | number | null | undefined): PlanId | null {
  if (variantId == null) return null;
  const v = String(variantId);
  const starter = process.env.LEMONSQUEEZY_VARIANT_STARTER?.trim();
  const pro = process.env.LEMONSQUEEZY_VARIANT_PRO?.trim();
  const analyst = process.env.LEMONSQUEEZY_VARIANT_ANALYST?.trim();
  if (starter && v === starter) return "starter";
  if (pro && v === pro) return "pro";
  if (analyst && v === analyst) return "analyst";
  return null;
}
