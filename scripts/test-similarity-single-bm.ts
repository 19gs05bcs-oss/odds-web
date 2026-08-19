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

    console.log(`\n=== HYBRID NODE.JS + SQL MİMARİSİ (SAF SQL) TEST EDİLİYOR ===`);
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

    // --- AŞAMA 1: SADECE HAM DRIFTLERİ ÇEK (SQL'İ YORMADAN) ---
    const driftValues = activeCodes.map(c => `('${c.market}', '${c.side}')`).join(', ');

    console.log(`\n1. Aşama: driftQuery çalıştırılıyor...`);
    const driftRows = (await sql.unsafe(`
      SELECT mo.event_id, mo.market, mo.selection, mo.odds, mo.opening
      FROM ${MATCH_ODDS_TABLE} mo
      JOIN (VALUES ${driftValues}) AS c(market, selection)
        ON mo.market = c.market AND mo.selection = c.selection
      WHERE mo.bookmaker = $1
        AND mo.opening IS NOT NULL AND mo.opening != 0
    `, [bookmaker] as never[])) as { event_id: string, market: string, selection: string, odds: number, opening: number }[];

    // --- AŞAMA 2: NODE.JS'DE FİLTRELEME VE MAX HESAPLAMA ---
    const driftByEvent = new Map<string, Map<string, number>>();
    for (const r of driftRows) {
      if (r.event_id === eventId) continue; // != koşulunu JS'ye aldık
      
      const drift = (r.odds - r.opening) / r.opening;
      const key = `${r.market}\0${r.selection}`;
      
      let m = driftByEvent.get(r.event_id);
      if (!m) {
        m = new Map();
        driftByEvent.set(r.event_id, m);
      }
      
      // SQL'deki MAX() işleminin JS karşılığı
      const existingDrift = m.get(key);
      if (existingDrift === undefined || drift > existingDrift) {
        m.set(key, drift);
      }
    }

    const validCandidateIds: string[] = [];
    for (const [evId, drifts] of driftByEvent.entries()) {
      if (drifts.size >= minRequiredCodes) {
        validCandidateIds.push(evId);
      }
    }

    console.log(`2. Aşama: Barajı geçen maç sayısı: ${validCandidateIds.length}`);
    if (!validCandidateIds.length) return console.log("Eşleşen aday bulunamadı.");

    // --- AŞAMA 3: CHUNK HALİNDE SPREAD ÇEKME ---
    console.log(`3. Aşama: spreadQuery chunk'lar halinde çalıştırılıyor...`);
    const spreadByEvent = new Map<string, Map<string, number>>();
    const chunkSize = 100; // IN array'i çok büyüyüp veritabanını bozmasın diye 100'e çektik
    
    for (let i = 0; i < validCandidateIds.length; i += chunkSize) {
      const chunk = validCandidateIds.slice(i, i + chunkSize);
      const spreadRows = (await sql.unsafe(`
        SELECT mo.event_id, mo.market, mo.selection, STDDEV(mo.odds::float) AS spread
        FROM ${MATCH_ODDS_TABLE} mo
        JOIN (VALUES ${driftValues}) AS c(market, selection)
          ON mo.market = c.market AND mo.selection = c.selection
        WHERE mo.event_id = ANY($1::text[])
        GROUP BY mo.event_id, mo.market, mo.selection
      `, [chunk] as never[])) as { event_id: string, market: string, selection: string, spread: number | null }[];

      for (const r of spreadRows) {
        if (r.spread == null) continue;
        let m = spreadByEvent.get(r.event_id);
        if (!m) {
          m = new Map();
          spreadByEvent.set(r.event_id, m);
        }
        m.set(`${r.market}\0${r.selection}`, r.spread);
      }
    }

    // --- AŞAMA 4: SKOR HESAPLAMA ---
    const groupCounts = new Map<string, number>();
    for (const c of activeCodes) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1);

    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    const scored: { event_id: string; score: number }[] = [];

    for (const evId of validCandidateIds) {
      const drifts = driftByEvent.get(evId);
      const spreads = spreadByEvent.get(evId);
      if (!drifts || !spreads) continue;

      let sum = 0;
      let matchedWeight = 0;
      let matchedCodesCount = 0;

      for (const c of activeCodes) {
        const key = `${c.market}\0${c.side}`;
        const drift = drifts.get(key);
        const spread = spreads.get(key);
        
        if (drift == null || spread == null) continue;

        const stats = STATS[c.code];
        const [medDrift, madDrift] = stats.mean_drift_pct;
        const [medSpread, madSpread] = stats.spread_close;
        const groupWeight = WEIGHTS[c.group] ?? 1;
        const wPerCode = groupWeight / (groupCounts.get(c.group) ?? 1);

        const zDrift = clamp((drift - medDrift) / (madDrift || 1), -6, 6);
        const zSpread = clamp((spread - medSpread) / (madSpread || 1), -6, 6);
        
        sum += wPerCode * (zDrift * zDrift + zSpread * zSpread);
        matchedWeight += wPerCode;
        matchedCodesCount++;
      }

      if (matchedCodesCount >= minRequiredCodes) {
        const score = sum / matchedWeight;
        if (score < SIMILARITY_THRESHOLD) scored.push({ event_id: evId, score });
      }
    }

    scored.sort((a, b) => a.score - b.score);
    const ms = Date.now() - t0;

    console.log(`\n=== BAŞARILI (${ms}ms) ===`);
    console.log("Geçerli Eşleşme Sayısı:", scored.length);
    if (scored.length > 0) console.log("Örnekler (İlk 10):", scored.slice(0, 10));

  } catch (err) {
    console.error("\n=== SİSTEM HATASI ===");
    console.error(err);
  } finally {
    const { sql } = await import("@/lib/db");
    await sql.end();
  }
}

main();
