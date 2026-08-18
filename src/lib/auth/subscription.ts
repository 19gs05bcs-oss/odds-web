export type PlanId = "starter" | "pro" | "analyst" | "team";

export type ProfileRow = {
  id: string;
  email: string | null;
  plan_id: PlanId | null;
  subscription_status: string;
  is_admin?: boolean | null;
  dodo_customer_id: string | null;
  dodo_subscription_id: string | null;
  dodo_product_id: string | null;
  current_period_end: string | null;
};

/** Dodo Payments statuses that grant product access. */
const ACTIVE_STATUSES = new Set([
  "active",
  "on_hold",
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

export function mapDodoStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "expired") return "expired";
  if (s === "failed") return "failed";
  if (s === "on_hold") return "on_hold";
  if (s === "pending") return "pending";
  return "active";
}

export function planFromProductId(productId: string | number | null | undefined): PlanId | null {
  if (productId == null) return null;
  const v = String(productId);
  const starter = process.env.DODO_PRODUCT_STARTER?.trim();
  const pro = process.env.DODO_PRODUCT_PRO?.trim();
  const analyst = process.env.DODO_PRODUCT_ANALYST?.trim();
  if (starter && v === starter) return "starter";
  if (pro && v === pro) return "pro";
  if (analyst && v === analyst) return "analyst";
  return null;
}
