/**
 * Smart Analysis archive — season .json.gz loaded server-side only.
 * Source: private GitHub repo (GITHUB_TOKEN) or local SEASON_ODDS_DIR override.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { gunzip } from "zlib";
import { promisify } from "util";
import { join } from "path";
import type { CompactOddsRow } from "@/lib/fixtures";

const gunzipAsync = promisify(gunzip);

export type SeasonGzMatch = {
  id: string;
  matchId: string;
  seasonSlug: string;
  competition: string;
  home: string;
  away: string;
  kickoffAt: string | null;
  homeScore: number;
  awayScore: number;
  homeHtScore: number | null;
  awayHtScore: number | null;
  odds: CompactOddsRow[];
  bookmakers: Record<string, string>;
};

export type GzWarmStatus = {
  status: "idle" | "loading" | "ready" | "error";
  phase: "idle" | "listing" | "downloading";
  files: number;
  filesDone: number;
  matches: number;
  error?: string;
  startedAt?: number;
  readyAt?: number;
};

type RemoteGzFile = {
  name: string;
  downloadUrl: string;
  seasonKey: string;
  stamp: number;
};

type GzBag = {
  status: GzWarmStatus["status"];
  phase: GzWarmStatus["phase"];
  files: string[];
  filesDone: number;
  matches: SeasonGzMatch[];
  error?: string;
  startedAt?: number;
  readyAt?: number;
  promise?: Promise<void>;
};

const CACHE_VERSION = 4;
const DEFAULT_REPO = "19gs05bcs-oss/listener";
const DEFAULT_BRANCH = "main";
const DEFAULT_PREFIX = "data/season_odds";
const DOWNLOAD_DELAY_MS = 120;
const DOWNLOAD_RETRIES = 3;

function globalStore(): { bag: GzBag } {
  const g = globalThis as unknown as { __seasonGzCache?: { bag: GzBag; version?: number } };
  if (!g.__seasonGzCache || g.__seasonGzCache.version !== CACHE_VERSION) {
    g.__seasonGzCache = {
      version: CACHE_VERSION,
      bag: {
        status: "idle",
        phase: "idle",
        files: [],
        filesDone: 0,
        matches: [],
      },
    };
  }
  return g.__seasonGzCache;
}

function githubConfig() {
  const repo = (
    process.env.GIT_SEASON_REPO ||
    process.env.GITHUB_SEASON_REPO ||
    DEFAULT_REPO
  ).trim();
  const branch = (
    process.env.GIT_SEASON_BRANCH ||
    process.env.GITHUB_SEASON_BRANCH ||
    DEFAULT_BRANCH
  ).trim();
  const prefix = (
    process.env.GIT_SEASON_PATH ||
    process.env.GITHUB_SEASON_PATH ||
    DEFAULT_PREFIX
  ).replace(/\/$/, "");
  const [owner, name] = repo.split("/");
  return {
    owner,
    name,
    branch,
    prefix,
    rawBase: `https://raw.githubusercontent.com/${repo}/${branch}/${prefix}`,
  };
}

function readGitHubToken(): string {
  return (
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GT_TOKEN?.trim() ||
    process.env.GT_GITHUB_TOKEN?.trim() ||
    ""
  );
}

function githubAuthHeaders(): Record<string, string> {
  const token = readGitHubToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "odds-intel-smart-analysis",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function kickoffIso(ts: unknown): string | null {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function competitionLabel(slug: string): string {
  const parts = slug.split("/");
  if (parts.length < 2) return slug;
  const league = parts[1]
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const country = parts[0].replace(/\b\w/g, (c) => c.toUpperCase());
  return `${country}: ${league}`;
}

export function resolveSeasonOddsDir(): string | null {
  const env = process.env.SEASON_ODDS_DIR?.trim();
  if (!env) return null;
  return existsSync(env) ? env : env;
}

function listLocalGzFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json.gz") || f.endsWith(".gz"))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function seasonKeyFromFilename(name: string): string {
  const m = /^(.+)_\d{8}_\d{6}\.json\.gz$/i.exec(name);
  return m ? m[1] : name.replace(/\.json\.gz$|\.gz$/i, "");
}

function stampFromFilename(name: string): number {
  const m = /_(\d{8})_(\d{6})\.json\.gz$/i.exec(name);
  if (!m) return 0;
  return Number(m[1] + m[2]);
}

function dedupeRemoteFiles(files: RemoteGzFile[]): RemoteGzFile[] {
  const best = new Map<string, RemoteGzFile>();
  for (const f of files) {
    const prev = best.get(f.seasonKey);
    if (!prev || f.stamp > prev.stamp) best.set(f.seasonKey, f);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function dedupeLocalPaths(paths: string[]): string[] {
  const best = new Map<string, { path: string; stamp: number }>();
  for (const path of paths) {
    const name = path.split("/").pop() || path;
    const key = seasonKeyFromFilename(name);
    const stamp = stampFromFilename(name);
    const prev = best.get(key);
    if (!prev || stamp > prev.stamp) best.set(key, { path, stamp });
  }
  return [...best.values()].map((x) => x.path);
}

function parseScore(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function parseGzBuffer(buf: Buffer, seasonSlugGuess: string): Promise<SeasonGzMatch[]> {
  const raw = await gunzipAsync(buf);
  const data = JSON.parse(raw.toString("utf-8")) as {
    league_slug?: string;
    bookmakers?: Record<string, string>;
    matches?: Array<Record<string, unknown>>;
  };
  const slug = data.league_slug || seasonSlugGuess;
  const bms = data.bookmakers || {};
  const out: SeasonGzMatch[] = [];

  for (const m of data.matches || []) {
    const hs = parseScore(m.home_score);
    const as = parseScore(m.away_score);
    if (hs == null || as == null) continue;
    const odds = (m.odds as CompactOddsRow[]) || [];
    if (!odds.length) continue;
    const mid = String(m.match_id || "");
    if (!mid) continue;
    out.push({
      id: `flashscore:${mid}`,
      matchId: mid,
      seasonSlug: slug,
      competition: competitionLabel(slug),
      home: String(m.home_name || "Home"),
      away: String(m.away_name || "Away"),
      kickoffAt: kickoffIso(m.kickoff_ts),
      homeScore: hs,
      awayScore: as,
      homeHtScore: parseScore(m.home_ht_score),
      awayHtScore: parseScore(m.away_ht_score),
      odds,
      bookmakers: bms,
    });
  }
  return out;
}

async function loadLocalGz(path: string): Promise<SeasonGzMatch[]> {
  const name = path.split("/").pop() || path;
  const slugGuess = seasonKeyFromFilename(name).replace(/_/g, "/");
  return parseGzBuffer(readFileSync(path), slugGuess);
}

async function listGitHubGzFiles(): Promise<RemoteGzFile[]> {
  const cfg = githubConfig();
  const res = await fetchWithTimeout(
    `https://api.github.com/repos/${cfg.owner}/${cfg.name}/git/trees/${cfg.branch}?recursive=1`,
    { headers: githubAuthHeaders(), cache: "no-store" },
    60_000,
  );
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " Repo private ise sunucuda GT_TOKEN (veya GITHUB_TOKEN) tanımlayın."
        : res.status === 403
          ? " GitHub rate limit — GT_TOKEN ekleyin."
          : "";
    throw new Error(`Sezon listesi alınamadı (${res.status}).${hint}`);
  }
  const body = (await res.json()) as { tree?: Array<{ path?: string; type?: string }> };
  const prefix = `${cfg.prefix}/`;
  const out: RemoteGzFile[] = [];
  for (const node of body.tree || []) {
    if (node.type !== "blob" || !node.path?.startsWith(prefix)) continue;
    if (!node.path.endsWith(".json.gz")) continue;
    const name = node.path.slice(prefix.length);
    out.push({
      name,
      downloadUrl: `${cfg.rawBase}/${name}`,
      seasonKey: seasonKeyFromFilename(name),
      stamp: stampFromFilename(name),
    });
  }
  if (!out.length) throw new Error("Arşivde sezon dosyası bulunamadı.");
  return dedupeRemoteFiles(out);
}

async function downloadGz(file: RemoteGzFile): Promise<Buffer> {
  const cfg = githubConfig();
  const path = `${cfg.prefix}/${file.name}`;
  const url =
    `https://api.github.com/repos/${cfg.owner}/${cfg.name}/contents/${path}` +
    `?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: { ...githubAuthHeaders(), Accept: "application/vnd.github.raw" },
      cache: "no-store",
    },
    120_000,
  );
  if (!res.ok) throw new Error(`Dosya indirilemedi (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadGzWithRetry(file: RemoteGzFile): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      if (attempt > 1) await sleep(800 * attempt);
      return await downloadGz(file);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function warmFromGitHub(bag: GzBag): Promise<void> {
  bag.phase = "listing";
  const remote = await listGitHubGzFiles();
  bag.files = remote.map((f) => f.name);
  bag.phase = "downloading";

  for (const file of remote) {
    try {
      const buf = await downloadGzWithRetry(file);
      const slugGuess = file.seasonKey.replace(/_/g, "/");
      const batch = await parseGzBuffer(buf, slugGuess);
      bag.matches.push(...batch);
    } catch (e) {
      console.error("[seasonGzCache] skip", file.name, e);
    } finally {
      bag.filesDone += 1;
    }
    await sleep(DOWNLOAD_DELAY_MS);
  }

  if (!bag.matches.length) {
    throw new Error("Arşivden hiç bitmiş maç yüklenemedi.");
  }
}

async function warmFromLocal(bag: GzBag, dir: string): Promise<void> {
  bag.phase = "listing";
  const files = dedupeLocalPaths(listLocalGzFiles(dir));
  bag.files = files;
  if (!files.length) throw new Error(`Klasörde .json.gz yok: ${dir}`);
  bag.phase = "downloading";

  for (const path of files) {
    bag.matches.push(...(await loadLocalGz(path)));
    bag.filesDone += 1;
  }
}

async function runWarm(): Promise<void> {
  const { bag } = globalStore();
  bag.status = "loading";
  bag.phase = "listing";
  bag.startedAt = Date.now();
  bag.error = undefined;
  bag.matches = [];
  bag.filesDone = 0;
  bag.files = [];

  const localDir = resolveSeasonOddsDir();
  const useLocal = Boolean(localDir && existsSync(localDir) && listLocalGzFiles(localDir).length > 0);

  try {
    if (useLocal && localDir) {
      await warmFromLocal(bag, localDir);
    } else {
      await warmFromGitHub(bag);
    }
    bag.status = "ready";
    bag.phase = "idle";
    bag.readyAt = Date.now();
  } catch (e) {
    bag.status = "error";
    bag.phase = "idle";
    bag.error = e instanceof Error ? e.message : String(e);
  }
}

export function startSeasonGzWarm(): GzWarmStatus {
  const { bag } = globalStore();
  if (bag.status === "ready") return getSeasonGzStatus();
  if (bag.status === "loading" && bag.promise) return getSeasonGzStatus();
  if (bag.status === "error") {
    bag.status = "idle";
    bag.promise = undefined;
  }
  bag.promise = runWarm();
  return getSeasonGzStatus();
}

export function getSeasonGzStatus(): GzWarmStatus {
  const { bag } = globalStore();
  return {
    status: bag.status,
    phase: bag.phase,
    files: bag.files.length,
    filesDone: bag.filesDone,
    matches: bag.matches.length,
    error: bag.error,
    startedAt: bag.startedAt,
    readyAt: bag.readyAt,
  };
}

export async function ensureSeasonGzCache(waitMs = 600_000): Promise<{
  matches: SeasonGzMatch[];
  status: GzWarmStatus;
}> {
  const { bag } = globalStore();
  if (bag.status !== "ready" && bag.status !== "loading") {
    startSeasonGzWarm();
  }
  if (bag.status === "loading" && bag.promise) {
    await Promise.race([bag.promise, new Promise<void>((r) => setTimeout(r, waitMs))]);
  }
  return { matches: bag.matches, status: getSeasonGzStatus() };
}
