import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { fmtKickoff, getRecord, listPastTips, listUpcomingTips, type FreeTip } from "@/lib/freeTips";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Free Football Betting Tips Today — Odds-Based Predictions",
  description:
    "Free football tips every day, picked from opening-to-closing odds movement and matched against 330+ seasons of historical odds. Market, odds, confidence and full analysis for each pick.",
  alternates: { canonical: "/free-tips" },
};

function Stars({ n }: { n: number | null }) {
  if (!n) return null;
  return (
    <span className={styles.stars} aria-label={`Confidence ${n} of 5`}>
      {"★".repeat(n)}
      {"☆".repeat(5 - n)}
    </span>
  );
}

function TipCard({ t }: { t: FreeTip }) {
  return (
    <Link href={`/free-tips/${t.slug}`} className={styles.card}>
      <div className={styles.meta}>
        <span>{t.league ?? "Football"}</span>
        <span>{fmtKickoff(t.kickoff_at)}</span>
      </div>
      <div className={styles.teams}>
        {t.home_name} vs {t.away_name}
      </div>
      <div className={styles.pickRow}>
        <span className={styles.pick}>
          {t.market}: {t.pick}
        </span>
        {t.odds != null && <span className={styles.odds}>@ {t.odds.toFixed(2)}</span>}
        <Stars n={t.confidence} />
        {t.result !== "pending" && (
          <span className={`${styles.badge} ${styles[t.result]}`}>
            {t.result}
            {t.home_score != null && t.away_score != null ? ` · ${t.home_score}-${t.away_score}` : ""}
          </span>
        )}
      </div>
    </Link>
  );
}

export default async function FreeTipsPage() {
  const [upcoming, past, record] = await Promise.all([
    listUpcomingTips(),
    listPastTips(),
    getRecord(30),
  ]);

  const listJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Free football tips",
    itemListElement: upcoming.slice(0, 20).map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://oddsvig.com/free-tips/${t.slug}`,
      name: `${t.home_name} vs ${t.away_name} — ${t.market}: ${t.pick}`,
    })),
  };

  return (
    <>
      <SiteHeader active="tips" />
      {upcoming.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(listJsonLd) }}
        />
      )}
      <main className={`shell ${styles.page}`}>
        <header className={`${styles.intro} fade-up`}>
          <span className={styles.kicker}>Free tips</span>
          <h1 className={styles.title}>Free football tips — picked from odds movement</h1>
          <p className={styles.lead}>
            Every pick below comes from how the market moved from opening to closing price and how
            historically similar odds shapes finished in our archive of 330+ seasons. No paywall —
            the market, the odds and the reasoning are all shown.
          </p>
          {record.settled >= 10 && (
            <span className={styles.record}>
              Last 30 days: {record.won}/{record.settled} won (
              {Math.round((record.won / record.settled) * 100)}%)
            </span>
          )}
        </header>

        <h2 className={styles.h2}>Upcoming tips</h2>
        {upcoming.length ? (
          <div className={styles.grid}>
            {upcoming.map((t) => (
              <TipCard key={t.id} t={t} />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            No open tips right now — new picks are posted before each matchday.
          </div>
        )}

        {past.length > 0 && (
          <>
            <h2 className={styles.h2}>Recent results</h2>
            <div className={styles.grid}>
              {past.map((t) => (
                <TipCard key={t.id} t={t} />
              ))}
            </div>
          </>
        )}

        <section className={styles.cta}>
          <p>
            Want to check a fixture yourself? <Link href="/odds-guide">Read the odds guide</Link> or{" "}
            <Link href="/#pricing">unlock Smart Analysis</Link> to search the full archive for
            matches with the same odds shape.
          </p>
        </section>

        <p className={styles.disclaimer}>
          18+ only. Tips are informational odds analysis, not financial advice or a guarantee of any
          outcome. Past results do not predict future results. Gamble responsibly.
        </p>
      </main>
    </>
  );
}
