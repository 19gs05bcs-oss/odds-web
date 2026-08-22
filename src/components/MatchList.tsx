import Link from "next/link";
import type { FixtureRow } from "@/lib/archiveCache";
import { formatKickoff } from "@/lib/format";
import styles from "./MatchList.module.css";

type Props = {
  fixtures: FixtureRow[];
};

export function MatchList({ fixtures }: Props) {
  if (!fixtures.length) {
    return (
      <p className={styles.empty}>
        No fixtures for this date yet. They will appear here after the worker syncs.
      </p>
    );
  }

  return (
    <div className={styles.list}>
      {fixtures.map((f, index) => {
        const href = `/matches/${encodeURIComponent(f.match_id)}`;
        const home = f.home_name || "Home";
        const away = f.away_name || "Away";
        return (
          <Link
            key={f.match_id}
            href={href}
            className={styles.row}
            style={{ animationDelay: `${Math.min(index, 12) * 0.04}s` }}
          >
            <div className={styles.meta}>
              <span className={styles.competition}>
                {f.league || f.league_country || "Football"}
              </span>
              <span className={styles.kickoff}>{formatKickoff(f.kickoff_at)}</span>
            </div>
            <div className={styles.teams}>
              {home}
              <span className={styles.vs}>–</span>
              {away}
            </div>
            <span className={styles.badge}>
              {f.odds_count ? `${f.odds_count} odds` : "No odds yet"}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
