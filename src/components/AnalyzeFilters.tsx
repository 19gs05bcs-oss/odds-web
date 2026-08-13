"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import type { BookmakerOption } from "@/lib/types";
import {
  criterionLabel,
  decodeCriterion,
  encodeCriterion,
  type OddsCriterion,
} from "@/lib/analysis/profile";
import type { SeasonRow } from "@/lib/types";
import styles from "./AnalyzeFilters.module.css";

type Props = {
  seasons: SeasonRow[];
  bookmakers: BookmakerOption[];
};

export function AnalyzeFilters({ seasons, bookmakers }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  const initialCriteria = useMemo(
    () =>
      sp
        .getAll("c")
        .map(decodeCriterion)
        .filter((x): x is OddsCriterion => x != null),
    [sp],
  );

  const [homeOdds, setHomeOdds] = useState("6.25");
  const [drawOdds, setDrawOdds] = useState("4.33");
  const [awayOdds, setAwayOdds] = useState("1.44");
  const [criteria, setCriteria] = useState<OddsCriterion[]>(initialCriteria);
  const [bookmakerId, setBookmakerId] = useState(sp.get("bookmaker") || "");
  const [seasonSlug, setSeasonSlug] = useState(sp.get("seasonSlug") || "");
  const [tolerance, setTolerance] = useState(sp.get("tol") || "0.08");

  const [extraMarket, setExtraMarket] = useState("OVER_UNDER");
  const [extraSide, setExtraSide] = useState("OVER");
  const [extraLine, setExtraLine] = useState("2.5");
  const [extraOdds, setExtraOdds] = useState("");

  function removeCriterion(idx: number) {
    setCriteria((prev) => prev.filter((_, i) => i !== idx));
  }

  function runSearch(nextCriteria: OddsCriterion[]) {
    if (!nextCriteria.length) return;
    const params = new URLSearchParams();
    params.set("run", "1");
    for (const c of nextCriteria) params.append("c", encodeCriterion(c));
    if (bookmakerId) params.set("bookmaker", bookmakerId);
    if (seasonSlug) params.set("seasonSlug", seasonSlug);
    if (tolerance) params.set("tol", tolerance);
    params.set("limit", "200");
    startTransition(() => {
      router.push(`/analyze?${params.toString()}`, { scroll: false });
    });
  }

  function click1x2(side: "H" | "D" | "A", raw: string) {
    const targetOdds = Number(raw.replace(",", "."));
    if (!Number.isFinite(targetOdds) || targetOdds <= 1) return;
    const next: OddsCriterion = {
      marketType: "HOME_DRAW_AWAY",
      marketScope: "FULL_TIME",
      side,
      targetOdds,
    };
    const key = encodeCriterion(next);
    const merged = criteria.some((p) => encodeCriterion(p) === key)
      ? criteria
      : [...criteria, next];
    setCriteria(merged);
    runSearch(merged);
  }

  function addExtra(e?: FormEvent) {
    e?.preventDefault();
    const targetOdds = Number(extraOdds.replace(",", "."));
    if (!Number.isFinite(targetOdds) || targetOdds <= 1) return;
    const next: OddsCriterion = {
      marketType: extraMarket,
      marketScope: "FULL_TIME",
      side: extraSide,
      line: extraMarket === "OVER_UNDER" ? extraLine : null,
      targetOdds,
    };
    const key = encodeCriterion(next);
    const merged = criteria.some((p) => encodeCriterion(p) === key)
      ? criteria
      : [...criteria, next];
    setCriteria(merged);
    setExtraOdds("");
    runSearch(merged);
  }

  function search(e?: FormEvent) {
    e?.preventDefault();
    runSearch(criteria);
  }

  return (
    <div className={styles.wrap}>
      <section className={styles.bulletin}>
        <h2 className={styles.sectionTitle}>Gece bülteni · 1X2</h2>
        <p className={styles.hint}>
          Oranı yazıp kutuya tıkla — tüm liglerde o seçimi (~oran) listeler.
          Sonra X / Over ekleyerek daralt.
        </p>
        <div className={styles.oddsRow}>
          <button
            type="button"
            className={styles.oddsChip}
            onClick={() => click1x2("H", homeOdds)}
            title="Ev 1 ekle"
          >
            <span className={styles.oddsLabel}>1</span>
            <input
              value={homeOdds}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setHomeOdds(e.target.value)}
              inputMode="decimal"
            />
          </button>
          <button
            type="button"
            className={styles.oddsChip}
            onClick={() => click1x2("D", drawOdds)}
            title="X ekle"
          >
            <span className={styles.oddsLabel}>X</span>
            <input
              value={drawOdds}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDrawOdds(e.target.value)}
              inputMode="decimal"
            />
          </button>
          <button
            type="button"
            className={styles.oddsChip}
            onClick={() => click1x2("A", awayOdds)}
            title="Dep 2 ekle"
          >
            <span className={styles.oddsLabel}>2</span>
            <input
              value={awayOdds}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setAwayOdds(e.target.value)}
              inputMode="decimal"
            />
          </button>
        </div>
      </section>

      <section className={styles.extra}>
        <h2 className={styles.sectionTitle}>Market ekle</h2>
        <div className={styles.extraRow}>
          <select value={extraMarket} onChange={(e) => setExtraMarket(e.target.value)}>
            <option value="OVER_UNDER">Over/Under</option>
            <option value="BOTH_TEAMS_TO_SCORE">BTTS</option>
            <option value="DOUBLE_CHANCE">Double Chance</option>
            <option value="DRAW_NO_BET">Draw No Bet</option>
            <option value="HOME_DRAW_AWAY">1X2</option>
            <option value="ASIAN_HANDICAP">Asian Handicap</option>
            <option value="HALF_FULL_TIME">HT/FT</option>
            <option value="ODD_OR_EVEN">Odd/Even</option>
            <option value="CORRECT_SCORE">Correct Score</option>
            <option value="EUROPEAN_HANDICAP">European Handicap</option>
          </select>
          {extraMarket === "OVER_UNDER" ? (
            <>
              <select value={extraSide} onChange={(e) => setExtraSide(e.target.value)}>
                <option value="OVER">Üst</option>
                <option value="UNDER">Alt</option>
              </select>
              <input
                value={extraLine}
                onChange={(e) => setExtraLine(e.target.value)}
                placeholder="2.5"
                aria-label="Line"
              />
            </>
          ) : extraMarket === "BOTH_TEAMS_TO_SCORE" ? (
            <select value={extraSide} onChange={(e) => setExtraSide(e.target.value)}>
              <option value="btts:YES">Var</option>
              <option value="btts:NO">Yok</option>
            </select>
          ) : extraMarket === "DOUBLE_CHANCE" ? (
            <select value={extraSide} onChange={(e) => setExtraSide(e.target.value)}>
              <option value="DC:1X">1X</option>
              <option value="DC:12">12</option>
              <option value="DC:X2">X2</option>
            </select>
          ) : extraMarket === "HOME_DRAW_AWAY" || extraMarket === "DRAW_NO_BET" ? (
            <select value={extraSide} onChange={(e) => setExtraSide(e.target.value)}>
              <option value="H">1</option>
              <option value="D">X</option>
              <option value="A">2</option>
            </select>
          ) : (
            <input
              value={extraSide}
              onChange={(e) => setExtraSide(e.target.value)}
              placeholder="side key"
            />
          )}
          <input
            value={extraOdds}
            onChange={(e) => setExtraOdds(e.target.value)}
            placeholder="oran"
            inputMode="decimal"
          />
          <button type="button" className={styles.secondary} onClick={addExtra}>
            Ekle
          </button>
        </div>
      </section>

      {criteria.length > 0 && (
        <div className={styles.chips}>
          {criteria.map((c, i) => (
            <button
              key={`${encodeCriterion(c)}-${i}`}
              type="button"
              className={styles.chip}
              onClick={() => removeCriterion(i)}
              title="Kaldır"
            >
              {criterionLabel(c)} ×
            </button>
          ))}
        </div>
      )}

      <form className={styles.controls} onSubmit={search}>
        <label className={styles.field}>
          <span>Bookmaker</span>
          <select value={bookmakerId} onChange={(e) => setBookmakerId(e.target.value)}>
            <option value="">Tümü</option>
            {bookmakers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Sezon / lig</span>
          <select value={seasonSlug} onChange={(e) => setSeasonSlug(e.target.value)}>
            <option value="">Tüm sezonlar</option>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.competition || s.id}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>± tolerans</span>
          <input
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.apply}
            disabled={pending || criteria.length === 0}
          >
            {pending ? "Aranıyor…" : "Ara"}
          </button>
          {criteria.length > 0 && (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => setCriteria([])}
            >
              Chip’leri temizle
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
