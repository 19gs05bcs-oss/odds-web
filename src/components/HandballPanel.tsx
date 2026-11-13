"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import { SportSelect, type Sport } from "@/components/SportSelect";
import type { FixtureRow } from "@/lib/archiveCache";
import type { CompactOddsRow } from "@/lib/handball";
import { formatOdds } from "@/lib/format";
import { clockInTz, dayKeyInTz } from "@/lib/time";
import type { BookmakerOption } from "@/lib/types";
import filterStyles from "@/components/AnalyzeFilters.module.css";
import saStyles from "./SmartAnalysisClient.module.css";
import styles from "./HandballPanel.module.css";

type OddsPair = { o: number | null; c: number | null };

type Similar = {
  id: string;
  season: string;
  ts: number;
  home: string;
  away: string;
  hs: string | null;
  as: string | null;
  distance: number;
  odds1x2?: {
    home: OddsPair;
    draw: OddsPair;
    away: OddsPair;
  };
  o1?: number | null;
  c1?: number | null;
  ox?: number | null;
  cx?: number | null;
  o2?: number | null;
  c2?: number | null;
  ahLine?: number | null;
  ahH_o?: number | null;
  ahH_c?: number | null;
  ahA_o?: number | null;
  ahA_c?: number | null;
  ouLine?: number | null;
  ouO_o?: number | null;
  ouO_c?: number | null;
  ouU_o?: number | null;
  ouU_c?: number | null;
  dc1x?: number | null;
  dc12?: number | null;
  dcx2?: number | null;
  dnbH?: number | null;
  dnbA?: number | null;
  bmUsed?: string;
  date?: string;
  time?: string;
  ft?: string;
  ftRes?: string;
  hts?: string | null;
  ats?: string | null;
  total?: number | null;
};

type SimState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; rows: Similar[] }
  | { status: "error"; message: string };

type BmOption = { id: string; name: string };

const fmtDate = (ts: number | string | undefined) => {
  if (ts == null || ts === "") return "—";
  if (typeof ts === "string" && /^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10);
  const n = Number(ts);
  const d = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
};

const fmtTime = (ts: number | string | undefined) => {
  if (ts == null || ts === "") return "—";
  if (typeof ts === "string" && ts.includes("T")) return ts.slice(11, 16);
  const n = Number(ts);
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 16);
};

/** Fixture row fields come from the Supabase `fixtureh` table (home_name, away_name, kickoff_at …). */
function fixtureDate(fx: FixtureRow, fallbackDay: string): string {
  return dayKeyInTz(fx.kickoff_at) || fallbackDay || "—";
}

function fixtureTime(fx: FixtureRow): string {
  return clockInTz(fx.kickoff_at) || "—";
}

function scorePair(a: string | number | null | undefined, b: string | number | null | undefined): string {
  if (a == null || b == null || a === "" || b === "") return "—";
  return `${a}-${b}`;
}

function fixtureHt(fx: FixtureRow): string {
  return scorePair(fx.home_ht_score, fx.away_ht_score);
}

function fixtureFt(fx: FixtureRow): string {
  return scorePair(fx.home_score, fx.away_score);
}

function fixtureTotal(fx: FixtureRow): string {
  const h = fx.home_score != null && fx.home_score !== "" ? Number(fx.home_score) : NaN;
  const a = fx.away_score != null && fx.away_score !== "" ? Number(fx.away_score) : NaN;
  return Number.isFinite(h) && Number.isFinite(a) ? String(h + a) : "—";
}

function ftResult(hs: string | null, as_: string | null): "Home" | "Draw" | "Away" | "" {
  if (hs == null || as_ == null || hs === "" || as_ === "") return "";
  const h = Number(hs);
  const a = Number(as_);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return "";
  return h > a ? "Home" : h < a ? "Away" : "Draw";
}

function resClass(res: string): string {
  if (res === "Home") return styles.resHome;
  if (res === "Away") return styles.resAway;
  if (res === "Draw") return styles.resDraw;
  return "";
}

function fmtOdd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v < 1.01) return "—";
  return formatOdds(v);
}

/** hit | miss | void | null (bilinmiyor) */
type Outcome = "hit" | "miss" | "void" | null;

function oddClass(oc: Outcome): string {
  if (oc === "hit") return styles.outcomeWin;
  if (oc === "miss") return styles.outcomeLose;
  if (oc === "void") return styles.outcomeVoid;
  return "";
}

function settle1x2(side: "H" | "D" | "A", hs: number | null, as_: number | null): Outcome {
  if (hs == null || as_ == null || !Number.isFinite(hs) || !Number.isFinite(as_)) return null;
  const res = hs > as_ ? "H" : hs < as_ ? "A" : "D";
  return res === side ? "hit" : "miss";
}

function settleOu(
  side: "O" | "U",
  total: number | null,
  line: number | null,
): Outcome {
  if (total == null || line == null || !Number.isFinite(total) || !Number.isFinite(line)) return null;
  if (total === line) return "void";
  const over = total > line;
  if (side === "O") return over ? "hit" : "miss";
  return over ? "miss" : "hit";
}

function settleAh(
  side: "H" | "A",
  hs: number | null,
  as_: number | null,
  line: number | null,
): Outcome {
  if (hs == null || as_ == null || line == null) return null;
  if (!Number.isFinite(hs) || !Number.isFinite(as_) || !Number.isFinite(line)) return null;
  // line is home handicap (e.g. -3.5 means home gives 3.5)
  const adj = hs + line - as_;
  if (adj === 0) return "void";
  if (side === "H") return adj > 0 ? "hit" : "miss";
  return adj < 0 ? "hit" : "miss";
}

function settleDc(side: "1X" | "12" | "X2", hs: number | null, as_: number | null): Outcome {
  if (hs == null || as_ == null || !Number.isFinite(hs) || !Number.isFinite(as_)) return null;
  const res = hs > as_ ? "H" : hs < as_ ? "A" : "D";
  if (side === "1X") return res === "H" || res === "D" ? "hit" : "miss";
  if (side === "12") return res === "H" || res === "A" ? "hit" : "miss";
  return res === "A" || res === "D" ? "hit" : "miss";
}

function settleDnb(side: "H" | "A", hs: number | null, as_: number | null): Outcome {
  if (hs == null || as_ == null || !Number.isFinite(hs) || !Number.isFinite(as_)) return null;
  if (hs === as_) return "void";
  if (side === "H") return hs > as_ ? "hit" : "miss";
  return hs < as_ ? "hit" : "miss";
}

function cellOdd(v: number | null | undefined, oc: Outcome) {
  return (
    <td className={`${styles.num} ${oddClass(oc)}`.trim()}>
      {fmtOdd(v)}
    </td>
  );
}

/** Seçili bookmaker için 1X2 açılış/kapanış oranlarını çıkarır (tek satırlık fikstür tablosu için). */
function extractFixture1x2ForBm(odds: CompactOddsRow[] | null | undefined, bmId: number) {
  const out = {
    home: { o: null as number | null, c: null as number | null },
    draw: { o: null as number | null, c: null as number | null },
    away: { o: null as number | null, c: null as number | null },
  };
  if (!odds?.length) return out;

  for (const row of odds) {
    if (Number(row[0]) !== bmId) continue;
    const t = String(row[1] || "").toLowerCase();
    const sc = String(row[2] || "").toLowerCase();
    const side = String(row[3] || "").toLowerCase();

    if ((t !== "1x2" && t !== "home_draw_away" && t !== "match_odds") || (sc !== "full_time" && sc !== "ft")) {
      continue;
    }

    const op = row[4] != null && Number(row[4]) > 1 ? Number(row[4]) : null;
    const cl = row[5] != null && Number(row[5]) > 1 ? Number(row[5]) : null;

    if (side === "home" || side === "1" || side === "h") {
      if (out.home.o == null) out.home.o = op ?? cl;
      if (out.home.c == null) out.home.c = cl ?? op;
    } else if (side === "draw" || side === "x" || side === "d") {
      if (out.draw.o == null) out.draw.o = op ?? cl;
      if (out.draw.c == null) out.draw.c = cl ?? op;
    } else if (side === "away" || side === "2" || side === "a") {
      if (out.away.o == null) out.away.o = op ?? cl;
      if (out.away.c == null) out.away.c = cl ?? op;
    }
  }
  return out;
}


/** Seçilen BM için AH / O/U / DC / DNB ana hatları (fixture odds). */
function extractFixtureMarkets(odds: CompactOddsRow[] | null | undefined, bmId: number) {
  const empty = {
    ahLine: null as number | null,
    ahH_o: null as number | null,
    ahH_c: null as number | null,
    ahA_o: null as number | null,
    ahA_c: null as number | null,
    ouLine: null as number | null,
    ouO_o: null as number | null,
    ouO_c: null as number | null,
    ouU_o: null as number | null,
    ouU_c: null as number | null,
    dc1x: null as number | null,
    dc12: null as number | null,
    dcx2: null as number | null,
    dnbH: null as number | null,
    dnbA: null as number | null,
  };
  if (!odds?.length) return empty;
  const num = (v: any) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 1 ? n : null;
  };
  const bmRows = odds.filter((r) => Number(r[0]) === bmId);
  if (!bmRows.length) return empty;

  let bestAh = Infinity;
  let ahLine: number | null = null;
  for (const row of bmRows) {
    const t = String(row[1] || "").toLowerCase();
    const s = String(row[2] || "").toLowerCase();
    const side = String(row[3] || "");
    const sideL = side.toLowerCase();
    if (!((t === "asian_handicap" || t === "ah" || t === "handicap") && (s === "full_time" || s === "ft"))) continue;
    if (!(sideL.startsWith("h:") || sideL.startsWith("home:"))) continue;
    const line = Number(side.split(":")[1]);
    const odd = num(row[5]) ?? num(row[4]);
    if (!Number.isFinite(line) || odd == null) continue;
    const diff = Math.abs(odd - 1.9);
    if (diff < bestAh) {
      bestAh = diff;
      ahLine = line;
    }
  }
  let ahH_o: number | null = null, ahH_c: number | null = null;
  let ahA_o: number | null = null, ahA_c: number | null = null;
  if (ahLine != null) {
    for (const row of bmRows) {
      const t = String(row[1] || "").toLowerCase();
      const s = String(row[2] || "").toLowerCase();
      const sideL = String(row[3] || "").toLowerCase();
      if (!((t === "asian_handicap" || t === "ah" || t === "handicap") && (s === "full_time" || s === "ft"))) continue;
      const op = num(row[4]);
      const cl = num(row[5]);
      if (sideL === `h:${ahLine}` || sideL === `home:${ahLine}`) {
        if (ahH_o == null) ahH_o = op ?? cl;
        if (ahH_c == null) ahH_c = cl ?? op;
      }
      if (
        sideL === `a:${-ahLine}` ||
        sideL === `away:${-ahLine}` ||
        sideL === `a:${ahLine}` ||
        sideL === `away:${ahLine}`
      ) {
        if (ahA_o == null) ahA_o = op ?? cl;
        if (ahA_c == null) ahA_c = cl ?? op;
      }
    }
  }

  let bestOu = Infinity;
  let ouLine: number | null = null;
  for (const row of bmRows) {
    const t = String(row[1] || "").toLowerCase();
    const s = String(row[2] || "").toLowerCase();
    const side = String(row[3] || "").toLowerCase();
    if (!((t === "over_under" || t === "totals" || t === "total" || t === "ou") && (s === "full_time" || s === "ft"))) continue;
    if (!(side.startsWith("over:") || side.startsWith("o:"))) continue;
    const line = Number(side.split(":")[1]);
    const odd = num(row[5]) ?? num(row[4]);
    if (!Number.isFinite(line) || odd == null) continue;
    const diff = Math.abs(odd - 1.9);
    if (diff < bestOu) {
      bestOu = diff;
      ouLine = line;
    }
  }
  let ouO_o: number | null = null, ouO_c: number | null = null;
  let ouU_o: number | null = null, ouU_c: number | null = null;
  if (ouLine != null) {
    for (const row of bmRows) {
      const t = String(row[1] || "").toLowerCase();
      const s = String(row[2] || "").toLowerCase();
      const side = String(row[3] || "").toLowerCase();
      if (!((t === "over_under" || t === "totals" || t === "total" || t === "ou") && (s === "full_time" || s === "ft"))) continue;
      const op = num(row[4]);
      const cl = num(row[5]);
      if (side === `over:${ouLine}` || side === `o:${ouLine}`) {
        if (ouO_o == null) ouO_o = op ?? cl;
        if (ouO_c == null) ouO_c = cl ?? op;
      }
      if (side === `under:${ouLine}` || side === `u:${ouLine}`) {
        if (ouU_o == null) ouU_o = op ?? cl;
        if (ouU_c == null) ouU_c = cl ?? op;
      }
    }
  }

  let dc1x: number | null = null, dc12: number | null = null, dcx2: number | null = null;
  for (const row of bmRows) {
    const t = String(row[1] || "").toLowerCase();
    const s = String(row[2] || "").toLowerCase();
    const side = String(row[3] || "").toLowerCase();
    if (!((t === "double_chance" || t === "dc") && (s === "full_time" || s === "ft"))) continue;
    const odd = num(row[5]) ?? num(row[4]);
    if (side === "dc:1x" || side === "1x" || side === "home_draw") dc1x = dc1x ?? odd;
    if (side === "dc:12" || side === "12" || side === "home_away") dc12 = dc12 ?? odd;
    if (side === "dc:x2" || side === "x2" || side === "draw_away") dcx2 = dcx2 ?? odd;
  }

  let dnbH: number | null = null, dnbA: number | null = null;
  for (const row of bmRows) {
    const t = String(row[1] || "").toLowerCase();
    const s = String(row[2] || "").toLowerCase();
    const side = String(row[3] || "").toLowerCase();
    if (!((t === "draw_no_bet" || t === "dnb") && (s === "full_time" || s === "ft"))) continue;
    const odd = num(row[5]) ?? num(row[4]);
    if (side === "h" || side === "home" || side === "1") dnbH = dnbH ?? odd;
    if (side === "a" || side === "away" || side === "2") dnbA = dnbA ?? odd;
  }

  return {
    ahLine, ahH_o, ahH_c, ahA_o, ahA_c,
    ouLine, ouO_o, ouO_c, ouU_o, ouU_c,
    dc1x, dc12, dcx2,
    dnbH, dnbA,
  };
}

/** True when the fixture carries at least one odds row for this bookmaker. */
function fixtureHasBm(fx: FixtureRow | null | undefined, bmId: string): boolean {
  if (!fx?.odds?.length) return false;
  const id = Number(bmId);
  return fx.odds.some((row) => Number(row[0]) === id);
}

/**
 * Pinned bookmaker list: the same fixed list the football view uses, always shown in
 * the same order. Any bookmaker that appears only in this fixture's odds is appended
 * at the end so nothing is hidden. A BM without odds for the selected match is still
 * pinned; it just reports "no similar matches found" when run.
 */
function pinnedBmOptions(
  pinned: BookmakerOption[],
  fx: FixtureRow | null | undefined,
): BmOption[] {
  const out: BmOption[] = pinned.map((b) => ({ id: String(b.id), name: b.name }));
  const seen = new Set(out.map((b) => b.id));
  if (fx?.odds?.length) {
    const names = (fx.bookmakers ?? {}) as Record<string, string>;
    for (const row of fx.odds) {
      const id = String(Number(row[0]));
      if (id === "NaN" || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: names[id] || `BM ${id}` });
    }
  }
  return out;
}

export function HandballPanel({
  sport,
  onSportChange,
  bookmakers,
}: {
  sport: Sport;
  onSportChange: (s: Sport) => void;
  bookmakers: BookmakerOption[];
}) {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [referenceBms, setReferenceBms] = useState<string[]>([]);
  const [simResults, setSimResults] = useState<Record<string, SimState>>({});

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
    setReferenceBms([]);
    setSimResults({});
    setError(undefined);
    (async () => {
      try {
        const res = await fetch(`/api/fixtureh?date=${encodeURIComponent(date)}`, {
          cache: "no-store",
        });
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

  const selectedFixture = useMemo(
    () => fixtures.find((f) => f.match_id === selectedId) ?? null,
    [fixtures, selectedId],
  );

  const availableBms = useMemo(
    () => pinnedBmOptions(bookmakers, selectedFixture),
    [bookmakers, selectedFixture],
  );

  // On match change: default to the first pinned BM that has odds for this match
  // (falls back to the first pinned BM). The list itself never changes.
  useEffect(() => {
    if (!selectedId) {
      setReferenceBms([]);
      setSimResults({});
      return;
    }
    const opts = pinnedBmOptions(bookmakers, selectedFixture);
    const first = opts.find((o) => fixtureHasBm(selectedFixture, o.id)) ?? opts[0];
    setReferenceBms(first ? [first.id] : []);
    setSimResults({});
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleBm = useCallback((id: string) => {
    setReferenceBms((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const runSimilar = useCallback(
    async (bmId: string) => {
      if (!selectedId) return;
      const fx = fixtures.find((f) => f.match_id === selectedId);
      const odds = fx?.odds ?? null;
      const bmName = pinnedBmOptions(bookmakers, fx).find((b) => b.id === bmId)?.name || "";
      if (!fixtureHasBm(fx, bmId)) {
        setSimResults((prev) => ({
          ...prev,
          [bmId]: {
            status: "error",
            message: `No odds from ${bmName || "this bookmaker"} for this match, so no similar matches could be found.`,
          },
        }));
        return;
      }
      setSimResults((prev) => ({ ...prev, [bmId]: { status: "loading" } }));
      try {
        const res = odds?.length
          ? await fetch("/api/handball/similar", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                id: selectedId,
                odds,
                bookmakerId: Number(bmId),
                bm: bmName,
              }),
            })
          : await fetch(
              `/api/handball/similar?id=${encodeURIComponent(selectedId)}&bookmakerId=${encodeURIComponent(bmId)}&bm=${encodeURIComponent(bmName)}`,
              { cache: "no-store" },
            );
        const j = await res.json();
        if (res.status === 404) {
          const msg =
            typeof j?.message === "string"
              ? j.message
              : "No similar matches found (not in the archive, or no odds).";
          setSimResults((prev) => ({ ...prev, [bmId]: { status: "error", message: msg } }));
          return;
        }
        if (!res.ok) throw new Error(j?.error || j?.message || `HTTP ${res.status}`);

        // Hem düz dizi [...] hem { matches: [...] } yanıtlarını destekle
        const list = Array.isArray(j) ? j : Array.isArray(j?.matches) ? j.matches : null;
        if (!list) throw new Error(j?.message || "Unexpected response");

        setSimResults((prev) => ({
          ...prev,
          [bmId]: { status: "done", rows: list as Similar[] },
        }));
      } catch (e) {
        setSimResults((prev) => ({
          ...prev,
          [bmId]: {
            status: "error",
            message: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [selectedId, fixtures, bookmakers],
  );

  // Seçili BM'ler için sırayla benzerlik çalıştır
  useEffect(() => {
    if (!selectedId || !referenceBms.length) return;
    for (const bmId of referenceBms) {
      const cur = simResults[bmId];
      if (!cur || cur.status === "idle") void runSimilar(bmId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, referenceBms.join(",")]);

  const statsFor = (rows: Similar[]) => {
    let h = 0,
      d = 0,
      a = 0,
      goals = 0,
      n = 0;
    for (const r of rows) {
      const x = Number(r.hs),
        y = Number(r.as);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n++;
      goals += x + y;
      if (x > y) h++;
      else if (x < y) a++;
      else d++;
    }
    return n ? { h, d, a, n, avg: goals / n } : null;
  };

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
            bookmakerId={Number(referenceBms[0]) || 0}
            loading={loading}
            ignoreOdds
            onSelect={setSelectedId}
          />
        </div>
      </div>

      <div className={filterStyles.filterSection}>
        <p className={filterStyles.filterSectionTitle}>
          Reference BMs ({referenceBms.length} selected)
        </p>
        <p className={filterStyles.hint}>
          Select one or more bookmakers — each runs similarity on that BM&apos;s odds profile
          and shows its own section below, in the order you picked them.
        </p>
        <div className={saStyles.tabs}>
          {availableBms.map((b) => (
            <button
              key={b.id}
              type="button"
              className={referenceBms.includes(b.id) ? saStyles.tabActive : saStyles.tab}
              onClick={() => toggleBm(b.id)}
            >
              {b.name}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.panel}>
        {error && <p className={`${styles.msg} ${styles.err}`}>{error}</p>}
        {!loading && !error && !fixtures.length && (
          <p className={styles.msg}>No handball matches for this day.</p>
        )}
        {!selectedId && fixtures.length > 0 && (
          <p className={styles.msg}>Select a match to list the most similar matches from the archive.</p>
        )}
        {selectedId && availableBms.length > 0 && referenceBms.length === 0 && (
          <p className={saStyles.empty}>Pick at least one reference bookmaker above.</p>
        )}

        {referenceBms.map((bmId) => {
          const bmName = availableBms.find((b) => b.id === bmId)?.name || `BM ${bmId}`;
          const sim = simResults[bmId] ?? { status: "idle" as const };
          const fx1x2 = extractFixture1x2ForBm(selectedFixture?.odds, Number(bmId));
          const fxMk = extractFixtureMarkets(selectedFixture?.odds, Number(bmId));
          const stats = sim.status === "done" ? statsFor(sim.rows) : null;

          return (
            <section key={bmId} className={saStyles.card}>
              <h3>{bmName} — similar matches</h3>

              {selectedFixture ? (
                <div className={saStyles.bmOpenedOdds}>
                  <p className={saStyles.cardLead}>{bmName} — odds for this match</p>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>SRC</th>
                          <th>DATE</th>
                          <th>TIME</th>
                          <th>LEAGUE</th>
                          <th>HOME</th>
                          <th>AWAY</th>
                          <th className={styles.num}>HT</th>
                          <th className={styles.num}>FT</th>
                          <th>FT RES</th>
                          <th className={styles.num}>Total</th>
                          <th className={styles.num}>1 O</th>
                          <th className={styles.num}>1 C</th>
                          <th className={styles.num}>X O</th>
                          <th className={styles.num}>X C</th>
                          <th className={styles.num}>2 O</th>
                          <th className={styles.num}>2 C</th>
                          <th className={styles.num}>AH</th>
                          <th className={styles.num}>AH H</th>
                          <th className={styles.num}>AH A</th>
                          <th className={styles.num}>OU</th>
                          <th className={styles.num}>O</th>
                          <th className={styles.num}>U</th>
                          <th className={styles.num}>1X</th>
                          <th className={styles.num}>12</th>
                          <th className={styles.num}>X2</th>
                          <th className={styles.num}>DNB H</th>
                          <th className={styles.num}>DNB A</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>fixture</td>
                          <td>{fixtureDate(selectedFixture, date)}</td>
                          <td>{fixtureTime(selectedFixture)}</td>
                          <td>{selectedFixture.league || "—"}</td>
                          <td>{selectedFixture.home_name || "—"}</td>
                          <td>{selectedFixture.away_name || "—"}</td>
                          <td className={styles.num}>{fixtureHt(selectedFixture)}</td>
                          <td className={styles.num}>{fixtureFt(selectedFixture)}</td>
                          <td>{ftResult(selectedFixture.home_score, selectedFixture.away_score) || "—"}</td>
                          <td className={styles.num}>{fixtureTotal(selectedFixture)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.home.o)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.home.c)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.draw.o)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.draw.c)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.away.o)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.away.c)}</td>
                          <td className={styles.num}>{fxMk.ahLine != null ? fxMk.ahLine : "—"}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.ahH_c ?? fxMk.ahH_o)}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.ahA_c ?? fxMk.ahA_o)}</td>
                          <td className={styles.num}>{fxMk.ouLine != null ? fxMk.ouLine : "—"}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.ouO_c ?? fxMk.ouO_o)}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.ouU_c ?? fxMk.ouU_o)}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.dc1x)}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.dc12)}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.dcx2)}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.dnbH)}</td>
                          <td className={styles.num}>{fmtOdd(fxMk.dnbA)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <p className={saStyles.cardLead}>
                Weighted similarity across markets this BM quotes for the match (1X2, O/U, …). Neighbours ranked by odds profile.
              </p>

              {sim.status === "idle" || sim.status === "loading" ? (
                <p className={styles.msg}>Loading archive…</p>
              ) : null}

              {sim.status === "error" ? (
                <>
                  <p className={`${styles.msg} ${styles.err}`}>{sim.message}</p>
                  <button
                    type="button"
                    className={saStyles.secondaryButton}
                    onClick={() => void runSimilar(bmId)}
                  >
                    Retry
                  </button>
                </>
              ) : null}

              {sim.status === "done" ? (
                <>
                  {stats && (
                    <div className={styles.summary}>
                      <span>
                        Home {stats.h} · Draw {stats.d} · Away {stats.a} ({stats.n} matches)
                      </span>
                      <span>Avg total goals: {stats.avg.toFixed(1)}</span>
                    </div>
                  )}
                  {sim.rows.length ? (
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>SRC</th>
                            <th>DATE</th>
                            <th>TIME</th>
                            <th>SEASON</th>
                            <th>HOME</th>
                            <th>AWAY</th>
                            <th className={styles.num}>HT</th>
                            <th className={styles.num}>FT</th>
                            <th>FT RES</th>
                            <th className={styles.num}>Total</th>
                            <th className={styles.num}>1 O</th>
                            <th className={styles.num}>1 C</th>
                            <th className={styles.num}>X O</th>
                            <th className={styles.num}>X C</th>
                            <th className={styles.num}>2 O</th>
                            <th className={styles.num}>2 C</th>
                            <th className={styles.num}>AH</th>
                            <th className={styles.num}>AH H</th>
                            <th className={styles.num}>AH A</th>
                            <th className={styles.num}>OU</th>
                            <th className={styles.num}>O</th>
                            <th className={styles.num}>U</th>
                            <th className={styles.num}>1X</th>
                            <th className={styles.num}>12</th>
                            <th className={styles.num}>X2</th>
                            <th className={styles.num}>DNB H</th>
                            <th className={styles.num}>DNB A</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sim.rows.map((r) => {
                            const res = ftResult(r.hs, r.as);
                            const o = r.odds1x2;
                            const o1 = o?.home?.o ?? r.o1;
                            const c1 = o?.home?.c ?? r.c1;
                            const ox = o?.draw?.o ?? r.ox;
                            const cx = o?.draw?.c ?? r.cx;
                            const o2 = o?.away?.o ?? r.o2;
                            const c2 = o?.away?.c ?? r.c2;
                            const hsN = r.hs != null && r.hs !== "" ? Number(r.hs) : null;
                            const asN = r.as != null && r.as !== "" ? Number(r.as) : null;
                            const total =
                              r.total != null
                                ? r.total
                                : hsN != null && asN != null && Number.isFinite(hsN) && Number.isFinite(asN)
                                  ? hsN + asN
                                  : null;
                            const ht =
                              r.hts != null && r.ats != null ? `${r.hts}-${r.ats}` : "—";
                            return (
                              <tr key={r.id}>
                                <td>archive</td>
                                <td>{r.date || fmtDate(r.ts)}</td>
                                <td>{r.time || fmtTime(r.ts)}</td>
                                <td>{r.season}</td>
                                <td>{r.home}</td>
                                <td>{r.away}</td>
                                <td className={styles.num}>{ht}</td>
                                <td className={styles.num}>
                                  {r.ft || (r.hs != null && r.as != null ? `${r.hs}-${r.as}` : "—")}
                                </td>
                                <td>
                                  {res ? (
                                    <span className={`${styles.resBadge} ${resClass(res)}`}>
                                      {res}
                                    </span>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td className={styles.num}>{total != null ? total : "—"}</td>
                                {cellOdd(o1, settle1x2("H", hsN, asN))}
                                {cellOdd(c1, settle1x2("H", hsN, asN))}
                                {cellOdd(ox, settle1x2("D", hsN, asN))}
                                {cellOdd(cx, settle1x2("D", hsN, asN))}
                                {cellOdd(o2, settle1x2("A", hsN, asN))}
                                {cellOdd(c2, settle1x2("A", hsN, asN))}
                                <td className={styles.num}>{r.ahLine != null ? r.ahLine : "—"}</td>
                                {cellOdd(r.ahH_c ?? r.ahH_o, settleAh("H", hsN, asN, r.ahLine ?? null))}
                                {cellOdd(r.ahA_c ?? r.ahA_o, settleAh("A", hsN, asN, r.ahLine ?? null))}
                                <td className={styles.num}>{r.ouLine != null ? r.ouLine : "—"}</td>
                                {cellOdd(r.ouO_c ?? r.ouO_o, settleOu("O", total, r.ouLine ?? null))}
                                {cellOdd(r.ouU_c ?? r.ouU_o, settleOu("U", total, r.ouLine ?? null))}
                                {cellOdd(r.dc1x, settleDc("1X", hsN, asN))}
                                {cellOdd(r.dc12, settleDc("12", hsN, asN))}
                                {cellOdd(r.dcx2, settleDc("X2", hsN, asN))}
                                {cellOdd(r.dnbH, settleDnb("H", hsN, asN))}
                                {cellOdd(r.dnbA, settleDnb("A", hsN, asN))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className={saStyles.empty}>No matches under the similarity threshold.</p>
                  )}
                  <button
                    type="button"
                    className={saStyles.secondaryButton}
                    onClick={() => void runSimilar(bmId)}
                  >
                    Recompute
                  </button>
                </>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
