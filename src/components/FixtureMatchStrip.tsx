"use client";

import type { FixtureRow } from "@/lib/fixtures";
import styles from "./AnalyzeFilters.module.css";

type Props = {
  fixtures: FixtureRow[];
  selectedId: string | null;
  bookmakerId: number;
  loading?: boolean;
  oddsLoading?: boolean;
  onSelect: (matchId: string) => void;
};

function hasBmOdds(f: FixtureRow, bmId: number): boolean {
  if (!Array.isArray(f.odds)) return false;
  return f.odds.some((row) => Array.isArray(row) && Number(row[0]) === bmId);
}

function kickoffLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function FixtureMatchStrip({
  fixtures,
  selectedId,
  bookmakerId,
  loading,
  oddsLoading,
  onSelect,
}: Props) {
  const withOdds = fixtures.filter((f) => hasBmOdds(f, bookmakerId));
  const list = withOdds.length ? withOdds : fixtures;

  return (
    <label className={`${styles.field} ${styles.fieldGrow}`}>
      <span>
        Fixture
        {!loading && list.length > 0 ? (
          <span className={styles.fieldMeta}>
            {oddsLoading ? `${withOdds.length}/${fixtures.length}` : withOdds.length}
          </span>
        ) : null}
      </span>
      <select
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={loading || !list.length}
      >
        <option value="">{loading ? "Loading…" : "Select match…"}</option>
        {list.map((f) => {
          const ready = hasBmOdds(f, bookmakerId);
          const time = kickoffLabel(f.kickoff_at);
          const teams = `${f.home_name || "?"} – ${f.away_name || "?"}`;
          const label = `${time ? `${time} · ` : ""}${teams}`;
          return (
            <option
              key={f.match_id}
              value={f.match_id}
              disabled={!ready && !oddsLoading}
            >
              {label}
              {f.league ? ` (${f.league})` : ""}
            </option>
          );
        })}
      </select>
    </label>
  );
}
