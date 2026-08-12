import Link from "next/link";
import { formatKickoff, sourceLabel } from "@/lib/format";
import type { OddsEvent } from "@/lib/types";
import styles from "./MatchList.module.css";

type Props = {
  events: OddsEvent[];
};

export function MatchList({ events }: Props) {
  if (!events.length) {
    return (
      <p className={styles.empty}>
        No open matches yet. They will appear here after the worker syncs.
      </p>
    );
  }

  return (
    <div className={styles.list}>
      {events.map((event, index) => {
        const href = `/matches/${encodeURIComponent(event.id)}`;
        const home = event.home_team || "Home";
        const away = event.away_team || "Away";
        return (
          <Link
            key={event.id}
            href={href}
            className={styles.row}
            style={{ animationDelay: `${Math.min(index, 12) * 0.04}s` }}
          >
            <div className={styles.meta}>
              <span className={styles.competition}>
                {event.competition || event.sport || "Football"}
              </span>
              <span className={styles.kickoff}>{formatKickoff(event.kickoff_at)}</span>
            </div>
            <div className={styles.teams}>
              {home}
              <span className={styles.vs}>–</span>
              {away}
            </div>
            <span className={styles.badge}>{sourceLabel(event.source)}</span>
          </Link>
        );
      })}
    </div>
  );
}
