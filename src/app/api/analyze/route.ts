import { NextResponse } from "next/server";
import {
  decodeCriterion,
  type OddsCriterion,
  type ProfileQuery,
} from "@/lib/analysis/profile";
import {
  buildTableRowsForMatches,
  searchProfile,
  searchProfileAll,
} from "@/lib/fixtures";
import { enforceAnalyzeSearchLimits } from "@/lib/auth/enforceSearchLimits";
import {
  applyFiltersToMatches,
  clampPage,
  clampPageSize,
  filterCache,
  filtersKey,
  pageCount,
  sanitizeFilters,
  searchCache,
  searchCacheKey,
  type CachedSearch,
} from "@/lib/analysis/analyzePaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function queryFromSearchParams(sp: URLSearchParams): ProfileQuery {
  const criteria = sp
    .getAll("c")
    .map(decodeCriterion)
    .filter((x): x is OddsCriterion => x != null);
  const tol = Number(sp.get("tol") || "");
  return {
    criteria,
    bookmakerId: sp.get("bookmaker") || null,
    seasonSlugs: [sp.get("seasonSlug"), ...sp.getAll("season")].filter(
      (x): x is string => Boolean(x),
    ),
    tolerance: Number.isFinite(tol) ? tol : 0,
    limit: Number(sp.get("limit") || 200) || 200,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = queryFromSearchParams(url.searchParams);
  if (!query.criteria.length) {
    return NextResponse.json(
      { ok: false, error: "En az bir oran kriteri (c=...) gerekli." },
      { status: 400 },
    );
  }
  const gate = await enforceAnalyzeSearchLimits(query.criteria.length);
  if (!gate.ok) return gate.response;

  const result = await searchProfile(query);
  if (!result.ok) {
    return NextResponse.json(result, { status: result.missingEnv ? 503 : 500 });
  }
  return NextResponse.json({ ok: true, ...result.data });
}

export async function POST(req: Request) {
  let body: {
    criteria?: OddsCriterion[];
    bookmakerId?: string | null;
    seasonSlugs?: string[];
    tolerance?: number;
    /** Sayfa numarası (1'den başlar). */
    page?: number;
    /** Sayfa başına maç (varsayılan 50). */
    pageSize?: number;
    /** Tablo sütun filtreleri — TÜM eşleşmelere uygulanır. */
    filters?: Record<string, string>;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const query: ProfileQuery = {
    criteria: body.criteria || [],
    bookmakerId: body.bookmakerId || null,
    seasonSlugs: body.seasonSlugs || [],
    tolerance: body.tolerance ?? 0,
  };
  if (!query.criteria.length) {
    return NextResponse.json(
      { ok: false, error: "criteria[] gerekli." },
      { status: 400 },
    );
  }
  const page = clampPage(body.page);
  const pageSize = clampPageSize(body.pageSize);
  const filters = sanitizeFilters(body.filters);

  // Önbellekten servis edilen istekler (sayfa değiştirme, filtre) arama hakkı harcamaz;
  // yalnızca yeni (önbellekte olmayan) arama harcar.
  const gate = await enforceAnalyzeSearchLimits(query.criteria.length, {
    consumeQuota: (userId) => !searchCache.get(searchCacheKey(userId, query)),
  });
  if (!gate.ok) return gate.response;

  const cacheKey = searchCacheKey(gate.userId, query);
  let entry: CachedSearch | undefined = searchCache.get(cacheKey);
  if (!entry) {
    const found = await searchProfileAll(query);
    if (!found.ok) {
      return NextResponse.json(found, { status: found.missingEnv ? 503 : 500 });
    }
    entry = {
      matches: found.data.matches,
      capped: found.data.capped,
      tookMs: found.data.tookMs,
      preferredBm: found.data.preferredBm,
    };
    searchCache.set(cacheKey, entry);
  }

  try {
    // Filtreler: tüm eşleşmelere uygulanır, sonuç önbelleğe alınır.
    let matches = entry.matches;
    let scanCapped = false;
    const fKey = filtersKey(filters);
    if (fKey) {
      const fullKey = `${cacheKey}:${fKey}`;
      let f = filterCache.get(fullKey);
      if (!f) {
        const preferredBm = entry.preferredBm;
        f = await applyFiltersToMatches(entry.matches, filters, (ms) =>
          buildTableRowsForMatches(ms, preferredBm),
        );
        filterCache.set(fullKey, f);
      }
      const keep = new Set(f.ids);
      matches = entry.matches.filter((m) => keep.has(m.eventId));
      scanCapped = f.scanCapped;
    }

    const totalMatched = matches.length;
    const pages = pageCount(totalMatched, pageSize);
    const safePage = Math.min(page, pages);
    const slice = matches.slice((safePage - 1) * pageSize, safePage * pageSize);
    const tableRows = await buildTableRowsForMatches(slice, entry.preferredBm);

    return NextResponse.json({
      ok: true,
      matches: slice,
      tableRows,
      totalMatched,
      totalUnfiltered: entry.matches.length,
      page: safePage,
      pageSize,
      pageCount: pages,
      /** Aday satır güvenlik tavanına takıldı: gerçek toplam daha yüksek olabilir. */
      capped: entry.capped,
      /** Oran filtresi çok geniş sette yalnızca ilk kısmı taradı. */
      filterScanCapped: scanCapped,
      truncated: entry.capped,
      tookMs: entry.tookMs,
      criteria: query.criteria,
      cacheStatus: "postgres:match_odds",
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
