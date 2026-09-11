import type { GoalEngineMetrics } from "@/lib/analysis/goalEngine";
import styles from "./SmartAnalysisClient.module.css";

const SCORE_PROFILE_LABEL: Record<GoalEngineMetrics["scoreProfile"], string> = {
  EXTREME_BLOWOUT: "Extreme blowout",
  DOMINANT_WIN: "Dominant win",
  CONTESTED_FAVORITE: "Contested favourite",
  OPEN_EXCHANGE: "Open exchange",
  BALANCED: "Balanced",
  HARD_UNDER: "Hard under",
  LOCKED_CORRIDOR: "Locked corridor (false open)",
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
        <h3>Goal & Market Engine</h3>
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
    pOver15,
    pOver25,
    pOver35,
    pOver45,
    fairGoalLine,
    bttsExpectancy,
    scoreProfile,
    anomalies,
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <h3 style={{ margin: 0 }}>
          🎯 Goal & Market Anomaly Engine{" "}
          <span className={styles.muted} style={{ fontSize: "0.85rem", fontWeight: 400 }}>
            · {SCORE_PROFILE_LABEL[scoreProfile]}
          </span>
        </h3>
        {actualScore && (
          <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted, #888)" }}>
            Biten Skor: <strong style={{ color: "var(--text-main, #fff)" }}>{actualScore}</strong>
          </span>
        )}
      </div>

      {/* 1. TEŞHİS KARTLARI (HT & FT VERDICTS) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "0.75rem",
          marginBottom: "1rem",
        }}
      >
        <div
          style={{
            padding: "0.85rem 1rem",
            borderRadius: "8px",
            backgroundColor: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted, #888)", textTransform: "uppercase", marginBottom: "0.35rem" }}>
            🎯 İlk Yarı Teşhisi
          </div>
          <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-main, #fff)" }}>
            {htVerdict}
          </div>
        </div>

        <div
          style={{
            padding: "0.85rem 1rem",
            borderRadius: "8px",
            backgroundColor: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted, #888)", textTransform: "uppercase", marginBottom: "0.35rem" }}>
            🎯 Maç Sonu Teşhisi
          </div>
          <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-main, #fff)" }}>
            {ftVerdict}
          </div>
        </div>
      </div>

      {/* 2. TESPİT EDİLEN PİYASA ANOMALİLERİ */}
      <div
        style={{
          padding: "0.85rem 1rem",
          borderRadius: "8px",
          backgroundColor: anomalies.length > 0 ? "rgba(239, 68, 68, 0.05)" : "rgba(255, 255, 255, 0.02)",
          border: anomalies.length > 0 ? "1px solid rgba(239, 68, 68, 0.2)" : "1px solid rgba(255, 255, 255, 0.05)",
          marginBottom: "1rem",
        }}
      >
        <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: "0.45rem", color: anomalies.length > 0 ? "#f87171" : "#888" }}>
          🚨 TESPİT EDİLEN PİYASA ANOMALİLERİ
        </div>
        {anomalies.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: "1.2rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {anomalies.map((ano, idx) => (
              <li key={idx} style={{ fontSize: "0.88rem", lineHeight: 1.4, color: "var(--text-main, #eee)" }}>
                {ano}
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted, #777)" }}>
            Belirgin bir oran anomalisi veya likidite kayması tespit edilmedi.
          </div>
        )}
      </div>

      {/* 3. PİYASA GÖSTERGELERİ DETAY ÇİZELGESİ */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "0.5rem",
          padding: "0.75rem",
          borderRadius: "6px",
          backgroundColor: "rgba(0, 0, 0, 0.2)",
          fontSize: "0.82rem",
        }}
      >
        <div>
          <span style={{ color: "var(--text-muted, #888)" }}>Taraf Baskısı: </span>
          <strong>{favoriteLabel}</strong>
          {favoriteOdds != null ? ` (@${favoriteOdds.toFixed(2)})` : ""}
        </div>
        <div>
          <span style={{ color: "var(--text-muted, #888)" }}>HT 0:0 Oranı: </span>
          <strong>{htZeroZeroOdd != null ? `@${htZeroZeroOdd.toFixed(2)}` : "—"}</strong>
        </div>
        <div>
          <span style={{ color: "var(--text-muted, #888)" }}>KG Beklentisi: </span>
          <strong>{bttsExpectancy ? "Var (Yüksek)" : "Yok (Zayıf)"}</strong>
        </div>
        <div>
          <span style={{ color: "var(--text-muted, #888)" }}>Adil Gol Çizgisi: </span>
          <strong>{fairGoalLine}</strong>
        </div>
        <div>
          <span style={{ color: "var(--text-muted, #888)" }}>2.5 Üst İhtimali: </span>
          <strong>%{pOver25}</strong>
        </div>
        <div>
          <span style={{ color: "var(--text-muted, #888)" }}>3.5 Üst İhtimali: </span>
          <strong>{pOver35 != null ? `%${pOver35}` : "—"}</strong>
        </div>
      </div>
    </section>
  );
}
