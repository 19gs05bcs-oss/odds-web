import { MatchList } from "@/components/MatchList";
import { SiteHeader } from "@/components/SiteHeader";
import { listOpenEvents } from "@/lib/events";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Matches",
};

export default async function MatchesPage() {
  const result = await listOpenEvents();

  return (
    <>
      <SiteHeader active="matches" />
      <main className={`shell ${styles.page}`}>
        <header className={`${styles.intro} fade-up`}>
          <span className={styles.kicker}>Live radar</span>
          <h1 className={styles.title}>Open matches</h1>
          <p className={styles.lead}>
            Listed by kickoff. Odds update change-only from the feed.
          </p>
        </header>

        {!result.ok && (
          <div className={styles.banner}>
            {result.missingEnv ? (
              <>
                Missing environment variables. Add{" "}
                <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
                <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to <code>web/.env.local</code>.
              </>
            ) : (
              <>Could not load data: {result.error}</>
            )}
          </div>
        )}

        {result.ok && <MatchList events={result.data} />}
      </main>
    </>
  );
}
