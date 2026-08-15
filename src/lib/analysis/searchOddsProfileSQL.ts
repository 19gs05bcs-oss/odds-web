/**
 * searchOddsProfile'ın DuckDB tabanlı eşdeğeri.
 *
 * Eskisi (profile.ts + events.ts ensureArchiveCache): 24 sezonun TÜM
 * markets_json'ı Node process belleğine parse edilip diziye çevriliyor,
 * her arama bu dizide Array.filter ile geziniyordu — ve bu dizi
 * globalThis'te KALICI olarak duruyordu (RAM'in asıl kaynağı).
 *
 * Bu dosya: her kriter için events.markets_json'ı DuckDB JSON
 * fonksiyonlarıyla (json_extract/json_keys/UNNEST) doğrudan quote
 * satırlarına açıp (bkz. duckdbQuotes.ts) event_id üzerinden JOIN ediyor —
 * yani "N kriterin AND'i" işini DuckDB'nin vectorized execution'ına
 * devrediyor, Node RAM'inde hiçbir şey tutmuyor. Şema değişikliği YOK —
 * hâlâ events.markets_json okunuyor, ayrı bir quotes tablosu gerekmiyor.
 *
 * SQL filtresi kasıtlı olarak biraz gevşek (side için prefix/OR eşleşmesi) —
 * sonuç seti (yüzlerce satır) üzerinde profile.ts'teki BİREBİR AYNI
 * `quoteMatchesCriterion` fonksiyonu ile kesin doğrulama yapılıyor. Böylece
 * davranış eskisiyle bit-bit aynı kalır.
 */
import { getDuckDbConnection } from "@/lib/duckdb";
import { buildFlatQuoteCandidateCte, EVENT_META_SELECT } from "./duckdbQuotes";
import { ensureQuotesTable, QUOTES_FLAT_TABLE } from "./duckdbMaterialize";
import { prettySideName } from "./labels";
import {
  quoteMatchesCriterion,
  type OddsCriterion,
  type ProfileMatch,
  type ProfileQuery,
  type ProfileResult,
  type CriterionHit,
} from "./profile";
import type { Quote } from "./types";
import { sql } from "@/lib/db";

type DuckRow = Record<string, unknown>;

let bmNamesCache: { at: number; map: Map<string, string> } | null = null;
const BM_NAMES_TTL_MS = 10 * 60_000;

/** listBookmakers'daki mantığın küçük bir kopyası — fixtures.ts'e circular import olmasın diye. */
async function loadBookmakerNames(): Promise<Map<string, string>> {
  if (bmNamesCache && Date.now() - bmNamesCache.at < BM_NAMES_TTL_MS) {
    return bmNamesCache.map;
  }
  const map = new Map<string, string>();
  try {
    const rows = await sql.unsafe<{ bookmakers: Record<string, string> | null }[]>(
      "SELECT bookmakers FROM fixture WHERE bookmakers IS NOT NULL LIMIT 30",
    );
    for (const row of rows) {
      const bms = row.bookmakers;
      if (!bms || typeof bms !== "object") continue;
      for (const [id, name] of Object.entries(bms)) {
        if (id && !map.has(id)) map.set(id, String(name || id));
      }
    }
  } catch {
    // isim çözemezsek id'yi gösteririz — kritik değil
  }
  bmNamesCache = { at: Date.now(), map };
  return map;
}

type SqlBuild = { text: string; params: unknown[] };

function buildQuery(query: ProfileQuery, fetchLimit: number): SqlBuild | null {
  const criteria = query.criteria.filter((c) => c.targetOdds > 1);
  if (!criteria.length) return null;

  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const tol = query.tolerance != null && query.tolerance >= 0 ? query.tolerance : 0;
  const bm = query.bookmakerId || null;
  const seasons = (query.seasonSlugs ?? []).filter(Boolean);

  const ctes = criteria.map((c, i) => {
    const effTol = tol > 0 ? tol : 0.005;
    return buildFlatQuoteCandidateCte(
      `q${i}`,
      {
        marketType: c.marketType,
        marketScope: c.marketScope || "FULL_TIME",
        side: c.side,
        oddsRange: [c.targetOdds - effTol, c.targetOdds + effTol],
        price: c.price,
        bookmakerId: bm,
        seasonSlugs: seasons,
      },
      push,
      QUOTES_FLAT_TABLE,
    );
  });

  const joinCols = criteria
    .map(
      (_, i) =>
        `q${i}.side AS c${i}_side, q${i}.opening AS c${i}_opening, q${i}.current AS c${i}_closing, q${i}.bookmaker_id AS c${i}_bookmaker_id`,
    )
    .join(",\n      ");

  const joins = criteria
    .slice(1)
    .map((_, idx) => `JOIN q${idx + 1} ON q${idx + 1}.event_id = q0.event_id`)
    .join("\n      ");

  let seasonCond = "";
  if (seasons.length) {
    const phs = seasons.map((s) => push(s));
    seasonCond = `AND e.season_slug IN (${phs.join(", ")})`;
  }

  const limitPh = push(fetchLimit);

  const text = `
    WITH ${ctes.join(",\n")}
    , joined AS (
      SELECT q0.event_id,
      ${joinCols}
      FROM q0
      ${joins}
    )
    SELECT
      ${EVENT_META_SELECT},
      j.* EXCLUDE (event_id)
    FROM joined j
    JOIN pg.events e ON e.id = j.event_id
    WHERE e.source = 'flashscore'
      ${seasonCond}
    LIMIT ${limitPh}
  `;

  return { text, params };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** DuckDB (Postgres attach) üzerinden çok kriterli profile araması. */
export async function searchOddsProfileSQL(query: ProfileQuery): Promise<ProfileResult> {
  const t0 = Date.now();
  const criteria = query.criteria.filter((c) => c.targetOdds > 1);
  const tol = query.tolerance != null && query.tolerance >= 0 ? query.tolerance : 0;
  const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 500) : 200;
  const bm = query.bookmakerId || null;

  if (!criteria.length) {
    return { matches: [], totalMatched: 0, truncated: false, tookMs: 0, criteria };
  }

  const materializeStatus = await ensureQuotesTable();
  if (materializeStatus.status !== "ready") {
    throw new Error(
      `quotes_flat tablosu hazır değil (status=${materializeStatus.status}${
        materializeStatus.error ? `, error=${materializeStatus.error}` : ""
      }) — DuckDB path henüz kullanılamıyor.`,
    );
  }

  // JS tarafında kesin doğrulamada bir kısmı elenecek — biraz fazla çek.
  const fetchLimit = Math.min(Math.max(limit * 4, 400), 3000);
  const built = buildQuery(query, fetchLimit);
  if (!built) {
    return { matches: [], totalMatched: 0, truncated: false, tookMs: 0, criteria };
  }

  const conn = await getDuckDbConnection();
  const reader = await conn.runAndReadAll(built.text, built.params as never[]);
  const rows = reader.getRowObjectsJS() as DuckRow[];
  const bmNames = await loadBookmakerNames();

  const matches: ProfileMatch[] = [];
  for (const row of rows) {
    const hits: (CriterionHit | null)[] = new Array(criteria.length).fill(null);
    let ok = true;

    for (let i = 0; i < criteria.length; i++) {
      const c = criteria[i];
      const side = row[`c${i}_side`] as string | null;
      const opening = num(row[`c${i}_opening`]);
      const closing = num(row[`c${i}_closing`]);
      const bookmakerIdRaw = row[`c${i}_bookmaker_id`];
      const bookmakerId = bookmakerIdRaw != null ? String(bookmakerIdRaw) : null;

      if (!side || (opening == null && closing == null)) {
        ok = false;
        break;
      }

      // profile.ts'teki BİREBİR AYNI fonksiyon — SQL'in kaba filtresini kesinleştirir.
      const fakeQuote: Quote = {
        eventId: String(row.event_id),
        sourceEventId: String(row.source_event_id ?? ""),
        competition: (row.competition as string) ?? null,
        seasonSlug: (row.season_slug as string) ?? null,
        round: (row.round as string) ?? null,
        homeTeam: (row.home_team as string) ?? null,
        awayTeam: (row.away_team as string) ?? null,
        kickoffAt: (row.kickoff_at as string) ?? null,
        homeScore: num(row.home_score),
        awayScore: num(row.away_score),
        homeHtScore: num(row.home_ht_score),
        awayHtScore: num(row.away_ht_score),
        marketType: c.marketType,
        marketScope: c.marketScope,
        marketKey: `${c.marketType}:${c.marketScope}`,
        marketName: c.marketType,
        line: null,
        side,
        sideName: "",
        opening,
        closing,
        bookmakerId,
        bookmakerName: bookmakerId ? bmNames.get(bookmakerId) ?? null : null,
        suspended: false,
      };

      if (!quoteMatchesCriterion(fakeQuote, c, tol, bm)) {
        ok = false;
        break;
      }

      hits[i] = {
        marketType: c.marketType,
        marketScope: c.marketScope,
        side,
        sideName: prettySideName(side, null, c.marketType),
        line: c.line ?? null,
        targetOdds: c.targetOdds,
        closing,
        opening,
        bookmakerId,
        bookmakerName: fakeQuote.bookmakerName,
      };
    }

    if (!ok) continue;

    matches.push({
      eventId: String(row.event_id),
      sourceEventId: String(row.source_event_id ?? ""),
      competition: (row.competition as string) ?? null,
      seasonSlug: (row.season_slug as string) ?? null,
      round: (row.round as string) ?? null,
      homeTeam: (row.home_team as string) ?? null,
      awayTeam: (row.away_team as string) ?? null,
      kickoffAt: (row.kickoff_at as string) ?? null,
      score:
        row.home_score != null && row.away_score != null
          ? `${row.home_score}-${row.away_score}`
          : null,
      htScore:
        row.home_ht_score != null && row.away_ht_score != null
          ? `${row.home_ht_score}-${row.away_ht_score}`
          : null,
      hits: hits as CriterionHit[],
    });
  }

  matches.sort((a, b) => {
    const aa = a.hits[0]?.closing ?? a.hits[0]?.opening ?? 0;
    const bb = b.hits[0]?.closing ?? b.hits[0]?.opening ?? 0;
    const da = Math.abs(aa - criteria[0].targetOdds);
    const db = Math.abs(bb - criteria[0].targetOdds);
    return da - db;
  });

  const truncated = matches.length > limit || rows.length >= fetchLimit;

  return {
    matches: matches.slice(0, limit),
    totalMatched: matches.length,
    truncated,
    tookMs: Date.now() - t0,
    criteria,
    scannedSeasons: { capped: true, count: materializeStatus.seasons },
  };
}
