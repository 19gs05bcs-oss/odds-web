"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalyzeTable } from "@/components/AnalyzeTable";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import { MarketFilterPanel } from "@/components/MarketFilterPanel";
import styles from "@/components/AnalyzeFilters.module.css";
import {
  criterionLabel,
  encodeCriterion,
  decodeCriterion,
  marketSlotKey,
  type OddsCriterion,
  type ProfileResult,
} from "@/lib/analysis/profile";
import {
  fixtureHasOdds,
  fixtureToTableRow,
  fixturesToTableRowsForFilter,
  mergeFixtureAndArchiveRows,
  PREFERRED_BM,
  resolveCriteriaFromFixture,
  tableRowMatchesCriteria,
  type TableRow,
} from "@/lib/analysis/tableRows";
import type { BookmakerOption } from "@/lib/types";
import type { FixtureRow } from "@/lib/archiveCache";

type ProfileSearchResult = ProfileResult & { tableRows?: TableRow[] };

type Props = {
  bookmakers: BookmakerOption[];
  fixtures: FixtureRow[];
  fixtureDates: string[];
  initialBulletinDate: string;
  initialCriteria: OddsCriterion[];
  initialBookmakerId: string;
  initialTolerance: string;
  autoRun: boolean;
  /** URL path for filter sync (default /analyze). */
  urlPath?: string;
  /** Smart Analysis: bookmaker driven by parent. */
  controlledBookmakerId?: string;
  controlledTolerance?: string;
  hideBookmakerSelect?: boolean;
};

export default function AnalyzeClient({
  bookmakers,
  fixtures: initialFixtures,
  fixtureDates,
  initialBulletinDate,
  initialCriteria,
  initialBookmakerId,
  initialTolerance,
  autoRun,
  urlPath = "/analyze",
  controlledBookmakerId,
  controlledTolerance,
  hideBookmakerSelect = false,
}: Props) {
  const [criteria, setCriteria] = useState<OddsCriterion[]>(initialCriteria);
  const [bookmakerIdState, setBookmakerIdState] = useState(
    initialBookmakerId || String(PREFERRED_BM),
  );
  const [toleranceState] = useState(initialTolerance || "0");
  const bookmakerId = controlledBookmakerId ?? bookmakerIdState;
  const tolerance = controlledTolerance ?? toleranceState;
  const [bulletinDate, setBulletinDate] = useState(initialBulletinDate);
  const [fixtures, setFixtures] = useState<FixtureRow[]>(initialFixtures);
  const [fixturesLoading, setFixturesLoading] = useState(!!initialBulletinDate);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsChunksDone, setOddsChunksDone] = useState(0);
  const [oddsChunksTotal, setOddsChunksTotal] = useState(0);
  const [pinnedRows, setPinnedRows] = useState<TableRow[]>([]);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);

  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ProfileSearchResult | null>(null);
  const [error, setError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const ranRef = useRef(false);

  const bmNum = Number(bookmakerId) || PREFERRED_BM;
  const bmAny = !bookmakerId;
  const tolNum = Number(tolerance);
  const tolSafe = Number.isFinite(tolNum) && tolNum >= 0 ? tolNum : 0;

  const selectedFixture = useMemo(
    () => fixtures.find((f) => f.match_id === selectedFixtureId) ?? null,
    [fixtures, selectedFixtureId],
  );

  const resolvedCriteria = useMemo(
    () => resolveCriteriaFromFixture(criteria, selectedFixture, bmNum),
    [criteria, selectedFixture, bmNum],
  );

  const bulletinRows = useMemo(() => {
    if (!resolvedCriteria.length) return [];
    return fixturesToTableRowsForFilter(fixtures, bmNum, resolvedCriteria, tolSafe, bmAny);
  }, [fixtures, bmNum, resolvedCriteria, tolSafe, bmAny]);

  const fixturesWithBmOdds = useMemo(() => {
    if (!Array.isArray(fixtures)) return [];
    return fixtures.filter((f) => {
      if (!Array.isArray(f.odds)) return false;
      return f.odds.some((row) => Array.isArray(row) && Number(row[0]) === bmNum);
    });
  }, [fixtures, bmNum]);

  // Auto-select first match with odds when loaded
  useEffect(() => {
    if (selectedFixtureId && fixtures.some((f) => f.match_id === selectedFixtureId)) return;
    const first = fixturesWithBmOdds[0];
    if (first) setSelectedFixtureId(first.match_id);
    else if (fixtures.length && !oddsLoading) setSelectedFixtureId(fixtures[0]?.match_id ?? null);
  }, [fixturesWithBmOdds, fixtures, selectedFixtureId, oddsLoading]);

  const archiveRows = useMemo(() => {
    const fromApi = result?.tableRows ?? [];
    if (!pinnedRows.length) return fromApi;
    const seen = new Set(fromApi.map((r) => r.id));
    const extra = pinnedRows.filter((r) => r.id && !seen.has(r.id));
    return extra.length ? [...extra, ...fromApi] : fromApi;
  }, [result, pinnedRows]);

  const tableRows = useMemo(
    () =>
      mergeFixtureAndArchiveRows(bulletinRows, archiveRows, {
        criteria: resolvedCriteria,
        tolerance: tolSafe,
      }),
    [bulletinRows, archiveRows, resolvedCriteria, tolSafe],
  );

  // Pin sadece hâlâ kritere uyan satırlar için (yanlış AH line / oran üste yapışmasın)
  const displayRows = useMemo(() => {
    if (!resolvedCriteria.length || !pinnedRows.length) return tableRows;
    const ids = new Set(tableRows.map((r) => r.id));
    const missing = pinnedRows.filter(
      (r) =>
        r.id &&
        !ids.has(r.id) &&
        tableRowMatchesCriteria(r, resolvedCriteria, tolSafe),
    );
    return missing.length ? [...missing, ...tableRows] : tableRows;
  }, [tableRows, pinnedRows, resolvedCriteria, tolSafe]);

  const pinnedRowIds = useMemo(
    () => new Set(pinnedRows.map((r) => r.id).filter(Boolean)),
    [pinnedRows],
  );

  const archiveDisplayRows = useMemo(
    () => displayRows.filter((r) => r.source === "archive"),
    [displayRows],
  );

  const archiveCount = archiveDisplayRows.length;
  const fixturesWithOdds = fixtures.filter(fixtureHasOdds).length;
  const fixturesTotal = fixtures.length;

  async function applyOddsPatches(
    patches: Array<
      Pick<FixtureRow, "match_id" | "odds" | "bookmakers" | "odds_count">
    >,
  ) {
    if (!patches.length) return;
    const patch = new Map(patches.map((r) => [r.match_id, r] as const));
    setFixtures((prev) =>
      prev.map((f) => {
        const o = patch.get(f.match_id);
        return o
          ? {
              ...f,
              odds: o.odds,
              bookmakers: o.bookmakers,
              odds_count: o.odds_count ?? f.odds_count,
            }
          : f;
      }),
    );
  }

  async function loadOddsShards(meta: FixtureRow[]) {
    const ids = meta.map((f) => f.match_id);
    const shards = 8;
    const chunkSize = Math.ceil(ids.length / shards);
    const slices: string[][] = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      slices.push(ids.slice(i, i + chunkSize));
    }
    setOddsChunksTotal(slices.length);
    setOddsChunksDone(0);
    await Promise.all(
      slices.map(async (slice) => {
        const res = await fetch(
          `/api/fixtures?phase=odds&ids=${encodeURIComponent(slice.join(","))}`,
          { cache: "no-store" },
        );
        if (res.ok) {
          const j = (await res.json()) as {
            fixtures?: Array<
              Pick<FixtureRow, "match_id" | "odds" | "bookmakers" | "odds_count">
            >;
          };
          await applyOddsPatches(j.fixtures ?? []);
        }
        setOddsChunksDone((d) => d + 1);
      }),
    );
  }

  async function loadFixturesForDate(date: string) {
    setFixturesLoading(true);
    setOddsLoading(false);
    setOddsChunksDone(0);
    setOddsChunksTotal(0);
    setSelectedFixtureId(null);
    setError(undefined);
    try {
      const metaRes = await fetch(
        `/api/fixtures?phase=meta&date=${encodeURIComponent(date)}`,
        { cache: "no-store" },
      );
      const metaJson = (await metaRes.json()) as {
        fixtures?: FixtureRow[];
        error?: string;
      };
      if (!metaRes.ok) throw new Error(metaJson.error || metaRes.statusText);
      const meta = metaJson.fixtures ?? [];
      setFixtures(meta);
      setFixturesLoading(false);

      if (!meta.length) return;

      setOddsLoading(true);
      await loadOddsShards(meta);
    } catch (e) {
      setFixtures([]);
      setError(e instanceof Error ? e.message : String(e));
      setFixturesLoading(false);
      setOddsLoading(false);
    } finally {
      setOddsLoading(false);
    }
  }

  const syncUrl = useCallback(
    (next: OddsCriterion[], bm: string, tol: string, date: string) => {
      const sp = new URLSearchParams();
      for (const c of next) sp.append("c", encodeCriterion(c));
      if (bm) sp.set("bm", bm);
      if (tol !== "" && tol !== "0") sp.set("tol", tol);
      if (date) sp.set("date", date);
      const q = sp.toString();
      window.history.replaceState(null, "", q ? `${urlPath}?${q}` : urlPath);
    },
    [urlPath],
  );

  const runSearch = useCallback(
    async (nextCriteria: OddsCriterion[]) => {
      if (!nextCriteria.length) {
        setCriteria([]);
        setResult(null);
        setPinnedRows([]);
        setError(undefined);
        syncUrl([], bookmakerId, tolerance, bulletinDate);
        return;
      }

      setCriteria(nextCriteria);
      syncUrl(nextCriteria, bookmakerId, tolerance, bulletinDate);

      const resolved = resolveCriteriaFromFixture(nextCriteria, selectedFixture, bmNum);
      if (!resolved.length) {
        setResult(null);
        setError("Selected fixture has no odds for this market / bookmaker.");
        setPending(false);
        return;
      }

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setPending(true);
      setError(undefined);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            criteria: resolved,
            bookmakerId: bookmakerId || null,
            seasonSlugs: [],
            tolerance: Number.isFinite(Number(tolerance)) ? Number(tolerance) : 0,
            limit: 200,
          }),
          signal: ac.signal,
        });
        const json = (await res.json()) as ProfileSearchResult & {
          error?: string;
          ok?: boolean;
        };
        if (ac.signal.aborted) return;
        if (!res.ok) {
          setResult(null);
          setError(json.error || `HTTP ${res.status}`);
          return;
        }
        setResult(json);
      } catch (e) {
        if (ac.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        setResult(null);
        setError(
          /abort|cancel/i.test(msg)
            ? "Request cancelled."
            : `Network error: ${msg}. Try Search again.`,
        );
      } finally {
        if (!ac.signal.aborted) setPending(false);
      }
    },
    [bookmakerId, tolerance, bulletinDate, syncUrl, selectedFixture, bmNum],
  );

  useEffect(() => {
    if (!autoRun || !initialCriteria.length || ranRef.current) return;
    ranRef.current = true;
    void runSearch(initialCriteria);
  }, [autoRun, initialCriteria, runSearch]);

  // Smart mode: re-search when parent changes bookmaker or tolerance
  const settingsKey = `${controlledBookmakerId ?? ""}:${controlledTolerance ?? ""}`;
  const prevSettingsRef = useRef(settingsKey);
  useEffect(() => {
    if (controlledBookmakerId == null && controlledTolerance == null) return;
    if (prevSettingsRef.current === settingsKey) return;
    prevSettingsRef.current = settingsKey;
    if (criteria.length) void runSearch(criteria);
  }, [settingsKey, controlledBookmakerId, controlledTolerance, criteria, runSearch]);

  // Fixture her zaman client'tan (SSR odds JSONB timeout oluyordu)
  useEffect(() => {
    if (!bulletinDate) return;
    void loadFixturesForDate(bulletinDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulletinDate]);

  const [archiveWarm, setArchiveWarm] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    seasonsDone: number;
    seasonsTotal: number;
    quotes: number;
    error?: string;
    source?: string;
    duckdbError?: string;
  }>({
    status: "idle",
    seasonsDone: 0,
    seasonsTotal: 0,
    quotes: 0,
  });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function tick() {
      try {
        const res = await fetch("/api/analyze/warm?maxSeasons=24", { cache: "no-store" });
        const j = (await res.json()) as {
          status?: "idle" | "loading" | "ready" | "error";
          seasonsDone?: number;
          seasonsTotal?: number;
          quotes?: number;
          error?: string;
          source?: string;
          duckdbError?: string;
        };
        if (cancelled) return;
        setArchiveWarm({
          status: j.status ?? "idle",
          seasonsDone: j.seasonsDone ?? 0,
          seasonsTotal: j.seasonsTotal ?? 0,
          quotes: j.quotes ?? 0,
          error: j.error,
          source: j.source,
          duckdbError: j.duckdbError,
        });
        if (j.status === "ready" || j.status === "error") {
          if (timer) clearInterval(timer);
        }
      } catch {
        if (!cancelled) {
          setArchiveWarm((prev) => ({
            ...prev,
            status: "error",
            error: "Archive warm failed",
          }));
        }
      }
    }

    void tick();
    timer = setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Maç veya bookmaker değişince relative filtreleri yeniden çöz
  useEffect(() => {
    if (!criteria.some((c) => c.relative)) return;
    if (!criteria.length) return;
    void runSearch(criteria);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFixtureId, bookmakerId]);

  // Bookmaker değişince mutlak aramayı yenile
  const bmFirst = useRef(true);
  useEffect(() => {
    if (bmFirst.current) {
      bmFirst.current = false;
      return;
    }
    if (criteria.length && !criteria.some((c) => c.relative)) void runSearch(criteria);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmakerId]);

  function removeCriterion(idx: number) {
    const next = criteria.filter((_, i) => i !== idx);
    if (next.length) void runSearch(next);
    else {
      abortRef.current?.abort();
      setCriteria([]);
      setResult(null);
      setPinnedRows([]);
      setError(undefined);
      setPending(false);
      syncUrl([], bookmakerId, tolerance, bulletinDate);
    }
  }

  function addCriterion(next: OddsCriterion, sourceRow?: TableRow) {
    if (sourceRow) {
      setPinnedRows((prev) => {
        if (prev.some((r) => r.id === sourceRow.id)) return prev;
        return [sourceRow, ...prev].slice(0, 20);
      });
    }
    const key = marketSlotKey(next);
    const merged = criteria.some((p) => marketSlotKey(p) === key)
      ? criteria
      : [...criteria, next];
    setCriteria(merged);
    syncUrl(merged, bookmakerId, tolerance, bulletinDate);
    void runSearch(merged);
  }

  function pickMarketSlot(c: OddsCriterion) {
    const slot: OddsCriterion = {
      marketType: c.marketType,
      marketScope: c.marketScope,
      side: c.side,
      line: c.line ?? null,
      columnId: c.columnId,
      price: c.price,
      targetOdds: 0,
      relative: true,
    };
    const key = marketSlotKey(slot);
    const merged = criteria.filter((p) => marketSlotKey(p) !== key);
    merged.push(slot);
    if (selectedFixture) {
      setPinnedRows((prev) => {
        const row = fixtureToTableRow(selectedFixture, bmNum);
        if (prev.some((r) => r.id === row.id)) return prev;
        return [row, ...prev].slice(0, 20);
      });
    }
    setCriteria(merged);
    syncUrl(merged, bookmakerId, tolerance, bulletinDate);
    void runSearch(merged);
  }

  function clearAll() {
    abortRef.current?.abort();
    setCriteria([]);
    setResult(null);
    setPinnedRows([]);
    setError(undefined);
    setPending(false);
    syncUrl([], bookmakerId, tolerance, bulletinDate);
  }

  const archiveReady = archiveWarm.status === "ready";
  const archiveLabel =
    archiveWarm.status === "ready"
      ? `${archiveWarm.quotes.toLocaleString()} quotes`
      : archiveWarm.status === "loading"
        ? `${archiveWarm.seasonsDone}/${archiveWarm.seasonsTotal || "?"} seasons`
        : archiveWarm.status === "error"
          ? "error"
          : "warming…";

  const bmLabel =
    bookmakers.find((b) => String(b.id) === bookmakerId)?.name ||
    (bookmakerId ? `#${bookmakerId}` : "Any bookmaker");

  function pickCriterion(c: OddsCriterion) {
    pickMarketSlot(c);
  }

  return (
    <>
      <div className={styles.wrap}>
        <div className={styles.topBar}>
          <div className={styles.topBarRow}>
            <label className={styles.field}>
              <span>Day</span>
              <select
                value={bulletinDate}
                onChange={(e) => {
                  const d = e.target.value;
                  setBulletinDate(d);
                  void loadFixturesForDate(d);
                }}
                disabled={fixturesLoading}
              >
                {!fixtureDates.includes(bulletinDate) && bulletinDate ? (
                  <option value={bulletinDate}>{bulletinDate}</option>
                ) : null}
                {fixtureDates.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                {!fixtureDates.length ? (
                  <option value={bulletinDate}>{bulletinDate || "—"}</option>
                ) : null}
              </select>
            </label>
            {!hideBookmakerSelect ? (
              <label className={styles.field}>
                <span>Bookmaker</span>
                <select
                  value={bookmakerIdState}
                  onChange={(e) => setBookmakerIdState(e.target.value)}
                >
                  <option value="">Any</option>
                  {bookmakers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <FixtureMatchStrip
              fixtures={fixtures}
              selectedId={selectedFixtureId}
              bookmakerId={bmNum}
              loading={fixturesLoading}
              oddsLoading={oddsLoading}
              onSelect={setSelectedFixtureId}
            />

            <MarketFilterPanel
              fixture={selectedFixture}
              bookmakerId={bmNum}
              activeCriteria={criteria}
              onPick={pickCriterion}
            />

            <span
              className={`${styles.statusPill} ${archiveReady ? styles.statusOk : styles.statusPending}`}
              title={archiveWarm.error || undefined}
            >
              archive {archiveLabel}
              {archiveWarm.source === "ram-fallback" ? " (ram-fallback: duckdb devre dışı)" : ""}
            </span>
            {(criteria.length > 0 || result) && (
              <button type="button" className={styles.linkBtn} onClick={clearAll}>
                Reset filters
              </button>
            )}
          </div>

          {oddsLoading && (
            <p className={styles.stripHint}>
              Loading odds… {oddsChunksDone}/{oddsChunksTotal || "—"} chunks
            </p>
          )}
          {archiveWarm.source === "ram-fallback" && archiveWarm.duckdbError && (
            <p className={styles.stripHint} style={{ color: "#b45309" }}>
              DuckDB devre dışı, Postgres fallback kullanılıyor. Sebep: {archiveWarm.duckdbError}
            </p>
          )}
          {archiveWarm.status === "error" && archiveWarm.error && (
            <p className={styles.stripHint} style={{ color: "#b91c1c" }}>
              Archive build failed: {archiveWarm.error}
            </p>
          )}
        </div>

        <div className={styles.filterSection}>
          <p className={styles.filterSectionTitle}>Selected filters</p>
          {criteria.length > 0 ? (
            <div className={styles.chips}>
              {criteria.map((c, i) => (
                <button
                  key={`${marketSlotKey(c)}-${i}`}
                  type="button"
                  className={styles.chip}
                  onClick={() => removeCriterion(i)}
                  title="Remove"
                >
                  {criterionLabel(c)} ×
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.stripHint}>
              Pick a fixture, then a market from the listboxes — selections appear here.
            </p>
          )}
          {error && criteria.length > 0 && <p className={styles.hint}>{error}</p>}
        </div>

        {criteria.length > 0 && (
          <div className={styles.sectionBlock}>
            <div className={styles.tableHead}>
              <div>
                <h2 className={styles.sectionTitle}>Archive matches</h2>
                <p className={styles.tableLead}>
                  {bmLabel} · same odds profile across all seasons.
                </p>
              </div>
              <div className={styles.statusBar}>
                <span className={styles.statusPill}>
                  <strong>{archiveCount}</strong> archive
                  {pending ? " · searching…" : ""}
                </span>
              </div>
            </div>

            <AnalyzeTable
              mode="archive"
              rows={archiveDisplayRows}
              pending={pending}
              activeCriteria={resolvedCriteria}
              tolerance={tolSafe}
              pinnedRowIds={pinnedRowIds}
              compact
              onOddsClick={(c, _col, row) => addCriterion(c, row)}
              emptyHint={
                pending
                  ? "Searching archive…"
                  : "No archive matches for this profile."
              }
            />
          </div>
        )}

        {!criteria.length && error && <p className={styles.hint}>{error}</p>}
      </div>
    </>
  );
}

export function criteriaFromSearchParams(sp: {
  getAll: (k: string) => string[];
}): OddsCriterion[] {
  return sp
    .getAll("c")
    .map(decodeCriterion)
    .filter((x): x is OddsCriterion => x != null);
}
