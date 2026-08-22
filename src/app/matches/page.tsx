import Link from "next/link";
import { MatchList } from "@/components/MatchList";
import { SiteHeader } from "@/components/SiteHeader";
import { listFixtures, listFixtureDates } from "@/lib/archiveCache";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Upcoming Matches — Live Fixture Odds",
  description:
    "Today's and upcoming fixtures from the live bulletin, with odds pulled straight from Supabase. Pick a match to see the full bookmaker board.",
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(d);
}

type Props = {
  searchParams: { date?: string };
};

export default async function MatchesPage({ searchParams }: Props) {
  const today = todayUtc();
  const rawDates = await listFixtureDates(14);
  // listFixtureDates DESC döner; bugünden itibaren ileri tarihleri
  // artan sırada, sadece bugün ve sonrasını göster.
  const upcoming = rawDates.filter((d) => d >= today).sort();
  const dates = upcoming.length ? upcoming : rawDates.slice(0, 1);

  const requested = searchParams?.date?.trim();
  const date = requested && dates.includes(requested) ? requested : dates[0] || today;

  const fixtures = await listFixtures(date);

  return (
    <>
      <SiteHeader active="matches" />
      <main className={`shell ${styles.page}`}>
        <header className={`${styles.intro} fade-up`}>
          <span className={styles.kicker}>Live bulletin</span>
          <h1 className={styles.title}>Upcoming matches</h1>
          <p className={styles.lead}>
            Fixtures from the live bulletin, listed by kickoff. Pick a match for the full
            bookmaker odds board.
          </p>
        </header>

        {dates.length > 0 && (
          <nav className={styles.dateNav} aria-label="Bulletin date">
            {dates.map((d) => (
              <Link
                key={d}
                href={`/matches?date=${d}`}
                className={d === date ? `${styles.dateChip} ${styles.dateChipActive}` : styles.dateChip}
              >
                {d === today ? "Today" : formatDateLabel(d)}
              </Link>
            ))}
          </nav>
        )}

        {!dates.length ? (
          <div className={styles.banner}>
            No fixture dates found yet. Check back once the bulletin worker has synced.
          </div>
        ) : (
          <MatchList fixtures={fixtures} />
        )}
      </main>
    </>
  );
}
