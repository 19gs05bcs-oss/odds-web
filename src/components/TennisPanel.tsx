"use client";

import { useEffect, useMemo, useState } from "react";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import { SportSelect, type Sport } from "@/components/SportSelect";
import type { FixtureRow } from "@/lib/archiveCache";
import { marketSnapshot, type CompactOddsRow } from "@/lib/volleyballOdds";
import { formatOdds } from "@/lib/format";
import { clockInTz, dayKeyInTz, todayInTz } from "@/lib/time";
import filterStyles from "@/components/AnalyzeFilters.module.css";
import styles from "./HandballPanel.module.css";

/** Tenis: fixturet'ten günlük maç + bookmaker bazlı ML / AH (oyun) / OU (oyun) oranları.
 *  Arşiv (benzer maç) henüz yok; arşiv eklenince Volleyball/Basketball paneli gibi alt bölüm eklenir. */
type TFixture = FixtureRow & {
  tour?: string | null;
  state?: string | null;
  status?: string | null;
  home_periods?: string | null;
  away_periods?: string | null;
  home_tb?: string | null;
  away_tb?: string | null;
};

type BmOption = { id: string; name: string };

const fmtOdd = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) || v < 1.01 ? "—" : formatOdds(v);

const fmtLine = (v: number | null | undefined) => (v == null ? "—" : v > 0 ? `+${v}` : String(v));

const pair = (o: number | null | undefined, c: number | null | undefined) =>
  o == null && c == null ? "—" : `${fmtOdd(o)} → ${fmtOdd(c)}`;

/** "6,7,6" + "4,6,3" (+ tb) -> "6-4  7-6(5)  6-3" */
function setLine(fx: TFixture): string {
  const h = String(fx.home_periods ?? "").split(",").filter((x) => x !== "");
  const a = String(fx.away_periods ?? "").split(",").filter((x) => x !== "");
  const th = String(fx.home_tb ?? "").split(",");
  const ta = String(fx.away_tb ?? "").split(",");
  if (!h.length || h.length !== a.length) return "—";
  return h
    .map((x, i) => {
      const tb = [th[i], ta[i]].filter((t) => t !== undefined && t !== "");
      const loser = tb.length ? Math.min(...tb.map(Number)) : null;
      return `${x}-${a[i]}${loser != null && Number.isFinite(loser) ? `(${loser})` : ""}`;
    })
    .join("  ");
}

const STATUS: Record<string, string> = { "8": "RET", "9": "WO" };

export function TennisPanel({
  sport,
  onSportChange,
  bookmakers = [],
}: {
  sport: Sport;
  onSportChange: (s: Sport) => void;
  bookmakers?: BmOption[];
}) {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [fixtures, setFixtures] = useState<TFixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 1) Gün listesi: bugün-3 ve sonrası, tabloda olan tüm günler
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const res = await fetch("/api/fixturet?dates=1", { cache: "no-store" });
        const j = (await res.json()) as { dates?: string[]; error?: string };
        if (!res.ok) throw new Error(j.error || res.statusText);
        if (off) return;
        const ds = j.dates ?? [];
        setDates(ds);
        const today = todayInTz();
        // bugün varsa bugün; yoksa bugünden sonraki ilk gün; o da yoksa son gün
        setDate(ds.includes(today) ? today : ds.find((d) => d > today) ?? ds[ds.length - 1] ?? "");
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
    setError(undefined);
    (async () => {
      try {
        const res = await fetch(`/api/fixturet?date=${encodeURIComponent(date)}`, { cache: "no-store" });
        const j = (await res.json()) as { fixtures?: TFixture[]; error?: string };
        if (!res.ok) throw new Error(j.error || res.statusText);
        // Oranı olmayan maçlar odds sitesinde işe yaramaz → gösterme (diğer sporlarla aynı)
        if (!off) setFixtures((j.fixtures ?? []).filter((f) => Array.isArray(f.odds) && f.odds.length > 0));
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

  const fx = useMemo(() => fixtures.find((f) => f.match_id === selectedId) ?? null, [fixtures, selectedId]);

  // Seçili maçtaki her bookmaker için ML / AH / OU özeti
  const rows = useMemo(() => {
    if (!fx) return [];
    const odds = fx.odds as CompactOddsRow[];
    const names: Record<string, string> = { ...(fx.bookmakers ?? {}) };
    for (const b of bookmakers) if (!names[b.id]) names[b.id] = b.name;
    const ids = [...new Set(odds.map((r) => String(r[0])))];
    return ids
      .map((id) => ({ id, name: names[id] || `BM ${id}`, s: marketSnapshot(odds, Number(id)) }))
      .filter((r) => r.s.ml.hc != null || r.s.ml.ho != null || r.s.ahLine != null || r.s.ouLine != null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [fx, bookmakers]);

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
        {!loading && !error && !fixtures.length && <p className={styles.msg}>No tennis matches with odds for this day.</p>}
        {!selectedId && fixtures.length > 0 && <p className={styles.msg}>Select a match to see bookmaker odds.</p>}

        {fx && (
          <>
            <h3>
              {fx.home_name} – {fx.away_name}
            </h3>
            <p className={styles.msg}>
              {fx.league || fx.tour || "Tennis"} · {dayKeyInTz(fx.kickoff_at) || date} {clockInTz(fx.kickoff_at)}
              {fx.state === "finished" || fx.state === "live" ? (
                <>
                  {" "}· {fx.home_score ?? "–"}-{fx.away_score ?? "–"} (sets) · {setLine(fx)}
                  {STATUS[String(fx.status)] ? ` · ${STATUS[String(fx.status)]}` : ""}
                </>
              ) : null}
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Bookmaker</th>
                    <th>Home (open → close)</th>
                    <th>Away (open → close)</th>
                    <th>AH games</th>
                    <th>AH Home</th>
                    <th>AH Away</th>
                    <th>OU games</th>
                    <th>Over</th>
                    <th>Under</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ id, name, s }) => (
                    <tr key={id}>
                      <td>{name}</td>
                      <td className={styles.num}>{pair(s.ml.ho, s.ml.hc)}</td>
                      <td className={styles.num}>{pair(s.ml.ao, s.ml.ac)}</td>
                      <td className={styles.num}>{fmtLine(s.ahLine)}</td>
                      <td className={styles.num}>{pair(s.ahH_o, s.ahH_c)}</td>
                      <td className={styles.num}>{pair(s.ahA_o, s.ahA_c)}</td>
                      <td className={styles.num}>{s.ouLine ?? "—"}</td>
                      <td className={styles.num}>{pair(s.ouO_o, s.ouO_c)}</td>
                      <td className={styles.num}>{pair(s.ouU_o, s.ouU_c)}</td>
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
