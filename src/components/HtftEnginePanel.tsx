import { HTFT_COMBO_LABEL, type HtftEngineResult } from "@/lib/analysis/htftEngine";
import styles from "./EnginePanels.module.css";

const INFO =
  "Weighted probability distribution across all 9 HT/FT combinations, derived from this match's own First Half, Second Half and Full Time 1X2 odds plus BTTS / Over 2.5. A probability model, not a guaranteed outcome.";

export function HtftEnginePanel({ result }: { result: HtftEngineResult | null }) {
  if (!result) {
    return (
      <section className={styles.card}>
        <div className={styles.head}>
          <h3 className={styles.title}>⏱️ HT/FT</h3>
        </div>
        <p className={styles.empty}>Not enough First Half / Full Time 1X2 odds for the HT/FT matrix.</p>
      </section>
    );
  }

  const { picks, favSide, favOdd, turnaroundAlert } = result;
  const max = Math.max(...picks.map((p) => p.prob), 1);

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <h3 className={styles.title}>⏱️ HT/FT</h3>
        <span className={styles.meta}>
          Fav {favSide === "HOME" ? "Home" : "Away"} @{favOdd.toFixed(2)}
        </span>
        <span className={styles.info} title={INFO} aria-label={INFO}>
          i
        </span>
      </div>

      {turnaroundAlert ? (
        <div className={styles.alerts} role="status">
          <p className={styles.alert}>⚡ {turnaroundAlert}</p>
        </div>
      ) : null}

      <div className={styles.htftGrid}>
        {picks.map((p, i) => (
          <div
            key={p.combo}
            className={`${styles.htftCell} ${i < 3 ? styles.htftCellTop : ""}`}
            title={HTFT_COMBO_LABEL[p.combo]}
          >
            <span className={styles.htftBar} style={{ width: `${(p.prob / max) * 100}%` }} />
            <span className={styles.htftCombo}>{p.combo}</span>
            <span className={styles.htftPct}>%{p.prob.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
