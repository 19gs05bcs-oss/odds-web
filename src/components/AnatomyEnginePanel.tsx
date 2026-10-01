import type { AnatomyEngineResult } from "@/lib/analysis/anatomyEngine";
import styles from "./SmartAnalysisClient.module.css";

function HitTag({ hit, label }: { hit: boolean; label: string }) {
  return (
    <span className={hit ? styles.pos : styles.neg}>
      {hit ? "✓" : "✗"} {label}
    </span>
  );
}

export function AnatomyEnginePanel({ result }: { result: AnatomyEngineResult | null }) {
  if (!result) {
    return (
      <section className={styles.card}>
        <h3>📡 Market Detect</h3>
        <p className={styles.empty}>
          Not enough FT Over/Under odds on this match yet to read the market.
        </p>
      </section>
    );
  }

  const {
    favSide,
    favOdd,
    tempoLabel,
    idealBet,
    comboLabel,
    mmsRating,
    htRating,
    kilitRating,
    wallRating,
    driftTag,
    expGoalsFt,
    expGoalsHt,
    expGoals2h,
    expLowConfidence,
    expCol,
    isMajorLeague,
    actual,
    engineSource,
    engineId,
    lambda,
    drifts,
    similarity,
    twinProof,
    simDisplayPct,
    shields,
    gateNotes,
    enrichStatus,
    mmsV23,
    kilitV23,
    mispricingAnomaly,
    goldSignals,
    goldMetrics,
  } = result;

  const f2 = (n: number | null | undefined): string => (n == null ? "-" : n.toFixed(2));
  const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

  return (
    <section className={styles.card}>
      <h3>
        📡 Market Detect{" "}
        <span className={styles.muted}>
          · Favourite {favSide === "HOME" ? "Home" : "Away"} @{favOdd.toFixed(2)}
        </span>
      </h3>
      <p className={styles.cardLead}>
        A Shin-devigged, Poisson-solved read of the bookmakers&apos; implied goal expectation for
        this fixture (FT and 1st/2nd half), cross-checked against five named sub-ratings (Steel
        Lock, tempo, HT-goal, wall, 2:1/1:2 duel) to pick a tempo read and an ideal-bet suggestion.
        This is a market scan, not a guaranteed outcome.
      </p>

      <p className={styles.subHead}>
        Expected goals (FT / 2nd half): <strong>{expCol}</strong>
        {expLowConfidence ? <span className={styles.muted}> · low confidence (thin OU market)</span> : null}
        {isMajorLeague ? <span className={styles.geScoreTag}> Major League</span> : null}
      </p>

      <div className={styles.geVerdictGrid}>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Tempo read</span>
          <span className={styles.geVerdictText}>{tempoLabel}</span>
        </div>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Ideal bet</span>
          <span className={styles.geVerdictText}>{idealBet}</span>
        </div>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Engine</span>
          <span className={styles.geVerdictText}>{comboLabel}</span>
          <span className={styles.muted}>{engineSource}</span>
        </div>
      </div>

      <p className={styles.subHead}>
        <strong>🏆 Gold Signals</strong>
        <span className={styles.muted}>
          {" "}
          · MMS {goldMetrics.mmsRadar.toFixed(0)} · KL {goldMetrics.klTotal.toFixed(3)} · Δ Draw {pct(goldMetrics.dDraw)}
        </span>
      </p>
      {goldSignals.length ? (
        <ul className={styles.cardLead} style={{ margin: 0, paddingLeft: "1.1rem" }}>
          {goldSignals.map((g) => (
            <li key={g.id}>
              <strong>{g.label}</strong> → {g.market}
              {g.odds != null ? <> @{g.odds.toFixed(2)}</> : null}
              {g.backtest ? <span className={styles.muted}> · {g.backtest}</span> : null}
              {g.hit != null ? (
                <>
                  {" "}
                  <HitTag hit={g.hit} label={g.hit ? "Won" : "Lost"} />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>No Gold Signal triggered on this match.</p>
      )}

      <p className={styles.subHead}>
        <strong>Sub-ratings</strong>
      </p>
      <ul className={styles.cardLead} style={{ margin: 0, paddingLeft: "1.1rem" }}>
        <li>
          <span className={styles.muted}>MMS (tempo)</span> {mmsRating.toFixed(0)} ·{" "}
          <span className={styles.muted}>Steel Lock</span> {kilitRating.toFixed(0)} ·{" "}
          <span className={styles.muted}>HT goal</span> {htRating.toFixed(0)} ·{" "}
          <span className={styles.muted}>Wall</span> {wallRating.toFixed(0)}
        </li>
        <li>
          <span className={styles.muted}>Over 2.5 / Over 3.5 drift since opening</span> {driftTag}
        </li>
        {expGoalsHt != null ? (
          <li>
            <span className={styles.muted}>E_HT (1st half)</span> {expGoalsHt.toFixed(2)}
            {expGoals2h != null ? (
              <>
                {" "}
                · <span className={styles.muted}>E_2H (2nd half)</span> {expGoals2h.toFixed(2)}
              </>
            ) : null}
          </li>
        ) : null}
        {expGoalsFt != null ? (
          <li>
            <span className={styles.muted}>E_FT (full match)</span> {expGoalsFt.toFixed(2)}
          </li>
        ) : null}
      </ul>

      <p className={styles.subHead}>
        <strong>Goal expectation (λ) &amp; drifts</strong>
        {enrichStatus === "pending" ? (
          <span className={styles.muted}> · loading H2H form &amp; twins…</span>
        ) : null}
        {enrichStatus === "unavailable" ? (
          <span className={styles.muted}> · form / twin data unavailable — v23 gates cannot confirm</span>
        ) : null}
      </p>
      <ul className={styles.cardLead} style={{ margin: 0, paddingLeft: "1.1rem" }}>
        <li>
          <span className={styles.muted}>λ_market</span> {f2(lambda.market)} ·{" "}
          <span className={styles.muted}>λ_form</span>{" "}
          {lambda.form != null
            ? `${f2(lambda.form)} (n=${lambda.formN}, w=${lambda.formWSum}, γ=${f2(lambda.gamma)})`
            : "none"}{" "}
          → <span className={styles.muted}>λ_blend</span> <strong>{f2(lambda.blend)}</strong>
        </li>
        <li>
          <span className={styles.muted}>Δ Over 2.5</span> {pct(drifts.d25)} ·{" "}
          <span className={styles.muted}>Δ Over 3.5</span> {pct(drifts.d35)} ·{" "}
          <span className={styles.muted}>Δ BTTS Yes</span> {pct(drifts.dBtts)} ·{" "}
          <span className={styles.muted}>Δ CS 0:0</span> {pct(drifts.dCs00)}
        </li>
        <li>
          <span className={styles.muted}>MMS v23 (Shin)</span> {mmsV23.toFixed(0)} ·{" "}
          <span className={styles.muted}>Lock v23</span> {kilitV23.toFixed(0)}
        </li>
      </ul>

      <p className={styles.subHead}>
        <strong>888 M6 similarity</strong>
      </p>
      {similarity ? (
        <ul className={styles.cardLead} style={{ margin: 0, paddingLeft: "1.1rem" }}>
          <li>
            <span className={styles.muted}>Similarity</span> {similarity.simPct.toFixed(0)}%
            {engineId === "SAF_V23_KILIT" && simDisplayPct != null ? (
              <span className={styles.muted}> (lock reads inverse: {simDisplayPct.toFixed(0)}%)</span>
            ) : null}{" "}
            · <span className={styles.muted}>bank</span> {similarity.bankSize}
          </li>
          <li>
            <span className={styles.muted}>Twins (k={similarity.k})</span> 3.5+: {similarity.twinO35}/5 · 5.5+:{" "}
            {similarity.twinO55}/5 · &lt;2.5: {similarity.twinU25}/5
            {twinProof ? <span className={styles.muted}> · engine proof: {twinProof}</span> : null}
          </li>
          <li>
            <span className={styles.muted}>Nearest twins</span>{" "}
            {similarity.top.map((t) => `${t.score} (${t.tot}G)`).join(" · ")}
          </li>
        </ul>
      ) : (
        <p className={styles.muted}>
          {enrichStatus === "pending" ? "Loading twin check…" : "No twin data for this match."}
        </p>
      )}

      {shields.length || gateNotes.length || mispricingAnomaly ? (
        <>
          <p className={styles.subHead}>
            <strong>Shields &amp; gates</strong>
          </p>
          <ul className={styles.cardLead} style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {shields.map((s) => (
              <li key={s}>
                <span className={styles.neg}>{s}</span>
              </li>
            ))}
            {gateNotes.map((g) => (
              <li key={g}>
                <span className={styles.muted}>{g}</span>
              </li>
            ))}
            {mispricingAnomaly ? (
              <li>
                <span className={styles.muted}>OU mispricing: E_FT &lt; E_HT (2nd-half expectation negative)</span>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      {actual ? (
        <>
          <p className={styles.subHead}>
            Final score: <span className={styles.geScoreTag}>{actual.score}</span>
            {actual.htScore ? <span className={styles.muted}> · HT {actual.htScore}</span> : null}
          </p>
          <div className={styles.geStatsGrid}>
            {actual.tempoHit != null ? (
              <div className={styles.geStat}>
                <HitTag hit={actual.tempoHit} label="Tempo read" />
              </div>
            ) : null}
            {actual.expDiff != null ? (
              <div className={styles.geStat}>
                <span className={styles.muted}>
                  Actual goals vs E_FT: {actual.expDiff >= 0 ? "+" : ""}
                  {actual.expDiff.toFixed(2)}
                </span>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className={styles.muted}>Match not finished yet — read shown only.</p>
      )}
    </section>
  );
}
