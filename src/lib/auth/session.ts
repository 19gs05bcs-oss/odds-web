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
      "id,email,plan_id,subscription_status,is_admin,dodo_customer_id,dodo_subscription_id,dodo_product_id,current_period_end",
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
  dodoCustomerId?: string | null;
  dodoSubscriptionId?: string | null;
  dodoProductId?: string | null;
  currentPeriodEnd?: string | null;
}) {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");

  const payload = {
    id: row.userId,
    email: row.email ?? null,
    plan_id: row.planId ?? null,
    subscription_status: row.subscriptionStatus,
    dodo_customer_id: row.dodoCustomerId ?? null,
    dodo_subscription_id: row.dodoSubscriptionId ?? null,
    dodo_product_id: row.dodoProductId ?? null,
    current_period_end: row.currentPeriodEnd ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin.from("profiles").upsert(payload, { onConflict: "id" });
  if (error) throw new Error(error.message);
}
