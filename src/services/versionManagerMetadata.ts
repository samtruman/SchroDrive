import { config } from "../core/config";
import { normalizeMediaTitle } from "./mediaParser";
import type { Provenance, VersionRecord } from "./versionManager";

interface MetadataItem { title?: string; year?: number; kind?: string; season?: number; episode?: number; path?: string; tmdbId?: string; imdbId?: string; tvdbId?: string; originalLanguage?: string; source: Provenance; }
export interface MetadataStats { plex: number; jellyfin: number; tmdb: number; matched: number; unresolved: number; }

function key(title?: string, year?: number, kind?: string, season?: number, episode?: number): string {
  return [normalizeMediaTitle(title || ""), year || "", kind || "", season || "", episode || ""].join(":");
}

function idsFromGuids(guids: Array<{ id?: string }> = []) {
  const ids: Record<string, string> = {};
  for (const guid of guids) {
    const match = guid.id?.match(/(tmdb|imdb|tvdb):\/\/?(.+)/i);
    if (!match) continue;
    ids[match[1].toLowerCase()] = match[2];
  }
  return ids;
}

async function json(url: string, init?: RequestInit): Promise<any> {
  try { const response = await fetch(url, init); return response.ok ? await response.json() : undefined; } catch { return undefined; }
}

async function plexItems(): Promise<MetadataItem[]> {
  if (!config.plexUrl || !config.plexToken) return [];
  const headers = { Accept: "application/json", "X-Plex-Token": config.plexToken };
  const sections = await json(`${config.plexUrl.replace(/\/$/, "")}/library/sections`, { headers });
  const result: MetadataItem[] = [];
  for (const section of sections?.MediaContainer?.Directory || []) {
    const data = await json(`${config.plexUrl.replace(/\/$/, "")}/library/sections/${section.key}/all?includeGuids=1&X-Plex-Container-Size=100000`, { headers });
    for (const item of data?.MediaContainer?.Metadata || []) {
      const part = item.Media?.[0]?.Part?.[0]?.file;
      const ids = idsFromGuids(item.Guid);
      result.push({ title: item.title, year: item.year, kind: item.type === "episode" ? "episode" : "movie", season: item.parentIndex, episode: item.index, path: part, tmdbId: ids.tmdb, imdbId: ids.imdb, tvdbId: ids.tvdb, source: "PLEX" });
    }
  }
  return result;
}

async function jellyfinItems(): Promise<MetadataItem[]> {
  if (!config.jellyfinUrl || !config.jellyfinApiKey) return [];
  const url = `${config.jellyfinUrl.replace(/\/$/, "")}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=ProviderIds,Path,ProductionYear,ParentIndexNumber,IndexNumber&Limit=100000`;
  const data = await json(url, { headers: { "X-Emby-Token": config.jellyfinApiKey } });
  return (data?.Items || []).map((item: any) => ({ title: item.Name, year: item.ProductionYear, kind: item.Type === "Episode" ? "episode" : "movie", season: item.ParentIndexNumber, episode: item.IndexNumber, path: item.Path, tmdbId: item.ProviderIds?.Tmdb, imdbId: item.ProviderIds?.Imdb, tvdbId: item.ProviderIds?.Tvdb, source: "JELLYFIN" }));
}

async function tmdbLookup(version: VersionRecord): Promise<MetadataItem | undefined> {
  if (!config.tmdbApiKey || !version.fingerprint.identity.title) return undefined;
  const type = version.fingerprint.identity.kind === "episode" ? "tv" : "movie";
  const params = new URLSearchParams({ api_key: config.tmdbApiKey, query: version.fingerprint.identity.title, include_adult: "false" });
  if (version.fingerprint.identity.year) params.set("year", String(version.fingerprint.identity.year));
  const data = await json(`https://api.themoviedb.org/3/search/${type}?${params}`);
  const hit = data?.results?.[0];
  if (!hit?.id) return undefined;
  const external = await json(`https://api.themoviedb.org/3/${type}/${hit.id}/external_ids?api_key=${encodeURIComponent(config.tmdbApiKey)}`);
  const details = await json(`https://api.themoviedb.org/3/${type}/${hit.id}?api_key=${encodeURIComponent(config.tmdbApiKey)}`);
  return { title: version.fingerprint.identity.title, year: version.fingerprint.identity.year, kind: type === "tv" ? "episode" : "movie", tmdbId: String(hit.id), imdbId: external?.imdb_id, tvdbId: external?.tvdb_id ? String(external.tvdb_id) : undefined, originalLanguage: details?.original_language, source: "TMDB" };
}

function basename(value?: string): string { return (value || "").split(/[\\/]/).pop()?.toLowerCase() || ""; }

export async function enrichVersionMetadata(versions: VersionRecord[]): Promise<MetadataStats> {
  const [plex, jellyfin] = await Promise.all([plexItems(), jellyfinItems()]);
  const byPath = new Map<string, MetadataItem>();
  const byKey = new Map<string, MetadataItem>();
  for (const item of [...plex, ...jellyfin]) { if (item.path) byPath.set(basename(item.path), item); byKey.set(key(item.title, item.year, item.kind, item.season, item.episode), item); }
  const stats: MetadataStats = { plex: plex.length, jellyfin: jellyfin.length, tmdb: 0, matched: 0, unresolved: 0 };
  for (const version of versions) {
    const identity = version.fingerprint.identity;
    let item = byPath.get(basename(identity.title ? version.fingerprint.storage.path : ""));
    item ||= byKey.get(key(identity.title, identity.year, identity.kind, identity.season, identity.episode));
    item ||= await tmdbLookup(version);
    if (!item) { stats.unresolved++; continue; }
    if (item.source === "TMDB") stats.tmdb++;
    if (item.tmdbId) { identity.tmdbId = item.tmdbId; identity.provenance = { ...identity.provenance, tmdbId: item.source }; }
    if (item.imdbId) { identity.imdbId = item.imdbId; identity.provenance = { ...identity.provenance, imdbId: item.source }; }
    if (item.tvdbId) { identity.tvdbId = item.tvdbId; identity.provenance = { ...identity.provenance, tvdbId: item.source }; }
    if (item.originalLanguage) { identity.originalLanguage = item.originalLanguage; identity.provenance = { ...identity.provenance, originalLanguage: item.source }; }
    identity.provenance = { ...identity.provenance, title: item.source, year: item.source, kind: item.source };
    stats.matched++;
  }
  return stats;
}
