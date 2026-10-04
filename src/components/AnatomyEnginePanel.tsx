import type { AnatomyEngineResult } from "@/lib/analysis/anatomyEngine";
import styles from "./EnginePanels.module.css";

const INFO =
  "Shin-devigged, Poisson-solved read of the bookmakers' implied goal expectation (FT and 1st/2nd half), cross-checked against five named sub-ratings (Steel Lock, tempo, HT-goal, wall, 2:1/1:2 duel) to pick a tempo read and an ideal-bet suggestion. A market scan, not a guaranteed outcome.";

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
        <div className={styles.head}>
          <h3 className={styles.title}>📡 Market Detect</h3>
        </div>
        <p className={styles.empty}>Not enough FT Over/Under odds on this match yet to read the market.</p>
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
      <div className={styles.head}>
        <h3 className={styles.title}>📡 Market Detect</h3>
        <span className={styles.meta}>
          Fav {favSide === "HOME" ? "Home" : "Away"} @{favOdd.toFixed(2)}
        </span>
        {isMajorLeague ? <span className={styles.tag}>Major League</span> : null}
        {actual ? (
          <span className={styles.tag}>
            FT {actual.score}
            {actual.htScore ? ` · HT ${actual.htScore}` : ""}
          </span>
        ) : null}
        <span className={styles.info} title={INFO} aria-label={INFO}>
          i
        </span>
      </div>

      <div className={styles.verdicts}>
        <div className={styles.verdict}>
          <span className={styles.label}>Tempo read</span>
          <span className={styles.verdictText}>{tempoLabel}</span>
        </div>
        <div className={styles.verdict}>
          <span className={styles.label}>Ideal bet</span>
          <span className={styles.verdictText}>{idealBet}</span>
        </div>
        <div className={styles.verdict}>
          <span className={styles.label}>Engine</span>
          <span className={styles.verdictText}>{comboLabel}</span>
          <span className={styles.meta}>{engineSource}</span>
        </div>
      </div>

      <div className={styles.chips}>
        <div className={styles.chip}>
          <span className={styles.label}>Exp. goals ({expCol})</span>
          <span className={styles.chipValue}>
            {expGoalsFt != null ? expGoalsFt.toFixed(2) : "-"}
            {expLowConfidence ? <span className={styles.chipSub}>low conf.</span> : null}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>MMS</span>
          <span className={styles.chipValue}>{mmsRating.toFixed(0)}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Steel Lock</span>
          <span className={styles.chipValue}>{kilitRating.toFixed(0)}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>HT goal</span>
          <span className={styles.chipValue}>{htRating.toFixed(0)}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Wall</span>
          <span className={styles.chipValue}>{wallRating.toFixed(0)}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>O2.5/O3.5 drift</span>
          <span className={styles.chipValue}>{driftTag}</span>
        </div>
      </div>

      <p className={styles.sec}>
        🏆 Gold Signals
        <span className={styles.muted} style={{ textTransform: "none", letterSpacing: 0 }}>
          {" "}
          · MMS {goldMetrics.mmsRadar.toFixed(0)} · KL {goldMetrics.klTotal.toFixed(3)} · Δ Draw{" "}
          {pct(goldMetrics.dDraw)}
        </span>
      </p>
      {goldSignals.length ? (
        <ul className={styles.goldList}>
          {goldSignals.map((g) => (
            <li key={g.id} className={styles.goldItem}>
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
        <p className={styles.muted} style={{ margin: 0, fontSize: "0.76rem" }}>
          No Gold Signal triggered.
        </p>
      )}

      {shields.length || mispricingAnomaly ? (
        <div className={styles.alerts} style={{ marginTop: "0.5rem", marginBottom: 0 }}>
          {shields.map((s) => (
            <p key={s} className={styles.alert}>
              🛡️ {s}
            </p>
          ))}
          {mispricingAnomaly ? (
            <p className={styles.alert}>OU mispricing: E_FT &lt; E_HT (2nd-half expectation negative)</p>
          ) : null}
        </div>
      ) : null}

      {actual && (actual.tempoHit != null || actual.expDiff != null) ? (
        <p className={styles.meta} style={{ margin: "0.5rem 0 0" }}>
          {actual.tempoHit != null ? <HitTag hit={actual.tempoHit} label="Tempo read" /> : null}
          {actual.tempoHit != null && actual.expDiff != null ? " · " : null}
          {actual.expDiff != null ? (
            <>
              Actual goals vs E_FT: {actual.expDiff >= 0 ? "+" : ""}
              {actual.expDiff.toFixed(2)}
            </>
          ) : null}
        </p>
      ) : null}

      <details className={styles.details}>
        <summary>
          Details (λ, drifts, 888 M6 similarity
          {enrichStatus === "pending" ? " · loading…" : ""})
        </summary>

        <p className={styles.sec}>Expectation &amp; λ</p>
        <ul className={styles.kv}>
          {expGoalsHt != null ? (
            <li>
              <span className={styles.muted}>E_HT</span> {expGoalsHt.toFixed(2)}
              {expGoals2h != null ? (
                <>
                  {" "}
                  · <span className={styles.muted}>E_2H</span> {expGoals2h.toFixed(2)}
                </>
              ) : null}
            </li>
          ) : null}
          <li>
            <span className={styles.muted}>λ_market</span> {f2(lambda.market)} ·{" "}
            <span className={styles.muted}>λ_form</span>{" "}
            {lambda.form != null
              ? `${f2(lambda.form)} (n=${lambda.formN}, w=${lambda.formWSum}, γ=${f2(lambda.gamma)})`
              : "none"}{" "}
            → <span className={styles.muted}>λ_blend</span> <strong>{f2(lambda.blend)}</strong>
          </li>
          <li>
            <span className={styles.muted}>Δ O2.5</span> {pct(drifts.d25)} ·{" "}
            <span className={styles.muted}>Δ O3.5</span> {pct(drifts.d35)} ·{" "}
            <span className={styles.muted}>Δ BTTS</span> {pct(drifts.dBtts)} ·{" "}
            <span className={styles.muted}>Δ CS 0:0</span> {pct(drifts.dCs00)}
          </li>
          <li>
            <span className={styles.muted}>MMS v23 (Shin)</span> {mmsV23.toFixed(0)} ·{" "}
            <span className={styles.muted}>Lock v23</span> {kilitV23.toFixed(0)}
          </li>
        </ul>

        <p className={styles.sec}>888 M6 similarity</p>
        {similarity ? (
          <ul className={styles.kv}>
            <li>
              <span className={styles.muted}>Similarity</span> {similarity.simPct.toFixed(0)}%
              {engineId === "SAF_V23_KILIT" && simDisplayPct != null ? (
                <span className={styles.muted}> (lock reads inverse: {simDisplayPct.toFixed(0)}%)</span>
              ) : null}{" "}
              · <span className={styles.muted}>bank</span> {similarity.bankSize}
            </li>
            <li>
              <span className={styles.muted}>Twins (k={similarity.k})</span> 3.5+: {similarity.twinO35}/5 ·
              5.5+: {similarity.twinO55}/5 · &lt;2.5: {similarity.twinU25}/5
              {twinProof ? <span className={styles.muted}> · proof: {twinProof}</span> : null}
            </li>
            <li>
              <span className={styles.muted}>Nearest</span>{" "}
              {similarity.top.map((t) => `${t.score} (${t.tot}G)`).join(" · ")}
            </li>
          </ul>
        ) : (
          <p className={styles.muted} style={{ margin: 0 }}>
            {enrichStatus === "pending"
              ? "Loading twin check…"
              : enrichStatus === "unavailable"
                ? "Form / twin data unavailable — v23 gates cannot confirm."
                : "No twin data for this match."}
          </p>
        )}

        {gateNotes.length ? (
          <>
            <p className={styles.sec}>Gates</p>
            <ul className={styles.kv}>
              {gateNotes.map((g) => (
                <li key={g} className={styles.muted}>
                  {g}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>
    </section>
  );
}
