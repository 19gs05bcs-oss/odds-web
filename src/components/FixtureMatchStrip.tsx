"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FixtureRow } from "@/lib/fixtures";
import { clockInTz } from "@/lib/time";
import filterStyles from "./AnalyzeFilters.module.css";
import styles from "./FixtureMatchStrip.module.css";

type Props = {
  fixtures: FixtureRow[];
  selectedId: string | null;
  bookmakerId: number;
  loading?: boolean;
  oddsLoading?: boolean;
  /** Oran şartı arama (ör. hentbol: maç yalnızca match_id ile R2'de aranır). */
  ignoreOdds?: boolean;
  onSelect: (matchId: string) => void;
};

function hasBmOdds(f: FixtureRow, bmId: number): boolean {
  if (!Array.isArray(f.odds)) return false;
  return f.odds.some((row) => Array.isArray(row) && Number(row[0]) === bmId);
}

function kickoffLabel(iso: string | null | undefined): string {
  return clockInTz(iso);
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
  ignoreOdds,
  onSelect,
}: Props) {
  const withOdds = ignoreOdds ? fixtures : fixtures.filter((f) => hasBmOdds(f, bookmakerId));
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
    // Arama metni değiştiğinde (yeni filtreleme) en üstteki sonucu vurgula.
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    // Liste açılırken (yazı yazılmadan) seçili maç neredeyse orada vurgulu
    // başlasın — en başa dönmesin.
    if (!open) return;
    const idx = list.findIndex((f) => f.match_id === selectedId);
    setHighlight(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

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
    const ready = ignoreOdds || hasBmOdds(f, bookmakerId);
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
        <ul className={styles.dropdown} role="listbox" ref={listRef}>
          {filtered.map((f, i) => {
            const ready = ignoreOdds || hasBmOdds(f, bookmakerId);
            const isSelected = f.match_id === selectedId;
            return (
              <li
                key={f.match_id}
                data-idx={i}
                role="option"
                aria-selected={isSelected}
                className={`${styles.option} ${i === highlight ? styles.optionActive : ""} ${
                  isSelected ? styles.optionSelected : ""
                } ${!ready && !oddsLoading ? styles.optionDisabled : ""}`}
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
