// scripts/diagnose-similarity-timeout.ts
// Yeni UNION ALL tabanlı SQL mimarisinin EXPLAIN planını ve 
// tahmini satır sayısını DB'yi yormadan analiz eder.

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
  const { MATCH_ODDS_TABLE } = await import("@/lib/analysis/marketQuotes");

  const STATS = statsCfg as unknown as Record<string, any>;
  const WEIGHTS = (weightsCfg as any).weights;

  let [eventId, bookmaker] = process.argv.slice(2);

  try {
    if (!eventId || !bookmaker) {
      const rows = (await sql.unsafe(`
        SELECT event_id, bookmaker, COUNT(*) AS n
        FROM match_odds
        WHERE opening IS NOT NULL AND opening != 0
        GROUP BY event_id, bookmaker
        ORDER BY n DESC
        LIMIT 1
      `)) as { event_id: string; bookmaker: string; n: number }[];
      eventId = eventId || rows[0].event_id;
      bookmaker = bookmaker || rows[0].bookmaker;
    }

    console.log(`event_id=${eventId} bookmaker=${bookmaker}`);

    console.log("\n=== match_odds INDEX'LERİ ===");
    const idx = (await sql.unsafe(`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'match_odds'
    `)) as { indexname: string; indexdef: string }[];
    idx.forEach((r) => console.log(` - ${r.indexname}: ${r.indexdef}`));

    console.log("\n=== bookmaker toplam satır sayısı ===");
    const cnt = (await sql.unsafe(
      `SELECT COUNT(*) AS n FROM match_odds WHERE bookmaker = $1 AND opening IS NOT NULL AND opening != 0`,
      [bookmaker] as never[],
    )) as { n: string }[];
    console.log(`  bookmaker=${bookmaker} -> ${cnt[0].n} satır`);

    const fixtureRows = (await sql.unsafe(
      `SELECT market, selection, odds, opening FROM match_odds WHERE event_id = $1 AND bookmaker = $2 AND opening IS NOT NULL AND opening != 0`,
      [eventId, bookmaker] as never[],
    )) as { market: string; selection: string; odds: number; opening: number }[];

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

    console.log(`\naktif kod sayısı: ${activeCodes.length}`);

    if (activeCodes.length === 0) {
      console.log("HATA: aktif kod bulunamadı.");
      return;
    }

    const groupCounts = new Map<string, number>();
    for (const c of activeCodes) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1);

    const minRequiredCodes = Math.ceil(activeCodes.length * 0.6);
    const unionBranches: string[] = [];
    const params: unknown[] = [bookmaker, eventId];

    activeCodes.forEach((c) => {
      const stats = STATS[c.code];
      const [medDrift, madDrift] = stats.mean_drift_pct;
      const [medSpread, madSpread] = stats.spread_close;
      const groupWeight = WEIGHTS[c.group] ?? 1;
      const weight = groupWeight / (groupCounts.get(c.group) ?? 1);

      params.push(c.market, c.side, weight, medDrift, madDrift || 1, medSpread, madSpread || 1);
      const pIdx = params.length - 6;

      unionBranches.push(`
        SELECT
          mo.event_id,
          MAX((mo.odds::float - mo.opening::float) / mo.opening::float) AS drift,
          STDDEV(s.odds::float) AS spread,
          $${pIdx + 2}::float AS weight,
          $${pIdx + 3}::float AS med_drift,
          $${pIdx + 4}::float AS mad_drift,
          $${pIdx + 5}::float AS med_spread,
          $${pIdx + 6}::float AS mad_spread
        FROM ${MATCH_ODDS_TABLE} mo
        JOIN ${MATCH_ODDS_TABLE} s
          ON s.event_id = mo.event_id
         AND s.market = $${pIdx}
         AND s.selection = $${pIdx + 1}
        WHERE mo.bookmaker = $1
          AND mo.event_id != $2
          AND mo.market = $${pIdx}
          AND mo.selection = $${pIdx + 1}
          AND mo.opening IS NOT NULL AND mo.opening != 0
        GROUP BY mo.event_id
        HAVING STDDEV(s.odds::float) IS NOT NULL
      `);
    });

    const sqlQuery = `
      WITH unified AS (
        ${unionBranches.join('\n        UNION ALL\n')}
      )
      SELECT
        event_id,
        SUM(
          weight * (
            POWER( GREATEST(LEAST((drift - med_drift) / mad_drift, 6), -6), 2 ) +
            POWER( GREATEST(LEAST((spread - med_spread) / mad_spread, 6), -6), 2 )
          )
        ) / SUM(weight) AS final_score
      FROM unified
      GROUP BY event_id
      HAVING COUNT(weight) >= ${minRequiredCodes}
      ORDER BY final_score ASC
      LIMIT 500
    `;

    console.log("\n=== Yeni UNION ALL SQL EXPLAIN (tahmini maliyet) ===");
    const driftPlan = await sql.unsafe(`EXPLAIN ${sqlQuery}`, params as never[]);
    console.log((driftPlan as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n"));

  } catch (err) {
    console.error("\n=== HATA ===");
    console.error(err);
  } finally {
    const { sql } = await import("@/lib/db");
    await sql.end();
  }
}

main();
