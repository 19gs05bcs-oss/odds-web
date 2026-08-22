import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketBoard } from "@/components/MarketBoard";
import { SiteHeader } from "@/components/SiteHeader";
import { getFixtureById } from "@/lib/archiveCache";
import { compactOddsToMarketsBlob, fixtureBookmakerCount } from "@/lib/fixtureMarkets";
import { formatKickoff } from "@/lib/format";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

type Props = {
  params: { id: string };
};

export async function generateMetadata({ params }: Props) {
  const decoded = decodeURIComponent(params.id);
  const fixture = await getFixtureById(decoded);
  if (!fixture) return { title: "Match" };
  return {
    title: `${fixture.home_name ?? "Home"} – ${fixture.away_name ?? "Away"} odds`,
    description: `Live and closing odds comparison for ${fixture.home_name ?? "Home"} vs ${fixture.away_name ?? "Away"}${
      fixture.league ? ` (${fixture.league})` : ""
    }.`,
  };
}

export default async function MatchDetailPage({ params }: Props) {
  const decoded = decodeURIComponent(params.id);
  const fixture = await getFixtureById(decoded);

  if (!fixture) {
    notFound();
  }

  const home = fixture.home_name || "Home";
  const away = fixture.away_name || "Away";
  const markets = compactOddsToMarketsBlob(fixture.odds, fixture.bookmakers);
  const bookmakerCount = fixtureBookmakerCount(fixture);

  return (
    <>
      <SiteHeader active="matches" />
      <main className={`shell ${styles.page}`}>
        <Link href="/matches" className={styles.back}>
          ← Back to matches
        </Link>

        <header className={`${styles.head} fade-up`}>
          <span className={styles.competition}>
            {fixture.league || fixture.league_country || "Football"}
          </span>
          <h1 className={styles.title}>
            {home} – {away}
          </h1>
          <div className={styles.meta}>
            <span>{formatKickoff(fixture.kickoff_at)}</span>
            {fixture.home_score != null && fixture.away_score != null ? (
              <span>
                FT: {fixture.home_score}–{fixture.away_score}
              </span>
            ) : null}
            {fixture.home_ht_score != null && fixture.away_ht_score != null ? (
              <span>
                HT: {fixture.home_ht_score}–{fixture.away_ht_score}
              </span>
            ) : null}
            <span className={styles.pill}>
              {bookmakerCount ? `${bookmakerCount} bookmakers` : "No odds yet"}
            </span>
          </div>
          <p className={styles.hint}>Best current price shown per selection · bookmaker below each price</p>
        </header>

        <MarketBoard markets={markets} />
      </main>
    </>
  );
}
