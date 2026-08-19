// scripts/test-similarity-single-bm.ts
import { readFileSync, existsSync } from "fs";

function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

async function main() {
  loadEnvLocal();
  const { sql } = await import("@/lib/db");
  const { SIMILARITY_CODES } = await import("@/lib/analysis/similarityCodes");
  const statsCfg = (await import("@/lib/analysis/similarityStats.json")).default;
  const weightsCfg = (await import("@/lib/analysis/similarityWeights.json")).default;

  const MATCH_ODDS_TABLE = "match_odds";
  const STATS = statsCfg as unknown as Record<string, any>;
  const WEIGHTS = (weightsCfg as any).weights;
  const SIMILARITY_THRESHOLD = (weightsCfg as any).similarity_threshold;

  let [eventId, bookmaker] = process.argv.slice(2);

  try {
    if (!eventId) {
      const rows = (await sql.unsafe(`SELECT event_id FROM match_odds WHERE opening IS NOT NULL AND opening != 0 GROUP BY event_id ORDER BY COUNT(*) DESC LIMIT 1`)) as { event_id: string }[];
      eventId = rows[0].event_id;
    }
    if (!bookmaker) bookmaker = "bet365";

    console.log(`\n=== MATEMATİKSEL KISAYOL (EARLY PRUNING) MİMARİSİ TEST EDİLİYOR ===`);
    console.log(`eventId=${eventId}  bookmaker=${bookmaker}`);

    const t0 = Date.now();

    const fixtureRows = (await sql.unsafe(
      `SELECT market, selection, odds, opening FROM ${MATCH_ODDS_TABLE} WHERE event_id = $1 AND bookmaker = $2 AND opening IS NOT NULL AND opening != 0`,
      [eventId, bookmaker] as never[]
    )) as any[];

    function findFixtureRowForCode(code: any, rows: any[]) {
      const direct = rows.find((r: any) => r.market === code.market && r.selection === code.side);
      if (direct) return direct;
      if (code.group === "BTTS") {
        const alt = code.side === "btts:YES" ? ["YES", "True", "btts:True"] : ["NO", "False", "btts:False"];
        for (const s of alt) {
          const r = rows.find((r: any) => r.market === code.market && r.selection === s);
          if (r) return r;
        }
      }
      if (code.group === "HTFT") {
        const bareCombo = code.side.replace("htft:", "");
        const r = rows.find((r: any) => r.market === code.market && r.selection === bareCombo);
        if (r) return r;
      }
      return null;
    }

    const activeCodes = SIMILARITY_CODES.filter((c) => {
      if (!STATS[c.code]) return false;
      const row = findFixtureRowForCode(c, fixtureRows);
      return row != null && row.opening != null && row.opening !== 0;
    });

    if (!activeCodes.length) return console.log("HATA: aktif kod bulunamadı.");
    
    const MIN_COVERAGE_RATIO = 0.6;
    const minRequiredCodes = Math.ceil(activeCodes.length * MIN_COVERAGE_RATIO);
    console.log(`Aktif kod: ${activeCodes.length} | %60 Barajı: En az ${minRequiredCodes} kod`);

    const codeValues: string[] = [];
    const params: any[] = [bookmaker, eventId, minRequiredCodes, SIMILARITY_THRESHOLD, 500];
    let pIdx = 6;

    const groupCounts = new Map<string, number>();
    for (const c of activeCodes) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1);

    activeCodes.forEach((c) => {
      const stats = STATS[c.code];
      const [medDrift, madDrift] = stats.mean_drift_pct;
      const [medSpread, madSpread] = stats.spread_close;
      const groupWeight = WEIGHTS[c.group] ?? 1;
      const weight = groupWeight / (groupCounts.get(c.group) ?? 1);

      codeValues.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}::float, $${pIdx+3}::float, $${pIdx+4}::float, $${pIdx+5}::float, $${pIdx+6}::float)`);
      params.push(c.market, c.side, weight, medDrift, madDrift || 1, medSpread, madSpread || 1);
      pIdx += 7;
    });

    const sqlQuery = `
      WITH codes(market, selection, weight, med_drift, mad_drift, med_spread, mad_spread) AS (
        VALUES ${codeValues.join(',\n        ')}
      ),
      -- ADIM 1: Sadece Drifti Çek
      drift_raw AS (
        SELECT mo.event_id, mo.market, mo.selection,
               ((mo.odds::float - mo.opening::float) / mo.opening::float) AS drift
        FROM ${MATCH_ODDS_TABLE} mo
        JOIN codes c ON mo.market = c.market AND mo.selection = c.selection
        WHERE mo.bookmaker = $1
          AND mo.event_id != $2
          AND mo.opening IS NOT NULL AND mo.opening != 0
      ),
      -- ADIM 2: Drift Skorunu (Kısmi Skoru) Hesapla
      drift_agg AS (
        SELECT d.event_id,
               COUNT(*) AS matched_count,
               SUM(c.weight) AS matched_weight,
               SUM(c.weight * POWER(GREATEST(LEAST((d.drift - c.med_drift)/c.mad_drift, 6), -6), 2)) AS sum_drift_sq
        FROM drift_raw d
        JOIN codes c ON d.market = c.market AND d.selection = c.selection
        GROUP BY d.event_id
      ),
      -- ADIM 3: İŞTE O MATEMATİKSEL KISAYOL! Drift skoru eşiği aşıyorsa maçı hemen çöpe at!
      valid_events AS (
        SELECT event_id
        FROM drift_agg
        WHERE matched_count >= $3::int
          AND (sum_drift_sq / matched_weight) < $4::float
      ),
      -- ADIM 4: Spread'i SADECE şanslı ve çok az sayıdaki maç için çek
      spread_raw AS (
        SELECT mo.event_id, mo.market, mo.selection, STDDEV(mo.odds::float) AS spread
        FROM ${MATCH_ODDS_TABLE} mo
        JOIN valid_events ve ON mo.event_id = ve.event_id
        JOIN codes c ON mo.market = c.market AND mo.selection = c.selection
        GROUP BY mo.event_id, mo.market, mo.selection
      )
      -- ADIM 5: Final Skoru birleştir ve getir
      SELECT
        d.event_id,
        SUM(
          c.weight * (
            POWER(GREATEST(LEAST((d.drift - c.med_drift)/c.mad_drift, 6), -6), 2) +
            POWER(GREATEST(LEAST((s.spread - c.med_spread)/c.mad_spread, 6), -6), 2)
          )
        ) / SUM(c.weight) AS final_score
      FROM drift_raw d
      JOIN spread_raw s ON d.event_id = s.event_id AND d.market = s.market AND d.selection = s.selection
      JOIN codes c ON d.market = c.market AND d.selection = c.selection
      WHERE s.spread IS NOT NULL
      GROUP BY d.event_id
      HAVING COUNT(*) >= $3::int
      ORDER BY final_score ASC
      LIMIT $5::int
    `;

    console.log(`\nSorgu çalıştırılıyor... Lütfen bekleyin.`);
    const results = (await sql.unsafe(sqlQuery, params)) as { event_id: string; final_score: number }[];
    const ms = Date.now() - t0;

    const validResults = results.filter((r) => r.final_score < SIMILARITY_THRESHOLD);

    console.log(`\n=== BAŞARILI (${ms}ms) ===`);
    console.log("Geçerli Eşleşme Sayısı:", validResults.length);
    if (validResults.length > 0) {
      console.log("Örnekler (İlk 10):", validResults.slice(0, 10));
    }

  } catch (err) {
    console.error("\n=== SİSTEM HATASI ===");
    console.error(err);
  } finally {
    const { sql } = await import("@/lib/db");
    await sql.end();
  }
}

main();
