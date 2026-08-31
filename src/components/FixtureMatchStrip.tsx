"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FixtureRow } from "@/lib/fixtures";
import filterStyles from "./AnalyzeFilters.module.css";
import styles from "./FixtureMatchStrip.module.css";

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

function matchLabel(f: FixtureRow): string {
  const time = kickoffLabel(f.kickoff_at);
  const teams = `${f.home_name || "?"} – ${f.away_name || "?"}`;
  const label = `${time ? `${time} · ` : ""}${teams}`;
  return f.league ? `${label} (${f.league})` : label;
}

/**
 * Takım adına göre aranabilir maç seçici. Uzun bültenlerde native <select>
 * ile kaydırıp bulmak yerine, kullanıcı ev/deplasman/lig adının bir kısmını
 * yazınca eşleşen maçlar açılır listede filtrelenir.
 */
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

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => list.find((f) => f.match_id === selectedId) ?? null,
    [list, selectedId],
  );

  // Seçili maç değişince (ör. dışarıdan) input alanına etiketini yaz —
  // ama kullanıcı o an arama kutusuyla uğraşıyorsa (dropdown açık) üzerine yazma.
  useEffect(() => {
    if (!open) setQuery(selected ? matchLabel(selected) : "");
  }, [selected, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((f) => {
      const home = (f.home_name || "").toLowerCase();
      const away = (f.away_name || "").toLowerCase();
      const league = (f.league || "").toLowerCase();
      return home.includes(q) || away.includes(q) || league.includes(q);
    });
  }, [list, query]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function pick(f: FixtureRow) {
    const ready = hasBmOdds(f, bookmakerId);
    if (!ready && !oddsLoading) return;
    onSelect(f.match_id);
    setQuery(matchLabel(f));
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = filtered[highlight];
      if (f) pick(f);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery(selected ? matchLabel(selected) : "");
    }
  }

  return (
    <div
      className={`${filterStyles.field} ${filterStyles.fieldGrow} ${styles.combo}`}
      ref={rootRef}
    >
      <span>
        Fixture
        {!loading && list.length > 0 ? (
          <span className={filterStyles.fieldMeta}>
            {oddsLoading ? `${withOdds.length}/${fixtures.length}` : withOdds.length}
          </span>
        ) : null}
      </span>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={query}
        placeholder={loading ? "Loading…" : "Search team…"}
        disabled={loading || !list.length}
        onFocus={() => {
          // Odaklanınca arama kutusunu boşalt: seçili maçın uzun etiketi
          // (saat · takım · lig) query olarak kalırsa filtre hiçbir şeyle
          // eşleşmeyip liste boş görünüyordu — kapanınca zaten seçili maça
          // geri dönüyor (bkz. yukarıdaki useEffect).
          setQuery("");
          setOpen(true);
        }}
        onClick={() => {
          // Input zaten focus'luyken (bir maç seçtikten hemen sonra) tekrar
          // tıklayınca native focus event tekrar tetiklenmiyor — bu yüzden
          // click'te de aynı reset'i yapıyoruz.
          if (!open) {
            setQuery("");
            setOpen(true);
          }
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && !loading && filtered.length ? (
        <ul className={styles.dropdown} role="listbox">
          {filtered.map((f, i) => {
            const ready = hasBmOdds(f, bookmakerId);
            return (
              <li
                key={f.match_id}
                role="option"
                aria-selected={f.match_id === selectedId}
                className={`${styles.option} ${i === highlight ? styles.optionActive : ""} ${
                  !ready && !oddsLoading ? styles.optionDisabled : ""
                }`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(f);
                }}
              >
                {matchLabel(f)}
              </li>
            );
          })}
        </ul>
      ) : null}
      {open && !loading && !filtered.length ? (
        <ul className={styles.dropdown}>
          <li className={styles.optionEmpty}>No match found</li>
        </ul>
      ) : null}
    </div>
  );
}
