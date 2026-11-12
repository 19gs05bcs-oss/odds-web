"use client";

import { useEffect, useMemo, useState } from "react";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import { SportSelect, type Sport } from "@/components/SportSelect";
import type { FixtureRow } from "@/lib/archiveCache";
import filterStyles from "@/components/AnalyzeFilters.module.css";
import styles from "./HandballPanel.module.css";

type Similar = {
  id: string;
  season: string;
  ts: number;
  home: string;
  away: string;
  hs: string | null;
  as: string | null;
  distance: number;
};

type SimState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; rows: Similar[] }
  | { status: "notfound" }
  | { status: "error"; message: string };

const fmtDate = (ts: number) => {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
};

export function HandballPanel({
  sport,
  onSportChange,
}: {
  sport: Sport;
  onSportChange: (s: Sport) => void;
}) {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sim, setSim] = useState<SimState>({ status: "idle" });

  // 1) Gün listesi (fixtureh)
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const res = await fetch("/api/fixtureh?dates=1", { cache: "no-store" });
        const j = (await res.json()) as { dates?: string[]; error?: string };
        if (!res.ok) throw new Error(j.error || res.statusText);
        if (off) return;
        const ds = j.dates ?? [];
        setDates(ds);
        const today = new Date().toISOString().slice(0, 10);
        setDate(ds.includes(today) ? today : ds[0] ?? "");
        if (!ds.length) setLoading(false);
      } catch (e) {
        if (off) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      off = true;
    };
  }, []);

  // 2) Seçili günün maçları
  useEffect(() => {
    if (!date) return;
    let off = false;
    setLoading(true);
    setSelectedId(null);
    setSim({ status: "idle" });
    setError(undefined);
    (async () => {
      try {
        const res = await fetch(`/api/fixtureh?date=${encodeURIComponent(date)}`, { cache: "no-store" });
        const j = (await res.json()) as { fixtures?: FixtureRow[]; error?: string };
        if (!res.ok) throw new Error(j.error || res.statusText);
        if (!off) setFixtures(j.fixtures ?? []);
      } catch (e) {
        if (!off) {
          setFixtures([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!off) setLoading(false);
      }
    })();
    return () => {
      off = true;
    };
  }, [date]);

  // 3) Maç seçilince R2 arşivinden benzer maçlar
  useEffect(() => {
    if (!selectedId) {
      setSim({ status: "idle" });
      return;
    }
    let off = false;
    setSim({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/handball/similar?id=${encodeURIComponent(selectedId)}`, {
          cache: "no-store",
        });
        if (off) return;
        if (res.status === 404) return setSim({ status: "notfound" });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        setSim({ status: "done", rows: j as Similar[] });
      } catch (e) {
        if (!off) setSim({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      off = true;
    };
  }, [selectedId]);

  const stats = useMemo(() => {
    if (sim.status !== "done") return null;
    let h = 0, d = 0, a = 0, goals = 0, n = 0;
    for (const r of sim.rows) {
      const x = Number(r.hs), y = Number(r.as);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n++;
      goals += x + y;
      if (x > y) h++;
      else if (x < y) a++;
      else d++;
    }
    return n ? { h, d, a, n, avg: goals / n } : null;
  }, [sim]);

  return (
    <div className={filterStyles.wrap}>
      <div className={filterStyles.topBar}>
        <div className={filterStyles.topBarRow}>
          <SportSelect value={sport} onChange={onSportChange} />
          <label className={filterStyles.field}>
            <span>Day</span>
            <select value={date} onChange={(e) => setDate(e.target.value)} disabled={loading}>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              {!dates.length ? <option value="">—</option> : null}
            </select>
          </label>
          <FixtureMatchStrip
            fixtures={fixtures}
            selectedId={selectedId}
            bookmakerId={0}
            loading={loading}
            ignoreOdds
            onSelect={setSelectedId}
          />
        </div>
      </div>

      <div className={styles.panel}>
        {error && <p className={`${styles.msg} ${styles.err}`}>{error}</p>}
        {!loading && !error && !fixtures.length && (
          <p className={styles.msg}>No handball matches for this day.</p>
        )}
        {sim.status === "idle" && fixtures.length > 0 && (
          <p className={styles.msg}>Select a match to list the most similar matches from the archive.</p>
        )}
        {sim.status === "loading" && <p className={styles.msg}>Loading archive…</p>}
        {sim.status === "notfound" && (
          <p className={styles.msg}>
            This match is not in the archive index (match_id not found), so similar matches could not be computed.
          </p>
        )}
        {sim.status === "error" && <p className={`${styles.msg} ${styles.err}`}>{sim.message}</p>}

        {sim.status === "done" && (
          <>
            {stats && (
              <div className={styles.summary}>
                <span>
                  Home {stats.h} · Draw {stats.d} · Away {stats.a} ({stats.n} matches)
                </span>
                <span>Avg total goals: {stats.avg.toFixed(1)}</span>
              </div>
            )}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Season</th>
                    <th>Match</th>
                    <th className={styles.num}>Score</th>
                    <th className={styles.num}>Distance</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDate(r.ts)}</td>
                      <td>{r.season}</td>
                      <td>
                        {r.home} – {r.away}
                      </td>
                      <td className={styles.num}>
                        {r.hs}-{r.as}
                      </td>
                      <td className={styles.num}>{r.distance.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
