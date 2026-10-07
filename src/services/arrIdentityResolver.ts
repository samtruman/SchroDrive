import { config } from "../core/config";
import type { VersionRecord } from "./versionManager";
import type { MetadataItem, ResolutionResult } from "./versionManagerMetadata";

function baseName(value: string): string {
  return value.split(/[\\/]/).pop() || value;
}

function apiUrl(base: string, title: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${normalizedBase}/api/v3/parse?title=${encodeURIComponent(title)}`;
}

async function request(base: string, apiKey: string, title: string): Promise<{ status: number; data?: any }> {
  if (!base || !apiKey) return { status: 0 };
  try {
    const response = await fetch(apiUrl(base, title), { headers: { "X-Api-Key": apiKey, Accept: "application/json" } });
    return { status: response.status, data: response.ok ? await response.json() : undefined };
  } catch {
    return { status: 0 };
  }
}

export async function resolveWithArrParser(version: VersionRecord): Promise<ResolutionResult | undefined> {
  const identity = version.fingerprint.identity;
  const title = baseName(version.fingerprint.storage.path);
  const episode = identity.kind === "episode" || identity.season !== undefined || identity.episode !== undefined;
  const base = episode ? config.providerReconciliationSonarrUrl : config.providerReconciliationRadarrUrl;
  const key = episode ? config.providerReconciliationSonarrApiKey : config.providerReconciliationRadarrApiKey;
  const source = episode ? "Sonarr" : "Radarr";
  if (!base || !key || !title) return undefined;
  const result = await request(base, key, title);
  if (result.status === 401 || result.status === 403) return { status: "authentication_failed", identityStatus: "uncertain", conflicts: [], descriptiveDisagreements: [], confidence: Math.min(identity.confidence, 0.4), reason: `${source} parser authentication failed` };
  if (result.status === 0) return { status: "unavailable", identityStatus: "uncertain", conflicts: [], descriptiveDisagreements: [], confidence: identity.confidence, reason: `${source} parser unavailable` };
  if (!result.data) return { status: "not_matched", identityStatus: "fallback", conflicts: [], descriptiveDisagreements: [], confidence: identity.confidence, reason: `${source} parser did not match the filename` };

  const parsed = result.data;
  const media = episode ? (parsed.series || parsed.tvSeries || parsed) : (parsed.movie || parsed);
  const parsedEpisode = episode ? (parsed.episodes?.[0] || parsed.episode || {}) : {};
  const tmdbId = media.tmdbId ?? media.tmdbid;
  const imdbId = media.imdbId ?? media.imdbid;
  const tvdbId = media.tvdbId ?? media.tvdbid;
  const item: MetadataItem = {
    title: media.title || identity.title,
    year: Number(media.year || identity.year) || undefined,
    kind: episode ? "episode" : "movie",
    season: Number(parsedEpisode.seasonNumber ?? parsedEpisode.season ?? identity.season) || undefined,
    episode: Number(parsedEpisode.episodeNumber ?? parsedEpisode.episode ?? identity.episode) || undefined,
    tmdbId: tmdbId ? String(tmdbId) : undefined,
    imdbId: imdbId ? String(imdbId) : undefined,
    tvdbId: tvdbId ? String(tvdbId) : undefined,
    source: "ARR",
  };
  if (!item.tmdbId && !item.imdbId && !item.tvdbId) return { status: "not_matched", identityStatus: "fallback", conflicts: [], descriptiveDisagreements: [], confidence: identity.confidence, reason: `${source} parser returned no canonical external id` };
  return { status: "matched", identityStatus: "resolved", item, conflicts: [], descriptiveDisagreements: [], confidence: 0.96, reason: `${source} parser matched the filename`, strongMatch: true };
}
