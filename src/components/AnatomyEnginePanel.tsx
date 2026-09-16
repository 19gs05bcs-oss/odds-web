import type { AnatomyEngineResult } from "@/lib/analysis/anatomyEngine";
import styles from "./SmartAnalysisClient.module.css";

const MODEL_BADGE_CLASS: Record<AnatomyEngineResult["model"], string> = {
  ULTIMATE_BLOWOUT: styles.pos,
  DEFENSIVE_LOCK: styles.muted,
  IY_KILIT_2Y_COZUM: styles.pos,
  FAKE_FAVORITE_TRAP: styles.neg,
};

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
        <h3>🧬 Anatomy Engine</h3>
        <p className={styles.empty}>
          This match&rsquo;s FT 1X2, FT/HT Over-Under, and Correct Score odds don&rsquo;t line up
          with any of the four anatomy models.
        </p>
      </section>
    );
  }

  const {
    title,
    favSide,
    favOdd,
    iyKarar,
    msTaraf,
    iyMs,
    auKarar,
    golBandi,
    iySkor,
    hedefSkorlar,
    isMajorLeague,
    actual,
  } = result;

  return (
    <section className={styles.card}>
      <h3>
        🧬 Anatomy Engine{" "}
        <span className={styles.muted}>
          · Favourite {favSide === "HOME" ? "Home" : "Away"} @{favOdd.toFixed(2)}
        </span>
      </h3>
      <p className={styles.cardLead}>
        A rule-based anatomy scan across four fixed patterns (Blowout / Defensive Lock / HT Lock
        → 2H Solve / Fake Favourite Trap), derived purely from this match&rsquo;s own FT 1X2,
        FT/HT Over-Under, and Correct Score odds. This is a pattern match, not a guaranteed
        outcome.
      </p>

      <p className={styles.subHead}>
        Model: <strong className={MODEL_BADGE_CLASS[result.model]}>{title}</strong>
        {isMajorLeague ? <span className={styles.geScoreTag}> Major League</span> : null}
      </p>

      <div className={styles.geVerdictGrid}>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>1st Half</span>
          <span className={styles.geVerdictText}>{iyKarar}</span>
        </div>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Full Time</span>
          <span className={styles.geVerdictText}>{msTaraf}</span>
        </div>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>HT/FT</span>
          <span className={styles.geVerdictText}>{iyMs}</span>
        </div>
      </div>

      <p className={styles.subHead}>
        <strong>Goal Reading</strong>
      </p>
      <div className={styles.geStatsGrid}>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Over/Under Call</span>
          <span className={styles.geStatValue}>{auKarar}</span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Goal Band</span>
          <span className={styles.geStatValue}>{golBandi}</span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Expected HT Score</span>
          <span className={styles.geStatValue}>{iySkor}</span>
        </div>
      </div>

      <p className={styles.subHead}>
        <strong>Target Scores</strong>
      </p>
      <p className={styles.cardLead}>
        {hedefSkorlar.map((s) => (
          <span key={s} className={styles.geScoreTag} style={{ marginRight: "0.4rem" }}>
            {s}
            {actual?.score === s ? " ←" : ""}
          </span>
        ))}
      </p>

      {actual ? (
        <>
          <p className={styles.subHead}>
            Final score: <span className={styles.geScoreTag}>{actual.score}</span>
            {actual.htScore ? (
              <span className={styles.muted}> · HT {actual.htScore}</span>
            ) : null}
          </p>
          <div className={styles.geStatsGrid}>
            <div className={styles.geStat}>
              <HitTag hit={actual.msHit} label="FT call" />
            </div>
            <div className={styles.geStat}>
              <HitTag hit={actual.iyHit} label="1st half call" />
            </div>
            <div className={styles.geStat}>
              <HitTag hit={actual.auHit} label="O/U call" />
            </div>
            <div className={styles.geStat}>
              <HitTag hit={actual.bandHit} label="Goal band" />
            </div>
            <div className={styles.geStat}>
              <HitTag hit={actual.scoreHit} label="Target score" />
            </div>
          </div>
        </>
      ) : (
        <p className={styles.muted}>Match not finished yet — model and targets shown only.</p>
      )}
    </section>
  );
}
