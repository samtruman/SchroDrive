import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { config } from "../core/config";
import { parseMediaFilename } from "./mediaParser";
import { searchTmdb } from "./tmdbService";

type ArrMovie = { id?: number; title?: string; tmdbId?: number | string; path?: string };
type ArrSeries = { id?: number; title?: string; tmdbId?: number | string; path?: string };

type Candidate = {
  source: string;
  currentLink: string;
  category: "movie" | "series";
  title?: string;
  year?: number;
  season?: number;
};

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function configured(): boolean {
  return Boolean(
    config.providerReconciliationRadarrUrl && config.providerReconciliationRadarrApiKey ||
    config.providerReconciliationSonarrUrl && config.providerReconciliationSonarrApiKey,
  );
}

async function fetchArr<T>(baseUrl: string, apiKey: string, endpoint: string): Promise<T[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v3/${endpoint}`, {
    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Arr ${endpoint} lookup failed: HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body) ? body as T[] : [];
}

async function walkSymlinks(root: string, out: string[] = []): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const stat = await fsp.lstat(full).catch(() => undefined);
    if (!stat) continue;
    if (stat.isDirectory()) await walkSymlinks(full, out);
    else if (stat.isSymbolicLink()) out.push(full);
  }
  return out;
}

function candidateFor(link: string, organizedBase: string): Candidate | undefined {
  const relative = path.relative(organizedBase, link);
  const parts = relative.split(path.sep);
  const category = parts[0]?.toLowerCase();
  const source = link;
  if (category !== "movies" && category !== "tv" && category !== "anime") return undefined;
  const parsed = parseMediaFilename(path.basename(link), link);
  if (category === "movies") {
    return { source, currentLink: link, category: "movie", title: parsed.title || parts[1]?.replace(/\s*\(\d{4}\)$/, ""), year: parsed.year };
  }
  return {
    source,
    currentLink: link,
    category: "series",
    title: parsed.show || parts[1]?.replace(/\s*\(\d{4}\)$/, ""),
    year: parsed.year,
    season: parsed.season ?? (Number((parts.find((part) => /^Season\s+\d+$/i.test(part)) || "").replace(/\D/g, "")) || undefined),
  };
}

async function resolveTmdbId(candidate: Candidate): Promise<string | undefined> {
  if (!candidate.title) return undefined;
  const result = await searchTmdb(candidate.title, candidate.category === "movie" ? "movie" : "tv", candidate.year, { retries: 1, timeoutMs: 5000 });
  return result.status === "matched" && result.metadata?.tmdbId ? String(result.metadata.tmdbId) : undefined;
}

async function moveSymlink(link: string, destination: string): Promise<boolean> {
  if (path.normalize(link) === path.normalize(destination)) return false;
  const rawSource = await fsp.readlink(link).catch(() => undefined);
  if (!rawSource) return false;
  // Organizer-created links are relative, while provider-reconciliation
  // links are absolute. Resolve the old link before moving it so a relative
  // target does not silently become relative to the new Arr directory.
  const source = path.isAbsolute(rawSource)
    ? rawSource
    : path.resolve(path.dirname(link), rawSource);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const existing = await fsp.lstat(destination).catch(() => undefined);
  if (existing) {
    if (!existing.isSymbolicLink()) return false;
    const rawExistingTarget = await fsp.readlink(destination).catch(() => undefined);
    if (!rawExistingTarget) return false;
    const existingTarget = path.isAbsolute(rawExistingTarget)
      ? rawExistingTarget
      : path.resolve(path.dirname(destination), rawExistingTarget);
    if (path.normalize(existingTarget) !== path.normalize(source)) return false;
  } else {
    await fsp.symlink(source, destination);
  }
  await fsp.unlink(link);
  return true;
}

async function requestArrRescan(category: Candidate["category"], recordId: number): Promise<void> {
  const baseUrl = category === "movie" ? config.providerReconciliationRadarrUrl : config.providerReconciliationSonarrUrl;
  const apiKey = category === "movie" ? config.providerReconciliationRadarrApiKey : config.providerReconciliationSonarrApiKey;
  if (!baseUrl || !apiKey) return;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v3/command`, {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      name: category === "movie" ? "RescanMovie" : "RescanSeries",
      [category === "movie" ? "movieId" : "seriesId"]: recordId,
    }),
  });
  if (!response.ok) throw new Error(`Arr rescan failed: HTTP ${response.status}`);
}

/**
 * Reconciles links created by both the bootstrap organizer and later
 * AllDebrid manifest scans with the authoritative Radarr/Sonarr library path.
 * It is deliberately symlink-only and safe to run repeatedly.
 */
export async function reconcileOrganizedLibraryWithArr(): Promise<{ scanned: number; moved: number; unresolved: number }> {
  if (!configured()) return { scanned: 0, moved: 0, unresolved: 0 };
  const organizedBase = config.organizedBase;
  const links: string[] = [];
  for (const category of ["Movies", "TV", "Anime"]) {
    links.push(...await walkSymlinks(path.join(organizedBase, category)));
  }

  let movies: ArrMovie[] = [];
  let series: ArrSeries[] = [];
  if (config.providerReconciliationRadarrUrl && config.providerReconciliationRadarrApiKey) {
    try {
      movies = await fetchArr<ArrMovie>(config.providerReconciliationRadarrUrl, config.providerReconciliationRadarrApiKey, "movie");
    } catch (error) {
      console.warn(`[${new Date().toISOString()}][organize] Radarr path reconciliation unavailable`, { err: (error as Error)?.message || String(error) });
    }
  }
  if (config.providerReconciliationSonarrUrl && config.providerReconciliationSonarrApiKey) {
    try {
      series = await fetchArr<ArrSeries>(config.providerReconciliationSonarrUrl, config.providerReconciliationSonarrApiKey, "series");
    } catch (error) {
      console.warn(`[${new Date().toISOString()}][organize] Sonarr path reconciliation unavailable`, { err: (error as Error)?.message || String(error) });
    }
  }

  let moved = 0;
  let unresolved = 0;
  for (const link of links) {
    const candidate = candidateFor(link, organizedBase);
    if (!candidate) continue;
    const tmdbId = await resolveTmdbId(candidate).catch(() => undefined);
    const records = candidate.category === "movie" ? movies : series;
    const record = (tmdbId && records.find((item) => String(item.tmdbId || "") === tmdbId)) ||
      records.find((item) => normalize(item.title || "") === normalize(candidate.title || ""));
    if (!record?.path) {
      unresolved++;
      continue;
    }
    const destination = candidate.category === "series" && candidate.season
      ? path.join(record.path, `Season ${String(candidate.season).padStart(2, "0")}`, path.basename(link))
      : path.join(record.path, path.basename(link));
    if (await moveSymlink(link, destination)) {
      moved++;
      if (record.id) {
        try {
          await requestArrRescan(candidate.category, record.id);
        } catch (error) {
          console.warn(`[${new Date().toISOString()}][organize] Arr rescan deferred after path reconciliation`, {
            title: record.title,
            err: (error as Error)?.message || String(error),
          });
        }
      }
    }
  }
  return { scanned: links.length, moved, unresolved };
}
