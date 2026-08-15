/**
 * Koyeb worker'daki archive_cache_server.py'ye (watcher.py içinde gömülü
 * HTTP servis) istemci. Railway'in RAM'i sınırlı — 283 sezonu burada
 * belleğe almak yerine, ağır tarama/hesaplama işini Koyeb'e devrediyoruz;
 * buradan sadece küçük, zaten-hesaplanmış JSON sonuçları dönüyor.
 *
 * Env:
 *   KOYEB_CACHE_URL   — örn: https://<app>-<org>.koyeb.app  (watcher.py'nin PORT'u)
 *   CACHE_API_TOKEN   — watcher.py'deki CACHE_API_TOKEN ile AYNI değer
 */

const BASE_URL = (process.env.KOYEB_CACHE_URL || "").replace(/\/+$/, "");
const AUTH_TOKEN = process.env.CACHE_API_TOKEN || "";

function assertConfigured(): void {
  if (!BASE_URL) {
    throw new Error(
      "KOYEB_CACHE_URL tanımlı değil — Koyeb worker'daki archive_cache_server.py'nin " +
        "public URL'ini Railway env'ine ekle (ör. https://xxxx.koyeb.app).",
    );
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (AUTH_TOKEN) h.Authorization = `Bearer ${AUTH_TOKEN}`;
  return h;
}

async function getJson<T>(path: string, timeoutMs = 20_000): Promise<T> {
  assertConfigured();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: authHeaders({ "Accept-Encoding": "gzip" }),
      signal: ctrl.signal,
      // Next.js fetch cache'i devre dışı — bu veriler sık değişir / büyük
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Koyeb cache ${path} -> ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function postJson<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  assertConfigured();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Koyeb cache ${path} -> ${res.status}: ${errBody.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export function koyebCacheConfigured(): boolean {
  return Boolean(BASE_URL);
}

export type KoyebSeasonMeta = {
  id: string;
  source: string;
  competition: string | null;
  season_label: string | null;
  template_id: string | null;
  season_code: string | null;
  match_count: number | null;
  bookmaker_count: number | null;
  updated_at: string | null;
};

export async function fetchKoyebSeasonsMeta(): Promise<KoyebSeasonMeta[]> {
  const data = await getJson<{ ok: boolean; seasons: KoyebSeasonMeta[] }>("/seasons");
  return data.seasons || [];
}

/** /archive/season/{slug} — events (markets_json dahil) tek sezon. */
export async function fetchKoyebArchiveSeason(seasonSlug: string): Promise<{
  season: string;
  events: Record<string, unknown>[];
}> {
  const data = await getJson<{ ok: boolean; season: string; events: Record<string, unknown>[] }>(
    `/archive/season/${encodeURIComponent(seasonSlug)}`,
    45_000,
  );
  return { season: data.season, events: data.events || [] };
}

/** /archive/event/{id} — tekil event (markets_json dahil). Cache'te yoksa
 * sunucu tek satir olarak REST'ten cekip doner (bkz. ArchiveCacheServer.get_event). */
export async function fetchKoyebEvent(eventId: string): Promise<Record<string, unknown> | null> {
  try {
    const data = await getJson<{ ok: boolean; event?: Record<string, unknown>; error?: string }>(
      `/archive/event/${encodeURIComponent(eventId)}`,
      20_000,
    );
    return data.event ?? null;
  } catch (err) {
    // Sunucu 404'te "not found" hatasi doner — bunu exception degil, null olarak ele al.
    if (err instanceof Error && /-> 404\b/.test(err.message)) return null;
    throw err;
  }
}

/** /quotes/season/{slug} — flat quotes (markets_json UNNEST gerekmez). */
export async function fetchKoyebQuotesSeason(seasonSlug: string): Promise<{
  season: string;
  quotes: Record<string, unknown>[];
}> {
  const data = await getJson<{ ok: boolean; season: string; quotes: Record<string, unknown>[] }>(
    `/quotes/season/${encodeURIComponent(seasonSlug)}`,
    45_000,
  );
  return { season: data.season, quotes: data.quotes || [] };
}

/**
 * /events/season/{slug} — markets_json'suz hafif event meta (id, takımlar,
 * skor, kickoff, competition/round). quotes_flat materialize adımında
 * flat quotes satırlarını event'e bağlamak için kullanılır — markets_json
 * hiç Node'a inmez.
 */
export type KoyebEventMeta = {
  id: string;
  source_event_id: string | null;
  season_slug: string | null;
  competition: string | null;
  round: string | null;
  home_team: string | null;
  away_team: string | null;
  kickoff_at: string | null;
  home_score: number | string | null;
  away_score: number | string | null;
  home_ht_score: number | string | null;
  away_ht_score: number | string | null;
};

export async function fetchKoyebEventsMetaSeason(seasonSlug: string): Promise<{
  season: string;
  events: KoyebEventMeta[];
}> {
  const data = await getJson<{ ok: boolean; season: string; events: KoyebEventMeta[] }>(
    `/events/season/${encodeURIComponent(seasonSlug)}`,
    45_000,
  );
  return { season: data.season, events: data.events || [] };
}

// ---------------- smart-match/report ----------------

export type SmartMatchReportFixtureInput = {
  match_id: string;
  home_name?: string | null;
  away_name?: string | null;
  kickoff_at?: string | null;
  league?: string | null;
  odds: unknown[];
  bookmakers?: Record<string, string> | null;
  home_id?: string | null;
  away_id?: string | null;
};

/**
 * Koyeb'in 283 sezonu TEK GEÇİŞTE tarayıp hesapladığı "Akıllı Analiz"
 * raporu. Railway hiçbir arşiv verisini belleğe almaz — sadece bu küçük
 * JSON'u alır.
 */
export async function fetchSmartMatchReportFromKoyeb(input: {
  fixture: SmartMatchReportFixtureInput;
  referenceBm?: number;
  tolerancePct?: number;
  /** boş bırakılırsa Koyeb tüm sezonları tarar */
  seasons?: string[];
}): Promise<Record<string, unknown>> {
  const data = await postJson<{ ok: boolean; report?: Record<string, unknown>; error?: string }>(
    "/smart-match/report",
    {
      fixture: input.fixture,
      referenceBm: input.referenceBm,
      tolerancePct: input.tolerancePct,
      seasons: input.seasons,
    },
    // 283 sezon taraması dakikalar sürebilir — Koyeb tarafında maxDuration'a
    // eşdeğer bir kısıt yok (sürekli çalışan worker), ama HTTP timeout'u
    // buna göre cömert tutuyoruz.
    120_000,
  );
  if (!data.ok || !data.report) {
    throw new Error(data.error || "Koyeb smart-match/report başarısız");
  }
  return data.report;
}
