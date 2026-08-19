// scripts/test-similarity-single-bm.ts
// similarityEngine.ts'e HİÇ dokunmadan, doğrudan yeni CTE (Süzgeç) 
// SQL mimarisini izole bir şekilde test eder.

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
  
  // İhtiyacımız olan bağımsız modüller (similarityEngine'e dokunmadan)
  const { SIMILARITY_CODES } = await import("@/lib/analysis/similarityCodes");
  const { MATCH_ODDS_TABLE } = await import("@/lib/analysis/marketQuotes");
  const statsCfg = (await import("@/lib/analysis/similarityStats.json")).default;
  const weightsCfg = (await import("@/lib/analysis/similarityWeights.json")).default;

  const STATS = statsCfg as unknown as Record<string, any>;
  const WEIGHTS = (weightsCfg as any).weights;
  const SIMILARITY_THRESHOLD = (weightsCfg as any).similarity_threshold;

  let [eventId, bookmaker] = process.argv.slice(2);

  try {
    // 1) event_id verilmediyse otomatik seç
    if (!eventId) {
      console.log("event_id verilmedi, otomatik seçiliyor...");
      const rows = (await sql.unsafe(`
        SELECT event_id, COUNT(*) AS n
        FROM match_odds
        WHERE opening IS NOT NULL AND opening != 0
        GROUP BY event_id
        ORDER BY n DESC
        LIMIT 1
      `)) as { event_id: string; n: number }[];
      if (!rows.length) throw new Error("match_odds içinde uygun satır bulunamadı.");
      eventId = rows[0].event_id;
      console.log(`  -> event_id = ${eventId} (${rows[0].n} satır)`);
    }

    // 2) bookmaker verilmediyse otomatik seç
    if (!bookmaker) {
      console.log("bookmaker verilmedi, otomatik seçiliyor...");
      const rows = (await sql.unsafe(
        `SELECT bookmaker, COUNT(*) AS n FROM match_odds WHERE event_id = $1 AND bookmaker IS NOT NULL AND opening IS NOT NULL AND opening != 0 GROUP BY bookmaker ORDER BY n DESC LIMIT 1`,
        [eventId] as never[],
      )) as { bookmaker: string; n: number }[];
      if (!rows.length) throw new Error(`event_id=${eventId} için bookmaker bulunamadı.`);
      bookmaker = rows[0].bookmaker;
      console.log(`  -> bookmaker = ${bookmaker} (${rows[0].n} satır)`);
    }

    // 3) Bu event + bookmaker için fixtureOdds'u çek
    const fixtureRows = (await sql.unsafe(
      `SELECT market, selection, odds, opening FROM match_odds WHERE event_id = $1 AND bookmaker = $2 AND opening IS NOT NULL AND opening != 0`,
      [eventId, bookmaker] as never[],
    )) as any[];

    console.log(`\nfixtureOdds satır sayısı: ${fixtureRows.length}`);
    if (!fixtureRows.length) return console.log("HATA: DB'de satır bulunamadı.");

    console.log(`\n=== YENİ CTE MİMARİSİ TEST EDİLİYOR ===`);
    console.log(`eventId=${eventId}  bookmaker=${bookmaker}`);

    // Helper: Kod karşılığını bul
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

    if (!activeCodes.length) {
      console.log("HATA: aktif kod bulunamadı.");
      return;
    }
    console.log(`Aktif kod sayısı: ${activeCodes.length}`);

    const groupCounts = new Map<string, number>();
    for (const c of activeCodes) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1);

    const MIN_COVERAGE_RATIO = 0.6;
    const minRequiredCodes = Math.ceil(activeCodes.length * MIN_COVERAGE_RATIO);

    const codeValues: string[] = [];
    const params: unknown[] = [bookmaker, eventId, minRequiredCodes, 500]; // limit = 500
    let pIdx = 5;

    // Statik değerleri bind parametrelerine aktar
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

    // 3 Kademeli Süzgeç Mantığı
    const sqlQuery = `
      WITH codes(market, selection, weight, med_drift, mad_drift, med_spread, mad_spread) AS (
        VALUES ${codeValues.join(',\n        ')}
      ),
      drift_cte AS (
        SELECT mo.event_id, mo.market, mo.selection,
               MAX((mo.odds::float - mo.opening::float) / mo.opening::float) AS drift
        FROM ${MATCH_ODDS_TABLE} mo
        JOIN codes c ON mo.market = c.market AND mo.selection = c.selection
        WHERE mo.bookmaker = $1
          AND mo.event_id != $2
          AND mo.opening IS NOT NULL AND mo.opening != 0
        GROUP BY mo.event_id, mo.market, mo.selection
      ),
      valid_events AS (
        SELECT event_id
        FROM drift_cte
        GROUP BY event_id
        HAVING COUNT(*) >= $3::int
      ),
      spread_cte AS (
        SELECT mo.event_id, mo.market, mo.selection, STDDEV(mo.odds::float) AS spread
        FROM ${MATCH_ODDS_TABLE} mo
        JOIN valid_events ve ON mo.event_id = ve.event_id
        JOIN codes c ON mo.market = c.market AND mo.selection = c.selection
        GROUP BY mo.event_id, mo.market, mo.selection
      )
      SELECT
        d.event_id,
        SUM(
          c.weight * (
            POWER( GREATEST(LEAST((d.drift - c.med_drift) / c.mad_drift, 6), -6), 2 ) +
            POWER( GREATEST(LEAST((s.spread - c.med_spread) / c.mad_spread, 6), -6), 2 )
          )
        ) / SUM(c.weight) AS final_score
      FROM drift_cte d
      JOIN spread_cte s
        ON d.event_id = s.event_id
       AND d.market = s.market
       AND d.selection = s.selection
      JOIN codes c
        ON d.market = c.market
       AND d.selection = c.selection
      WHERE s.spread IS NOT NULL
      GROUP BY d.event_id
      HAVING COUNT(c.weight) >= $3::int
      ORDER BY final_score ASC
      LIMIT $4::int
    `;

    const t0 = Date.now();
    const results = (await sql.unsafe(sqlQuery, params)) as { event_id: string; final_score: number }[];
    const ms = Date.now() - t0;

    const validResults = results.filter((r) => r.final_score < SIMILARITY_THRESHOLD);

    console.log(`\n=== SONUÇ (${ms}ms) ===`);
    console.log("matchedCount:", validResults.length);
    console.log("samples (ilk 10):", validResults.slice(0, 10));

  } catch (err) {
    console.error("\n=== SİSTEM HATASI ===");
    console.error(err);
  } finally {
    const { sql } = await import("@/lib/db");
    await sql.end();
  }
}

main();
