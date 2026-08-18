import { HardLink } from "@/components/HardLink";
import { AccountSettings } from "@/components/AccountSettings";
import { SiteHeader } from "@/components/SiteHeader";
import { SubscribeButton } from "@/components/SubscribeButton";
import { hasMemberAccess, hasSmartAnalysisAccess, isAdminEmail } from "@/lib/auth/subscription";
import { getProfile, getSessionUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/account");

  const profile = await getProfile(user.id);
  const isAdmin = profile?.is_admin === true || isAdminEmail(user.email);
  const active = hasMemberAccess(profile, user.email);
  const smartAccess = hasSmartAnalysisAccess(profile, user.email);
  const upgrade = first(searchParams.upgrade) === "1";
  const upgradeSmart = first(searchParams.upgrade) === "smart";
  const checkoutOk = first(searchParams.checkout) === "success";

  async function signOut() {
    "use server";
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
    redirect("/");
  }

  return (
    <>
      <SiteHeader />
      <main className={`shell ${styles.main}`}>
        <p className={styles.kicker}>Account</p>
        <h1 className={styles.title}>Your profile</h1>

        {checkoutOk ? (
          <p className={styles.bannerOk}>
            Payment received — access should unlock within a few seconds. Reload if needed.
          </p>
        ) : null}

        {upgradeSmart && !smartAccess ? (
          <p className={styles.bannerWarn}>
            Smart Analysis requires <strong>Pro</strong> ($19/mo) or higher. Starter includes
            Analyze, Seasons, and Matches — not the Smart Analysis guide.
          </p>
        ) : null}

        {upgrade && !active ? (
          <p className={styles.bannerWarn}>
            Subscription required for Analyze, Seasons, and Matches. Choose a plan below or
            contact support if you already paid.
          </p>
        ) : null}

        <section className={styles.card}>
          <h2>Profile</h2>
          <dl className={styles.dl}>
            <div>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt>Email verified</dt>
              <dd>{user.email_confirmed_at ? "Yes" : "No — check inbox"}</dd>
            </div>
            <div>
              <dt>User ID</dt>
              <dd className={styles.mono}>{user.id}</dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>{fmtDate(user.created_at)}</dd>
            </div>
            <div>
              <dt>Last sign in</dt>
              <dd>{fmtDate(user.last_sign_in_at ?? null)}</dd>
            </div>
          </dl>
        </section>

        <section className={styles.card}>
          <h2>Membership</h2>
          <dl className={styles.dl}>
            <div>
              <dt>Access</dt>
              <dd className={active ? styles.ok : styles.muted}>
                {isAdmin ? "Admin (full access)" : active ? "Active" : "No subscription"}
              </dd>
            </div>
            <div>
              <dt>Smart Analysis</dt>
              <dd className={smartAccess ? styles.ok : styles.muted}>
                {isAdmin ? "Included (admin)" : smartAccess ? "Pro or higher" : "Upgrade to Pro"}
              </dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>{profile?.plan_id || "—"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{profile?.subscription_status || "none"}</dd>
            </div>
            {profile?.current_period_end ? (
              <div>
                <dt>Renews / ends</dt>
                <dd>{fmtDate(profile.current_period_end)}</dd>
              </div>
            ) : null}
                        {profile?.dodo_subscription_id ? (
              <div>
                <dt>Subscription ID</dt>
                <dd className={styles.mono}>{profile.dodo_subscription_id}</dd>
              </div>
            ) : null}
          </dl>

          {active && smartAccess ? (
            <div className={styles.actions}>
              <HardLink href="/smart-analysis" className={styles.primaryLink}>
                Smart Analysis →
              </HardLink>
              <HardLink href="/analyze" className={styles.secondaryLink}>
                Analyze
              </HardLink>
              <HardLink href="/seasons" className={styles.secondaryLink}>
                Seasons
              </HardLink>
            </div>
          ) : null}

          {active && !smartAccess ? (
            <div className={styles.plans}>
              <SubscribeButton plan="pro" featured label="Pro — $19/mo (Smart Analysis)" />
              <SubscribeButton plan="analyst" label="Analyst — $39/mo" />
            </div>
          ) : null}

          {!active ? (
            <div className={styles.plans}>
              <SubscribeButton plan="starter" label="Starter — $9/mo" />
              <SubscribeButton plan="pro" featured label="Pro — $19/mo" />
              <SubscribeButton plan="analyst" label="Analyst — $39/mo" />
            </div>
          ) : null}
        </section>

        <AccountSettings />

        <form action={signOut}>
          <button type="submit" className={styles.signOut}>
            Sign out
          </button>
        </form>

        <p className={styles.hint}>
          Billing receipts and cancellation: Lemon Squeezy customer portal (link in payment
          email).
        </p>
      </main>
    </>
  );
}
