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
  } = result;

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
        </div>
      </div>

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
