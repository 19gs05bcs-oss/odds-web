"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { AnalyzeTable } from "@/components/AnalyzeTable";
import { MarketFilterPanel } from "@/components/MarketFilterPanel";
import filterStyles from "@/components/AnalyzeFilters.module.css";
import { COLUMN_GROUPS, type ColumnGroupId } from "@/lib/analysis/tableColumns";
import {
  criterionLabel,
  marketSlotKey,
  type OddsCriterion,
} from "@/lib/analysis/profile";
import {
  fixtureToTableRow,
  resolveCriteriaFromFixture,
  tableRowMatchesCriteria,
  type TableRow,
} from "@/lib/analysis/tableRows";
import {
  DEMO_ARCHIVE,
  DEMO_BOOKMAKER_ID,
  DEMO_BOOKMAKER_NAME,
  DEMO_BULLETIN,
} from "@/lib/demo/fixtures";
import styles from "./ProductDemo.module.css";

const DEMO_GROUPS: ColumnGroupId[] = COLUMN_GROUPS.map((g) => g.id);

export function ProductDemo() {
  const [selectedFixtureId, setSelectedFixtureId] = useState(DEMO_BULLETIN[0].match_id);
  const [criteria, setCriteria] = useState<OddsCriterion[]>([]);
  const [pinnedRows, setPinnedRows] = useState<TableRow[]>([]);
  const [pending, setPending] = useState(false);

  const selectedFixture =
    DEMO_BULLETIN.find((f) => f.match_id === selectedFixtureId) ?? DEMO_BULLETIN[0];

  const resolvedCriteria = useMemo(
    () => resolveCriteriaFromFixture(criteria, selectedFixture, DEMO_BOOKMAKER_ID),
    [criteria, selectedFixture],
  );

  const archiveTableRows = useMemo(() => {
    return DEMO_ARCHIVE.map((f) => fixtureToTableRow(f, DEMO_BOOKMAKER_ID));
  }, []);

  const filteredArchive = useMemo(() => {
    if (!resolvedCriteria.length) return [];
    return archiveTableRows.filter((r) =>
      tableRowMatchesCriteria(r, resolvedCriteria, 0),
    );
  }, [archiveTableRows, resolvedCriteria]);

  const archiveDisplayRows = useMemo(() => {
    if (!pinnedRows.length) return filteredArchive;
    const seen = new Set(filteredArchive.map((r) => r.id));
    const extra = pinnedRows.filter((r) => r.id && !seen.has(r.id));
    return extra.length ? [...extra, ...filteredArchive] : filteredArchive;
  }, [filteredArchive, pinnedRows]);

  const pinnedRowIds = useMemo(
    () => new Set(pinnedRows.map((r) => r.id).filter(Boolean)),
    [pinnedRows],
  );

  const runFakeSearch = useCallback((next: OddsCriterion[]) => {
    if (!next.length) return;
    setPending(true);
    window.setTimeout(() => setPending(false), 280);
  }, []);

  function removeCriterion(idx: number) {
    const next = criteria.filter((_, i) => i !== idx);
    setCriteria(next);
    if (next.length) runFakeSearch(next);
    else {
      setPinnedRows([]);
      setPending(false);
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
    runFakeSearch(merged);
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
        const row = fixtureToTableRow(selectedFixture, DEMO_BOOKMAKER_ID);
        if (prev.some((r) => r.id === row.id)) return prev;
        return [row, ...prev].slice(0, 20);
      });
    }
    setCriteria(merged);
    runFakeSearch(merged);
  }

  function clearAll() {
    setCriteria([]);
    setPinnedRows([]);
    setPending(false);
  }

  return (
    <section id="demo" className={styles.section}>
      <div className="shell">
        <div className={styles.head}>
          <span className={styles.kicker}>Interactive demo</span>
          <h2 className={styles.title}>Same table as analyze — sample data only</h2>
          <p className={styles.lead}>
            Full market grid including Correct Score, HT/FT, Asian Handicap, and O/U. Fictional
            teams and odds — no API, no real archive.
          </p>
          <div className={styles.badgeRow}>
            <span className={styles.badge}>Not real odds</span>
            <span className={styles.badge}>No API calls</span>
            <span className={styles.badge}>All markets · incl. CS</span>
          </div>
        </div>

        <div className={styles.panel}>
          <div className={filterStyles.wrap}>
            <div className={filterStyles.topBar}>
              <div className={filterStyles.topBarRow}>
                <label className={filterStyles.field}>
                  <span>Day</span>
                  <select defaultValue="demo" disabled>
                    <option value="demo">Demo day</option>
                  </select>
                </label>
                <label className={filterStyles.field}>
                  <span>Bookmaker</span>
                  <select defaultValue={String(DEMO_BOOKMAKER_ID)} disabled>
                    <option value={String(DEMO_BOOKMAKER_ID)}>{DEMO_BOOKMAKER_NAME}</option>
                  </select>
                </label>
                <label className={`${filterStyles.field} ${filterStyles.fieldGrow}`}>
                  <span>Fixture</span>
                  <select
                    value={selectedFixtureId}
                    onChange={(e) => {
                      setSelectedFixtureId(e.target.value);
                    }}
                  >
                    {DEMO_BULLETIN.map((f) => (
                      <option key={f.match_id} value={f.match_id}>
                        {f.kickoff_at?.slice(11, 16) ?? "—"} · {f.home_name} – {f.away_name}
                      </option>
                    ))}
                  </select>
                </label>
                <MarketFilterPanel
                  fixture={selectedFixture}
                  bookmakerId={DEMO_BOOKMAKER_ID}
                  activeCriteria={criteria}
                  onPick={pickMarketSlot}
                />
                <span className={`${filterStyles.statusPill} ${filterStyles.statusOk}`}>
                  archive sample
                </span>
                {criteria.length > 0 ? (
                  <button type="button" className={filterStyles.linkBtn} onClick={clearAll}>
                    Reset filters
                  </button>
                ) : null}
              </div>
            </div>

            <div className={filterStyles.filterSection}>
              <p className={filterStyles.filterSectionTitle}>Selected filters</p>
              {criteria.length > 0 ? (
                <div className={filterStyles.chips}>
                  {criteria.map((c, i) => (
                    <button
                      key={`${marketSlotKey(c)}-${i}`}
                      type="button"
                      className={filterStyles.chip}
                      onClick={() => removeCriterion(i)}
                      title="Remove"
                    >
                      {criterionLabel(c)} ×
                    </button>
                  ))}
                </div>
              ) : (
                <p className={filterStyles.stripHint}>
                  Pick a fixture, then a market — MS, HT, O/U, BTTS, DC, HT/FT, AH, or Correct
                  Score (1:0, 2:1, …).
                </p>
              )}
            </div>

            {criteria.length > 0 ? (
              <div className={filterStyles.sectionBlock}>
                <div className={filterStyles.tableHead}>
                  <div>
                    <h2 className={filterStyles.sectionTitle}>Archive matches</h2>
                    <p className={filterStyles.tableLead}>
                      {DEMO_BOOKMAKER_NAME} · sample historical rows (same odds profile).
                    </p>
                  </div>
                  <div className={filterStyles.statusBar}>
                    <span className={filterStyles.statusPill}>
                      <strong>{archiveDisplayRows.length}</strong> archive
                      {pending ? " · searching…" : ""}
                    </span>
                  </div>
                </div>

                <AnalyzeTable
                  mode="archive"
                  rows={archiveDisplayRows}
                  pending={pending}
                  activeCriteria={resolvedCriteria}
                  tolerance={0}
                  pinnedRowIds={pinnedRowIds}
                  initialGroupIds={DEMO_GROUPS}
                  compact
                  onOddsClick={(c, _col, row) => addCriterion(c, row)}
                  emptyHint={
                    pending
                      ? "Searching sample archive…"
                      : "No sample rows for this profile — try another market."
                  }
                />
              </div>
            ) : null}
          </div>
        </div>

        <p className={styles.footerNote}>
          Ready for real data?{" "}
          <Link href="#pricing" className={styles.link}>
            See plans
          </Link>{" "}
          — paid access only, no trial.
        </p>
      </div>
    </section>
  );
}
