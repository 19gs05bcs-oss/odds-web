"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ALL_COLUMNS,
  COLUMN_GROUPS,
  columnToCriterion,
  type ColumnGroupId,
  type MarketColumnDef,
} from "@/lib/analysis/tableColumns";
import { marketSlotKey, type OddsCriterion } from "@/lib/analysis/profile";
import { cellOddsValue, fixtureToTableRow } from "@/lib/analysis/tableRows";
import { formatOdds } from "@/lib/format";
import type { FixtureRow } from "@/lib/fixtures";
import styles from "./AnalyzeFilters.module.css";

const FILTER_GROUPS: ColumnGroupId[] = [
  "ms1x2",
  "ht1x2",
  "ou_ms",
  "ou_ht",
  "btts",
  "dc",
  "htft",
  "ah",
  "cs",
];

type MarketOption = {
  key: string;
  group: string;
  label: string;
  slot: OddsCriterion;
};

type Props = {
  fixture: FixtureRow | null;
  bookmakerId: number;
  activeCriteria: OddsCriterion[];
  onPick: (c: OddsCriterion) => void;
};

function isSlotActive(slot: OddsCriterion, active: OddsCriterion[]): boolean {
  const key = marketSlotKey(slot);
  return active.some((a) => marketSlotKey(a) === key);
}

export function MarketFilterPanel({
  fixture,
  bookmakerId,
  activeCriteria,
  onPick,
}: Props) {
  const [pick, setPick] = useState("");

  useEffect(() => {
    setPick("");
  }, [fixture?.match_id]);

  const options = useMemo((): MarketOption[] => {
    if (!fixture) return [];
    const row = fixtureToTableRow(fixture, bookmakerId);
    const cols = ALL_COLUMNS.filter(
      (c): c is MarketColumnDef =>
        c.kind === "market" &&
        FILTER_GROUPS.includes(c.group) &&
        (c.defaultOn || c.group === "cs"),
    );
    const byGroup = COLUMN_GROUPS.filter((g) => FILTER_GROUPS.includes(g.id));
    const out: MarketOption[] = [];

    for (const g of byGroup) {
      for (const col of cols.filter((c) => c.group === g.id)) {
        const cell = row.odds[col.id];
        const open = cell?.opening ?? null;
        const close = cell?.closing ?? cellOddsValue(cell);
        for (const [price, val] of [
          ["opening", open] as const,
          ["closing", close] as const,
        ]) {
          if (val == null) continue;
          const oc = price === "opening" ? "O" : "C";
          const crit = columnToCriterion(col, val, price);
          const slot: OddsCriterion = {
            marketType: crit.marketType,
            marketScope: crit.marketScope,
            side: crit.side,
            line: crit.line ?? null,
            columnId: crit.columnId,
            price: crit.price,
            targetOdds: 0,
            relative: true,
          };
          out.push({
            key: `${col.id}-${price}`,
            group: g.label,
            label: `${col.header} · ${oc} · ${formatOdds(val)}`,
            slot,
          });
        }
      }
    }
    return out;
  }, [fixture, bookmakerId]);

  const groups = useMemo(() => {
    const map = new Map<string, MarketOption[]>();
    for (const o of options) {
      const arr = map.get(o.group) ?? [];
      arr.push(o);
      map.set(o.group, arr);
    }
    return [...map.entries()];
  }, [options]);

  const disabled = !fixture || !options.length;

  return (
    <label className={`${styles.field} ${styles.fieldGrow}`}>
      <span>Market</span>
      <select
        value={pick}
        disabled={disabled}
        onChange={(e) => {
          const key = e.target.value;
          if (!key) return;
          const opt = options.find((o) => o.key === key);
          if (opt) onPick(opt.slot);
          setPick("");
        }}
      >
        <option value="">
          {!fixture
            ? "Select fixture first…"
            : !options.length
              ? "No odds for this bookmaker"
              : "Add market filter…"}
        </option>
        {groups.map(([group, items]) => (
          <optgroup key={group} label={group}>
            {items.map((opt) => {
              const on = isSlotActive(opt.slot, activeCriteria);
              return (
                <option key={opt.key} value={opt.key}>
                  {on ? "✓ " : ""}
                  {opt.label}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
