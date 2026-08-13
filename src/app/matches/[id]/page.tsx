import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketBoard } from "@/components/MarketBoard";
import { SiteHeader } from "@/components/SiteHeader";
import { getEventById, marketsFromEvent } from "@/lib/archieve";
import { formatKickoff, formatRelative, sourceLabel } from "@/lib/format";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

type Props = {
  params: { id: string };
};

export async function generateMetadata({ params }: Props) {
  const decoded = decodeURIComponent(params.id);
  const result = await getEventById(decoded);
  if (!result.ok || !result.data) {
    return { title: "Match" };
  }
  const e = result.data;
  return {
    title: `${e.home_team ?? "Home"} – ${e.away_team ?? "Away"}`,
  };
}

export default async function MatchDetailPage({ params }: Props) {
  const decoded = decodeURIComponent(params.id);
  const result = await getEventById(decoded);

  if (!result.ok) {
    return (
      <>
        <SiteHeader active="matches" />
        <main className={`shell ${styles.page}`}>
          <Link href="/matches" className={styles.back}>
            ← Back to matches
          </Link>
          <div className={styles.banner}>
            {result.missingEnv
              ? "Supabase environment variables missing."
              : `Could not load data: ${result.error}`}
          </div>
        </main>
      </>
    );
  }

  if (!result.data) {
    notFound();
  }

  const event = result.data;
  const markets = marketsFromEvent(event);
  const home = event.home_team || "Home";
  const away = event.away_team || "Away";

  return (
    <>
      <SiteHeader active="matches" />
      <main className={`shell ${styles.page}`}>
        <Link href="/matches" className={styles.back}>
          ← Back to matches
        </Link>

        <header className={`${styles.head} fade-up`}>
          <span className={styles.competition}>
            {event.competition || event.sport || "Football"}
          </span>
          <h1 className={styles.title}>
            {home} – {away}
          </h1>
          <div className={styles.meta}>
            <span>{formatKickoff(event.kickoff_at)}</span>
            {event.home_score != null && event.away_score != null ? (
              <span>
                FT: {event.home_score}–{event.away_score}
              </span>
            ) : null}
            {event.home_ht_score != null && event.away_ht_score != null ? (
              <span>
                HT: {event.home_ht_score}–{event.away_ht_score}
              </span>
            ) : null}
            {event.round ? <span>{event.round}</span> : null}
            <span>Updated {formatRelative(event.odds_updated_at)}</span>
            <span className={styles.pill}>{sourceLabel(event.source)}</span>
            {event.status ? <span>{event.status}</span> : null}
          </div>
          <p className={styles.hint}>
            Strikethrough = opening · bold = closing · bookmaker below each price
          </p>
        </header>

        <MarketBoard markets={markets} />
      </main>
    </>
  );
}
