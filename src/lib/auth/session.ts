import { redirect } from "next/navigation";
import { hasMemberAccess, type ProfileRow } from "@/lib/auth/subscription";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export async function getSessionUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

export async function getProfile(userId: string): Promise<ProfileRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id,email,plan_id,subscription_status,is_admin,lemon_customer_id,lemon_subscription_id,lemon_variant_id,current_period_end",
    )
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as ProfileRow;
}

export async function requireMember(nextPath?: string) {
  const user = await getSessionUser();
  if (!user) {
    const q = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";
    redirect(`/login${q}`);
  }
  const profile = await getProfile(user.id);
  if (!hasMemberAccess(profile, user.email)) {
    redirect("/account?upgrade=1");
  }
  return { user, profile };
}

export async function upsertProfileFromWebhook(row: {
  userId: string;
  email?: string | null;
  planId?: string | null;
  subscriptionStatus: string;
  lemonCustomerId?: string | null;
  lemonSubscriptionId?: string | null;
  lemonVariantId?: string | null;
  currentPeriodEnd?: string | null;
}) {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");

  const payload = {
    id: row.userId,
    email: row.email ?? null,
    plan_id: row.planId ?? null,
    subscription_status: row.subscriptionStatus,
    lemon_customer_id: row.lemonCustomerId ?? null,
    lemon_subscription_id: row.lemonSubscriptionId ?? null,
    lemon_variant_id: row.lemonVariantId ?? null,
    current_period_end: row.currentPeriodEnd ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin.from("profiles").upsert(payload, { onConflict: "id" });
  if (error) throw new Error(error.message);
}
