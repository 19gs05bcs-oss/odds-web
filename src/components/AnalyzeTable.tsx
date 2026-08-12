"use client";

import { Fragment, useMemo, useState } from "react";
import {
  ALL_COLUMNS,
  COLUMN_GROUPS,
  columnToCriterion,
  criterionMatchesColumn,
  defaultVisibleGroupIds,
  visibleColumns,
  type ColumnGroupId,
  type MarketColumnDef,
  type MetaColumnDef,
  type MetaField,
} from "@/lib/analysis/tableColumns";
import {
  cellMatchesCriterion,
  cellOddsValue,
  filterTableRows,
  type TableRow,
} from "@/lib/analysis/tableRows";
import type { OddsCriterion } from "@/lib/analysis/profile";
import { formatOdds } from "@/lib/format";
import styles from "./AnalyzeTable.module.css";

type Props = {
  rows: TableRow[];
  mode: "bulletin" | "archive" | "merged";
  pending?: boolean;
  emptyHint?: string;
  onOddsClick?: (criterion: OddsCriterion, col: MarketColumnDef, row: TableRow) => void;
  activeCriteria?: OddsCriterion[];
  tolerance?: number;
  pinnedRowIds?: Set<string>;
  compact?: boolean;
  /** Override default visible market groups (e.g. demo shows Correct Score). */
  initialGroupIds?: ColumnGroupId[];
};

function isActiveCol(
  col: MarketColumnDef,
  criteria: OddsCriterion[] | undefined,
  priceLabel?: "open" | "close",
): boolean {
  if (!criteria?.length) return false;
  return criteria.some((c) => {
    if (!criterionMatchesColumn(c, col)) return false;
    if (!priceLabel || !c.price) return true;
    return (
      (c.price === "opening" && priceLabel === "open") ||
      (c.price === "closing" && priceLabel === "close")
    );
  });
}

function cellClasses(
  col: MarketColumnDef,
  cell: { opening: number | null; closing: number | null } | null | undefined,
  label: "open" | "close",
  row: TableRow,
  activeCriteria: OddsCriterion[] | undefined,
  tolerance: number,
  pinnedRowIds: Set<string> | undefined,
): string[] {
  const parts: string[] = [styles.num];
  const oc = row.outcome[col.id];
  if (oc === "hit") parts.push(styles.outcomeWin);
  else if (oc === "miss") parts.push(styles.outcomeLose);

  if (activeCriteria?.length) {
    const matched = activeCriteria.some((c) =>
      cellMatchesCriterion(col, cell, c, tolerance, label),
    );
    if (matched) {
      parts.push(pinnedRowIds?.has(row.id) ? styles.activeCellStrong : styles.activeCell);
    }
  }
  return parts;
}

const OPTIONAL_META: { id: MetaField; label: string }[] = [
  { id: "yil", label: "YEAR" },
  { id: "ay", label: "MONTH" },
  { id: "gun", label: "DAY" },
  { id: "gunAdi", label: "WEEKDAY" },
  { id: "altLig", label: "DIVISION" },
];

function metaCellClass(id: string, sticky: boolean): string | undefined {
  const parts: string[] = [];
  if (sticky) parts.push(styles.stickySrc);
  if (id === "tarih") parts.push(styles.colDate);
  if (id === "saat") parts.push(styles.colTime);
  if (id === "ev") parts.push(styles.colHome);
  if (id === "dep") parts.push(styles.colAway);
  if (id === "lig" || id === "altLig") parts.push(styles.colLeague);
  if (id === "skor" || id === "skor1y") parts.push(styles.colScore);
  return parts.length ? parts.join(" ") : undefined;
}

export function AnalyzeTable({
  rows,
  mode,
  pending,
  emptyHint,
  onOddsClick,
  activeCriteria,
  tolerance = 0,
  pinnedRowIds,
  compact = false,
  initialGroupIds,
}: Props) {
  const [groups, setGroups] = useState<Set<ColumnGroupId>>(
    () => new Set(initialGroupIds ?? defaultVisibleGroupIds()),
  );
  const [extraMeta, setExtraMeta] = useState<Set<MetaField>>(() => new Set());
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editOpen, setEditOpen] = useState(false);

  const columns = useMemo(() => {
    const base = visibleColumns(groups);
    if (!extraMeta.size) return base;
    const metaExtras = ALL_COLUMNS.filter(
      (c): c is MetaColumnDef => c.kind === "meta" && extraMeta.has(c.id),
    );
    // Insert optional meta after DATE (index of tarih), before TIME.
    const out = [...base];
    const afterDate = out.findIndex((c) => c.kind === "meta" && c.id === "tarih");
    const insertAt = afterDate >= 0 ? afterDate + 1 : 0;
    const existing = new Set(out.map((c) => c.id));
    const toAdd = metaExtras.filter((c) => !existing.has(c.id));
    if (toAdd.length) out.splice(insertAt, 0, ...toAdd);
    return out;
  }, [groups, extraMeta]);

  const filtered = useMemo(
    () => filterTableRows(rows, filters, columns),
    [rows, filters, columns],
  );

  const metaCols = columns.filter((c): c is MetaColumnDef => c.kind === "meta");
  const marketCols = columns.filter((c): c is MarketColumnDef => c.kind === "market");

  const stickySrcId = metaCols[0]?.id;

  function toggleGroup(id: ColumnGroupId) {
    if (id === "meta") return;
    setGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      next.add("meta");
      return next;
    });
  }

  function toggleExtraMeta(id: MetaField) {
    setExtraMeta((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function resetTable() {
    setGroups(defaultVisibleGroupIds());
    setExtraMeta(new Set());
    setFilters({});
  }

  return (
    <div className={compact ? styles.compact : undefined}>
      {!compact ? (
        <div className={styles.toolbar}>
          <button type="button" className={styles.btnEdit} onClick={() => setEditOpen((v) => !v)}>
            Edit columns
          </button>
          <button type="button" className={styles.btnReset} onClick={resetTable}>
            Reset columns
          </button>
        </div>
      ) : null}

      {editOpen && (
        <div className={styles.drawer}>
          <div className={styles.drawerBlock}>
            <span className={styles.drawerLabel}>Markets</span>
            {COLUMN_GROUPS.filter((g) => g.id !== "meta").map((g) => (
              <label key={g.id}>
                <input
                  type="checkbox"
                  checked={groups.has(g.id)}
                  onChange={() => toggleGroup(g.id)}
                />
                {g.label}
              </label>
            ))}
          </div>
          <div className={styles.drawerBlock}>
            <span className={styles.drawerLabel}>Date parts</span>
            {OPTIONAL_META.map((m) => (
              <label key={m.id}>
                <input
                  type="checkbox"
                  checked={extraMeta.has(m.id)}
                  onChange={() => toggleExtraMeta(m.id)}
                />
                {m.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {!compact ? (
        <p className={styles.meta}>
          {mode === "merged"
            ? "fixture + archive"
            : mode === "bulletin"
              ? "fixture"
              : "archive"}{" "}
          · {filtered.length}/{rows.length} rows
          {pending ? " · loading…" : ""}
          {" · O (open) | C (close) — green won · red lost · teal = active filter"}
        </p>
      ) : null}

      <div className={compact ? styles.scrollCompact : styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {metaCols.map((c) => (
                <th key={c.id} className={metaCellClass(c.id, c.id === stickySrcId)}>
                  {c.header}
                </th>
              ))}
              {marketCols.map((c) => {
                const activeOpen = isActiveCol(c, activeCriteria, "open");
                const activeClose = isActiveCol(c, activeCriteria, "close");
                return (
                  <Fragment key={c.id}>
                    <th className={`${styles.oddsHead} ${activeOpen ? styles.activeCol : ""}`}>
                      {c.header}
                      <span className={styles.ocTag}>O</span>
                    </th>
                    <th className={`${styles.oddsHead} ${activeClose ? styles.activeCol : ""}`}>
                      {c.header}
                      <span className={styles.ocTag}>C</span>
                    </th>
                  </Fragment>
                );
              })}
            </tr>
            <tr className={styles.filterRow}>
              {metaCols.map((c) => (
                <th key={`f-${c.id}`} className={metaCellClass(c.id, c.id === stickySrcId)}>
                  <input
                    className={styles.filterInput}
                    value={filters[c.id] || ""}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, [c.id]: e.target.value }))
                    }
                    aria-label={`${c.header} filter`}
                  />
                </th>
              ))}
              {marketCols.map((c) => (
                <Fragment key={`f-${c.id}`}>
                  <th>
                    <input
                      className={styles.filterInput}
                      value={filters[`${c.id}__o`] || ""}
                      onChange={(e) =>
                        setFilters((prev) => ({ ...prev, [`${c.id}__o`]: e.target.value }))
                      }
                      aria-label={`${c.header} open filter`}
                      placeholder="O"
                    />
                  </th>
                  <th>
                    <input
                      className={styles.filterInput}
                      value={filters[`${c.id}__c`] || ""}
                      onChange={(e) =>
                        setFilters((prev) => ({ ...prev, [`${c.id}__c`]: e.target.value }))
                      }
                      aria-label={`${c.header} close filter`}
                      placeholder="C"
                    />
                  </th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {pending && !filtered.length ? (
              <tr>
                <td
                  colSpan={metaCols.length + marketCols.length * 2}
                  className={styles.empty}
                >
                  Loading…
                </td>
              </tr>
            ) : null}
            {!pending && !filtered.length ? (
              <tr>
                <td
                  colSpan={metaCols.length + marketCols.length * 2}
                  className={styles.empty}
                >
                  {emptyHint || "No rows."}
                </td>
              </tr>
            ) : null}
            {filtered.map((row) => (
              <tr
                key={row.id}
                className={row.source === "fixture" ? styles.rowFixture : styles.rowArchive}
              >
                {metaCols.map((c) => (
                  <td key={c.id} className={metaCellClass(c.id, c.id === stickySrcId)}>
                    {row.meta[c.id]}
                  </td>
                ))}
                {marketCols.map((c) => {
                  const cell = row.odds[c.id];
                  const open = cell?.opening ?? null;
                  const close = cell?.closing ?? cellOddsValue(cell);

                  const renderOddsCell = (val: number | null, label: "open" | "close") => (
                    <td
                      key={`${c.id}-${label}`}
                      className={cellClasses(
                        c,
                        cell,
                        label,
                        row,
                        activeCriteria,
                        tolerance,
                        pinnedRowIds,
                      ).join(" ")}
                    >
                      {val != null ? (
                        <button
                          type="button"
                          className={styles.oddsBtn}
                          disabled={pending || !onOddsClick}
                          title={`Click to filter by ${label} ${formatOdds(val)}`}
                          onClick={() =>
                            onOddsClick?.(
                              columnToCriterion(
                                c,
                                val,
                                label === "open" ? "opening" : "closing",
                              ),
                              c,
                              row,
                            )
                          }
                        >
                          {formatOdds(val)}
                        </button>
                      ) : (
                        <span className={styles.emptyOdds}>—</span>
                      )}
                    </td>
                  );

                  return (
                    <Fragment key={c.id}>
                      {renderOddsCell(open, "open")}
                      {renderOddsCell(close, "close")}
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
