import type { GoalEngineMetrics } from "@/lib/analysis/goalEngine";
import styles from "./SmartAnalysisClient.module.css";

const SCORE_PROFILE_LABEL: Record<GoalEngineMetrics["scoreProfile"], string> = {
  EXTREME_BLOWOUT: "Extreme Blowout",
  DOMINANT_WIN: "Dominant Win",
  CONTESTED_FAVORITE: "Contested Favourite",
  OPEN_EXCHANGE: "Open Exchange",
  BALANCED: "Balanced",
  HARD_UNDER: "Hard Under",
  LOCKED_CORRIDOR: "Locked Corridor (False Open)",
};

export function GoalEnginePanel({
  metrics,
  actualScore,
}: {
  metrics: GoalEngineMetrics | null;
  actualScore?: string | null;
}) {
  if (!metrics) {
    return (
      <section className={styles.card}>
        <h3>🎯 Gol & Piyasa Anomali Motoru</h3>
        <p className={styles.empty}>
          Bu maç için yeterli 1X2 / Alt-Üst / HT oran verisi bulunamadı.
        </p>
      </section>
    );
  }

  const {
    dominanceSide,
    isHeavyFavorite,
    isExtremeDominance,
    favoriteOdds,
    htZeroZeroOdd,
    pOver25,
    pOver35,
    fairGoalLine,
    bttsExpectancy,
    scoreProfile,
    anomalies = [],
    htVerdict,
    ftVerdict,
  } = metrics;

  const favoriteLabel =
    dominanceSide === "NONE"
      ? "Dengeli (Belirgin favori yok)"
      : `${dominanceSide === "HOME" ? "Ev Sahibi" : "Deplasman"}${
          isExtremeDominance ? " (Aşırı Baskın)" : isHeavyFavorite ? " (Ağır Favori)" : ""
        }`;

  return (
    <section className={styles.card}>
      <h3>
        🎯 Gol & Piyasa Anomali Motoru{" "}
        <span className={styles.muted}>· {SCORE_PROFILE_LABEL[scoreProfile]}</span>
      </h3>
      <p className={styles.cardLead}>
        Bu maçın kendi 1X2 / Alt-Üst / İlk Yarı oranlarından türetilen skor profili, HT-FT
        teşhisleri ve piyasa anomalileri. Tek başına kesin bir tahmin değildir.
      </p>

      {actualScore ? (
        <p className={styles.subHead}>
          Biten skor: <span className={styles.geScoreTag}>{actualScore}</span>
        </p>
      ) : null}

      <div className={styles.geVerdictGrid}>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>İlk Yarı Teşhisi</span>
          <span className={styles.geVerdictText}>{htVerdict || "Dengeli İlk Yarı"}</span>
        </div>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Maç Sonu Teşhisi</span>
          <span className={styles.geVerdictText}>{ftVerdict || "Normal Tempo"}</span>
        </div>
      </div>

      <p className={styles.subHead}>
        <strong>Tespit Edilen Piyasa Anomalileri</strong>
      </p>
      {anomalies.length > 0 ? (
        <div className={styles.steamAlerts} role="status">
          {anomalies.map((item, idx) => (
            <p key={idx} className={styles.steamAlertItem}>
              <span className={styles.steamAlertIcon} aria-hidden="true">
                🚨
              </span>
              {item}
            </p>
          ))}
        </div>
      ) : (
        <p className={styles.muted}>
          Belirgin bir oran anomalisi veya sert likidite kayması tespit edilmedi.
        </p>
      )}

      <p className={styles.subHead}>
        <strong>Piyasa Göstergeleri</strong>
      </p>
      <div className={styles.geStatsGrid}>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Taraf Baskısı</span>
          <span className={styles.geStatValue}>{favoriteLabel}</span>
          {favoriteOdds != null ? (
            <span className={styles.geStatSub}>@{favoriteOdds.toFixed(2)}</span>
          ) : null}
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>HT 0:0 Oranı</span>
          <span className={styles.geStatValue}>
            {htZeroZeroOdd != null ? `@${htZeroZeroOdd.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>KG Beklentisi</span>
          <span className={bttsExpectancy ? styles.pos : styles.neg}>
            {bttsExpectancy ? "Var (Yüksek)" : "Yok (Zayıf)"}
          </span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Adil Gol Çizgisi</span>
          <span className={styles.geStatValue}>{fairGoalLine}</span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>2.5 Üst İhtimali</span>
          <span className={styles.geStatValue}>%{pOver25}</span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>3.5 Üst İhtimali</span>
          <span className={styles.geStatValue}>{pOver35 != null ? `%${pOver35}` : "—"}</span>
        </div>
      </div>
    </section>
  );
}
