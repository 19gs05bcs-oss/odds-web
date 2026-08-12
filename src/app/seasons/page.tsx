import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { listSeasons } from "@/lib/archive";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Seasons",
};

export default async function SeasonsPage() {
  const result = await listSeasons();

  return (
    <>
      <SiteHeader active="seasons" />
      <main className={`shell ${styles.page}`}>
        <header className={styles.intro}>
          <span className={styles.kicker}>Archive</span>
          <h1 className={styles.title}>Seasons</h1>
          <p className={styles.lead}>
            Flashscore seasons loaded into the archive. Pick one to start an odds profile search.
          </p>
        </header>

        {!result.ok && (
          <div className={styles.banner}>
            {result.missingEnv ? "Supabase environment variables missing." : result.error}
          </div>
        )}

        {result.ok && (
          <ul className={styles.list}>
            {result.data.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/analyze?seasonSlug=${encodeURIComponent(s.id)}&marketType=HOME_DRAW_AWAY&marketScope=FULL_TIME`}
                  className={styles.card}
                >
                  <span className={styles.name}>{s.competition || s.id}</span>
                  <span className={styles.meta}>
                    {s.match_count} matches · {s.bookmaker_count} bookmakers
                  </span>
                </Link>
              </li>
            ))}
            {result.data.length === 0 && (
              <li className={styles.empty}>No seasons imported yet.</li>
            )}
          </ul>
        )}
      </main>
    </>
  );
}
