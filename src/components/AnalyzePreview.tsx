import styles from "./AnalyzePreview.module.css";

/** Static mock of the analyze workflow for the homepage hero. */
export function AnalyzePreview() {
  return (
    <div className={styles.frame} aria-hidden>
      <div className={styles.chrome}>
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.chromeTitle}>Odds profile · Analyze</span>
      </div>
      <div className={styles.body}>
        <div className={styles.controls}>
          <div className={styles.control}>
            <span>Day</span>
            <div className={styles.select}>2026-08-11</div>
          </div>
          <div className={styles.control}>
            <span>Bookmaker</span>
            <div className={styles.select}>bet365</div>
          </div>
          <div className={`${styles.control} ${styles.controlWide}`}>
            <span>Fixture</span>
            <div className={styles.select}>19:30 · Arsenal – Chelsea</div>
          </div>
        </div>

        <div className={styles.chips}>
          <span className={styles.chip}>1X2 1 · O ×</span>
          <span className={styles.chip}>Over 2.5 · C ×</span>
        </div>

        <div className={styles.tableWrap}>
          <div className={styles.tableHead}>
            <span>Archive matches</span>
            <span className={styles.badge}>47 hits</span>
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Home</th>
                <th>Away</th>
                <th>1 O</th>
                <th>1 C</th>
                <th>FT</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>12.04.24</td>
                <td>Liverpool</td>
                <td>Fulham</td>
                <td className={styles.hit}>2.08</td>
                <td className={styles.hit}>2.05</td>
                <td>2-1</td>
              </tr>
              <tr>
                <td>03.11.23</td>
                <td>Inter</td>
                <td>Salernitana</td>
                <td className={styles.hit}>2.10</td>
                <td>2.02</td>
                <td>3-0</td>
              </tr>
              <tr>
                <td>21.01.23</td>
                <td>Real Madrid</td>
                <td>Barcelona</td>
                <td className={styles.miss}>2.45</td>
                <td className={styles.hit}>2.06</td>
                <td>1-2</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
