/**
 * /api/analyze için sayfalama + sunucu tarafı filtre + kısa ömürlü önbellek.
 *
 * Akış:
 *  1) Arama tüm eşleşmeleri (güvenlik tavanına kadar) bir kez bulur → önbelleğe alınır.
 *  2) Sayfa değiştirme / tablo filtresi değiştirme aynı önbellekten çalışır
 *     (veritabanına yeniden gitmez, günlük arama hakkı da harcanmaz).
 *  3) Filtreler TÜM eşleşmelere uygulanır (yalnızca görünen sayfaya değil).
 *     - Meta filtreler (takım, lig, skor, tarih...): bellekte, anında.
 *     - Oran filtreleri (market sütunları): maçlar gruplar hâlinde okunup uygulanır.
 */
import { createHash } from "node:crypto";
import type { ProfileMatch, ProfileQuery } from "@/lib/analysis/profile";
import { ALL_COLUMNS } from "@/lib/analysis/tableColumns";
import {
  filterTableRows,
  profileMatchToTableRow,
  type TableRow,
} from "@/lib/analysis/tableRows";

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 100;
/** Oran filtresi uygulanırken en fazla bu kadar maç taranır (DB koruması). */
export const MAX_ODDS_FILTER_SCAN = 6000;
const ODDS_FILTER_BATCH = 400;
const CACHE_TTL_MS = 15 * 60 * 1000;

/* ---------------------------------- cache ---------------------------------- */

class TtlLru<T> {
  private map = new Map<string, { v: T; exp: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}
  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU: en sona taşı
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  set(key: string, v: T): void {
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export type CachedSearch = {
  matches: ProfileMatch[];
  capped: boolean;
  tookMs: number;
  preferredBm: string;
};

export type CachedFilter = { ids: string[]; scanCapped: boolean };

type Caches = {
  search: TtlLru<CachedSearch>;
  filter: TtlLru<CachedFilter>;
};

const g = globalThis as unknown as { __analyzeCaches?: Caches };
const caches: Caches =
  g.__analyzeCaches ??
  (g.__analyzeCaches = {
    // ~30k maç × ~0.6KB ≈ 18MB/giriş → en fazla 8 giriş
    search: new TtlLru<CachedSearch>(8, CACHE_TTL_MS),
    filter: new TtlLru<CachedFilter>(32, CACHE_TTL_MS),
  });

export const searchCache = caches.search;
export const filterCache = caches.filter;

function sha(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 24);
}

/** Kullanıcıya özel arama anahtarı: kriterler + bookmaker + tolerans + sezonlar. */
export function searchCacheKey(userId: string, q: ProfileQuery): string {
  const norm = {
    c: q.criteria.map((c) => [
      c.marketType,
      c.marketScope,
      c.side,
      c.line ?? null,
      c.targetOdds,
      c.price ?? null,
    ]),
    b: q.bookmakerId ?? null,
    t: q.tolerance ?? 0,
    s: [...(q.seasonSlugs ?? [])].sort(),
  };
  return `${userId}:${sha(JSON.stringify(norm))}`;
}

/* --------------------------------- filters ---------------------------------- */

export type TableFilters = Record<string, string>;

const MAX_FILTERS = 30;
const MAX_FILTER_LEN = 40;

/** İstemciden gelen filtre nesnesini temizler (tip, uzunluk, anahtar biçimi). */
export function sanitizeFilters(raw: unknown): TableFilters {
  const out: TableFilters = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_FILTERS) break;
    if (typeof v !== "string") continue;
    if (!/^[A-Za-z0-9_]{1,60}$/.test(k)) continue;
    const val = v.trim().slice(0, MAX_FILTER_LEN);
    if (!val) continue;
    out[k] = val;
    n++;
  }
  return out;
}

export function filtersKey(f: TableFilters): string {
  const keys = Object.keys(f).sort();
  return keys.length ? sha(JSON.stringify(keys.map((k) => [k, f[k]]))) : "";
}

const MARKET_COL_IDS = new Set(
  ALL_COLUMNS.filter((c) => c.kind === "market").map((c) => c.id),
);

/** ms_1__o / ms_1__c ya da market sütunu kimliği → oran filtresi. */
function isOddsFilterKey(key: string): boolean {
  const m = /^(.*)__(o|c)$/.exec(key);
  const base = m ? m[1] : key;
  return MARKET_COL_IDS.has(base);
}

export function splitFilters(f: TableFilters): { meta: TableFilters; odds: TableFilters } {
  const meta: TableFilters = {};
  const odds: TableFilters = {};
  for (const [k, v] of Object.entries(f)) {
    if (isOddsFilterKey(k)) odds[k] = v;
    else meta[k] = v;
  }
  return { meta, odds };
}

export type BuildRowsFn = (matches: ProfileMatch[]) => Promise<TableRow[]>;

/**
 * Filtreleri TÜM eşleşmelere uygular; geçen maçların sıralı event id listesini döner.
 * buildRows yalnızca oran filtresi varsa çağrılır (maç grubu → tam tablo satırları).
 */
export async function applyFiltersToMatches(
  matches: ProfileMatch[],
  filters: TableFilters,
  buildRows: BuildRowsFn,
): Promise<CachedFilter> {
  const { meta, odds } = splitFilters(filters);
  let pool = matches;

  if (Object.keys(meta).length) {
    const next: ProfileMatch[] = [];
    const CH = 2000;
    for (let i = 0; i < pool.length; i += CH) {
      const slice = pool.slice(i, i + CH);
      const rows = slice.map((m) => profileMatchToTableRow(m));
      const passed = new Set(filterTableRows(rows, meta, ALL_COLUMNS));
      slice.forEach((m, idx) => {
        if (passed.has(rows[idx])) next.push(m);
      });
    }
    pool = next;
  }

  let scanCapped = false;
  if (Object.keys(odds).length) {
    if (pool.length > MAX_ODDS_FILTER_SCAN) {
      pool = pool.slice(0, MAX_ODDS_FILTER_SCAN);
      scanCapped = true;
    }
    const next: ProfileMatch[] = [];
    for (let i = 0; i < pool.length; i += ODDS_FILTER_BATCH) {
      const slice = pool.slice(i, i + ODDS_FILTER_BATCH);
      const rows = await buildRows(slice); // slice ile aynı sırada
      const passed = new Set(filterTableRows(rows, odds, ALL_COLUMNS));
      slice.forEach((m, idx) => {
        if (rows[idx] && passed.has(rows[idx])) next.push(m);
      });
    }
    pool = next;
  }

  return { ids: pool.map((m) => m.eventId), scanCapped };
}

/* ---------------------------------- paging ---------------------------------- */

export function clampPage(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : 1;
}

export function clampPageSize(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return PAGE_SIZE_DEFAULT;
  return Math.min(n, PAGE_SIZE_MAX);
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
