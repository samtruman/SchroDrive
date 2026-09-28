import { config } from "../core/config";
import { getDb } from "../core/db";
import { normalizeMediaTitle } from "./mediaParser";
import { searchTmdb } from "./tmdbService";
import { mediaServerProviders, type MediaServerCatalog, type MediaServerItem, type MediaStreamEvidence } from "./mediaServerProvider";
import type { IdentityConflict, IdentityResolutionStatus, Provenance, VersionRecord } from "./versionManager";

export type MetadataSourceStatus = "matched" | "not_matched" | "ambiguous" | "unavailable" | "configuration_unavailable" | "authentication_failed";

export type MetadataItem = MediaServerItem;
export type MetadataCatalog = MediaServerCatalog;
export type MediaStream = MediaStreamEvidence;

export interface MetadataStats {
  plex: number;
  jellyfin: number;
  tmdb: number;
  matched: number;
  unresolved: number;
  conflicts: number;
  filenameFallback: number;
  originalLanguageResolved: number;
  cacheHits: number;
  cacheMisses: number;
  tmdbResolutionAttempts: number;
  tmdbRequests: number;
  tmdbNotMatched: number;
  tmdbAmbiguous: number;
  tmdbUnavailable: number;
  tmdbConfigurationUnavailable: number;
  plexStatus: MetadataSourceStatus;
  jellyfinStatus: MetadataSourceStatus;
  tmdbStatus: MetadataSourceStatus;
}

export interface ResolutionResult {
  status: MetadataSourceStatus;
  identityStatus: IdentityResolutionStatus;
  item?: MetadataItem;
  conflicts: IdentityConflict[];
  confidence: number;
  reason: string;
  strongMatch?: boolean;
}

function key(title?: string, year?: number, kind?: string, season?: number, episode?: number): string {
  return [normalizeMediaTitle(title || ""), year || "", kind || "", season || "", episode || ""].join(":");
}

function basename(value?: string): string { return (value || "").split(/[\\/]/).pop()?.toLowerCase() || ""; }
function normalPath(value?: string): string { return (value || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase(); }

function itemIds(item: MetadataItem): Record<string, string> {
  return { ...(item.tmdbId ? { tmdbId: String(item.tmdbId) } : {}), ...(item.imdbId ? { imdbId: item.imdbId } : {}), ...(item.tvdbId ? { tvdbId: String(item.tvdbId) } : {}) };
}

function conflictsFor(items: MetadataItem[], version: VersionRecord, ignoreFilenameValues = false): IdentityConflict[] {
  const conflicts: IdentityConflict[] = [];
  const fields: Array<[string, (item: MetadataItem) => string | undefined, (identity: VersionRecord["fingerprint"]["identity"]) => string | undefined]> = [
    ["tmdbId", (item) => item.tmdbId, (identity) => identity.tmdbId],
    ["imdbId", (item) => item.imdbId, (identity) => identity.imdbId],
    ["tvdbId", (item) => item.tvdbId, (identity) => identity.tvdbId],
    ["title", (item) => item.title ? normalizeMediaTitle(item.title) : undefined, (identity) => identity.normalizedTitle],
    ["year", (item) => item.year ? String(item.year) : undefined, (identity) => identity.year ? String(identity.year) : undefined],
    ["season", (item) => item.season ? String(item.season) : undefined, (identity) => identity.season ? String(identity.season) : undefined],
    ["episode", (item) => item.episode ? String(item.episode) : undefined, (identity) => identity.episode ? String(identity.episode) : undefined],
  ];
  for (const [field, readItem, readIdentity] of fields) {
    const values = items.map((item) => ({ value: readItem(item), source: item.source })).filter((entry): entry is { value: string; source: Provenance } => Boolean(entry.value));
    const identityValue = readIdentity(version.fingerprint.identity);
    const identitySource = version.fingerprint.identity.provenance?.[field] || "FILENAME";
    if (identityValue && !(ignoreFilenameValues && identitySource === "FILENAME")) values.push({ value: identityValue, source: identitySource });
    const unique = [...new Map(values.map((entry) => [entry.value, entry.source])).entries()];
    if (unique.length > 1) {
      const sources = new Set(unique.map(([, source]) => source));
      const code = ["tmdbId", "imdbId", "tvdbId"].includes(field)
        ? "PROVIDER_ID_MISMATCH"
        : sources.has("FILENAME") && sources.size > 1
          ? "FILENAME_PROVIDER_DISAGREEMENT"
          : items.length > 1 && sources.size === 1 && sources.has("PLEX")
            ? "MULTIPLE_PLEX_CANDIDATES"
            : sources.size > 1
              ? "CROSS_PROVIDER_DISAGREEMENT"
              : field === "title"
                ? "TITLE_MISMATCH"
                : field === "year"
                  ? "YEAR_MISMATCH"
                  : ["season", "episode"].includes(field)
                    ? "SEASON_EPISODE_MISMATCH"
                    : "IDENTITY_FIELD_MISMATCH";
      conflicts.push({ code, field, values: unique.map(([value, source]) => ({ value, source })) });
    }
  }
  return conflicts;
}

function mergeItems(items: MetadataItem[]): MetadataItem | undefined {
  if (!items.length) return undefined;
  const result: MetadataItem = { ...items[0] };
  for (const item of items.slice(1)) {
    for (const field of ["title", "year", "kind", "season", "episode", "path", "tmdbId", "imdbId", "tvdbId", "originalLanguage"] as const) {
      if (result[field] === undefined && item[field] !== undefined) result[field] = item[field] as never;
    }
  }
  return result;
}

function matchCatalog(version: VersionRecord, catalog: MetadataCatalog): ResolutionResult {
  if (catalog.status === "configuration_unavailable" || catalog.status === "unavailable" || catalog.status === "authentication_failed") return { status: catalog.status, identityStatus: "uncertain", conflicts: [], confidence: version.fingerprint.identity.confidence, reason: catalog.error || `${catalog.source} unavailable` };
  const identity = version.fingerprint.identity;
  const versionIds = new Set([identity.tmdbId, identity.imdbId, identity.tvdbId].filter(Boolean).map(String));
  const byId = catalog.items.filter((item) => Object.values(itemIds(item)).some((value) => versionIds.has(value)));
  const pathValue = normalPath(version.fingerprint.storage.path);
  const byPath = catalog.items.filter((item) => item.path && (normalPath(item.path) === pathValue || basename(item.path) === basename(pathValue)));
  const byKey = catalog.items.filter((item) => key(item.title, item.year, item.kind, item.season, item.episode) === key(identity.title, identity.year, identity.kind, identity.season, identity.episode));
  const candidates = byId.length ? byId : byPath.length ? byPath : byKey;
  if (candidates.length > 1 && !byId.length && !byPath.length) return { status: "ambiguous", identityStatus: "uncertain", conflicts: [], confidence: Math.min(identity.confidence, 0.55), reason: `${catalog.source} returned multiple title/episode candidates` };
  if (!candidates.length) return { status: "not_matched", identityStatus: "fallback", conflicts: [], confidence: identity.confidence, reason: `${catalog.source} had no matching item` };
  const merged = mergeItems(candidates);
  const conflicts = merged ? conflictsFor(candidates, version, Boolean(byId.length || byPath.length)) : [];
  return { status: "matched", identityStatus: conflicts.length ? "conflict" : "resolved", item: merged, conflicts, confidence: conflicts.length ? Math.min(identity.confidence, 0.5) : 0.98, reason: conflicts.length ? `${catalog.source} match contains conflicting identifiers` : `${catalog.source} matched by provider ID, path or structured identity`, strongMatch: Boolean(byId.length || byPath.length) };
}

function applyItem(version: VersionRecord, result: ResolutionResult): void {
  const identity = version.fingerprint.identity;
  const item = result.item;
  if (!item) {
    if (result.status === "not_matched") identity.resolutionStatus ||= "fallback";
    if (result.status === "ambiguous" || result.status === "unavailable" || result.status === "configuration_unavailable") identity.resolutionStatus = "uncertain";
    identity.confidence = Math.min(identity.confidence, result.confidence);
    return;
  }
  const source = item.source;
  for (const [field, value] of Object.entries(itemIds(item))) {
    const keyName = field as "tmdbId" | "imdbId" | "tvdbId";
    if (!identity[keyName]) identity[keyName] = value;
    identity.provenance = { ...identity.provenance, [keyName]: source };
  }
  if (item.title) { identity.title = item.title; identity.normalizedTitle = normalizeMediaTitle(item.title); identity.provenance = { ...identity.provenance, title: source, normalizedTitle: source }; }
  if (item.year) { identity.year = item.year; identity.provenance = { ...identity.provenance, year: source }; }
  if (item.originalLanguage) { identity.originalLanguage = item.originalLanguage.toLowerCase(); identity.provenance = { ...identity.provenance, originalLanguage: source }; }
  if (item.streams?.length) {
    const video = item.streams.find((stream) => stream.type === "video");
    if (video) {
      if (!version.fingerprint.video.width && video.width) version.fingerprint.video.width = video.width;
      if (!version.fingerprint.video.height && video.height) version.fingerprint.video.height = video.height;
      if (!version.fingerprint.video.resolution && video.height) version.fingerprint.video.resolution = `${video.height}p`;
      if (!version.fingerprint.video.codec && video.codec) version.fingerprint.video.codec = video.codec;
      if (!version.fingerprint.video.bitrate && video.bitrate) version.fingerprint.video.bitrate = video.bitrate;
      if (!version.fingerprint.video.bitDepth && video.bitDepth) version.fingerprint.video.bitDepth = video.bitDepth;
      if (!version.fingerprint.video.hdrFormat && video.hdr) version.fingerprint.video.hdrFormat = video.hdr;
      version.fingerprint.video.provenance = { ...version.fingerprint.video.provenance, ...(video.width ? { width: source } : {}), ...(video.height ? { height: source } : {}), ...(video.codec ? { codec: source } : {}), ...(video.bitrate ? { bitrate: source } : {}), ...(video.hdr ? { hdrFormat: source } : {}) };
    }
    const audio = item.streams.filter((stream) => stream.type === "audio");
    if (audio.length && version.fingerprint.audio.length === 0) version.fingerprint.audio = audio.map((stream) => ({ language: stream.language || "und", codec: stream.codec, channels: stream.channels, bitrate: stream.bitrate, atmos: stream.atmos, provenance: { language: source, codec: source, channels: source, bitrate: source, atmos: source } }));
    const subtitles = item.streams.filter((stream) => stream.type === "subtitle");
    if (subtitles.length && version.fingerprint.subtitles.length === 0) version.fingerprint.subtitles = subtitles.map((stream) => ({ language: stream.language || "und", codec: stream.codec, forced: stream.forced, provenance: { language: source, codec: source, forced: source } }));
  }
  identity.resolutionStatus = result.identityStatus;
  identity.conflicts = result.conflicts.length ? result.conflicts : undefined;
  identity.confidence = result.confidence;
  identity.source = "provider";
}

export function getCachedVersionManagerMetadata(cacheKey: string): MetadataItem | undefined {
  const row = getDb().prepare("SELECT metadata_json, expires_at FROM version_manager_metadata_cache WHERE cache_key = ?").get(cacheKey) as any;
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return undefined;
  try { return JSON.parse(row.metadata_json) as MetadataItem; } catch { return undefined; }
}

export function saveVersionManagerMetadataCache(cacheKey: string, provider: string, metadata: MetadataItem, ttlMs = 86400000): void {
  const now = new Date();
  getDb().prepare("INSERT OR REPLACE INTO version_manager_metadata_cache (cache_key, provider, metadata_json, status, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(cacheKey, provider, JSON.stringify(metadata), "matched", now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
}

export function invalidateVersionManagerMetadataCache(provider?: string): void {
  if (provider) getDb().prepare("DELETE FROM version_manager_metadata_cache WHERE provider = ?").run(provider);
  else getDb().exec("DELETE FROM version_manager_metadata_cache");
}

async function tmdbLookup(version: VersionRecord, stats: MetadataStats): Promise<ResolutionResult> {
  const identity = version.fingerprint.identity;
  stats.tmdbResolutionAttempts++;
  if (!config.tmdbApiKey || !identity.title) {
    stats.tmdbConfigurationUnavailable++;
    return { status: "configuration_unavailable", identityStatus: "uncertain", conflicts: [], confidence: identity.confidence, reason: "TMDb API key or title unavailable" };
  }
  const type = identity.kind === "episode" ? "tv" : "movie";
  const cacheKey = `tmdb:${type}:${normalizeMediaTitle(identity.title)}:${identity.year || ""}`;
  const cached = getCachedVersionManagerMetadata(cacheKey);
  if (cached) { stats.cacheHits++; return { status: "matched", identityStatus: "resolved", item: cached, conflicts: [], confidence: 0.9, reason: "TMDb metadata cache hit" }; }
  stats.cacheMisses++;
  stats.tmdbRequests++;
  const lookup = await searchTmdb(identity.title, type, identity.year);
  if (lookup.status === "not_matched") stats.tmdbNotMatched++;
  else if (lookup.status === "ambiguous") stats.tmdbAmbiguous++;
  else if (lookup.status === "unavailable") stats.tmdbUnavailable++;
  else if (lookup.status === "configuration_unavailable") stats.tmdbConfigurationUnavailable++;
  if (lookup.status !== "matched" || !lookup.metadata) {
    return { status: lookup.status, identityStatus: lookup.status === "ambiguous" || lookup.status === "configuration_unavailable" ? "uncertain" : "fallback", conflicts: [], confidence: lookup.status === "ambiguous" ? Math.min(identity.confidence, 0.55) : identity.confidence, reason: lookup.reason };
  }
  const metadata: MetadataItem = { title: lookup.metadata.title, year: lookup.metadata.year || identity.year, kind: type === "tv" ? "show" : "movie", tmdbId: lookup.metadata.tmdbId, imdbId: lookup.metadata.imdbId, tvdbId: lookup.metadata.tvdbId, originalLanguage: lookup.metadata.originalLanguage, source: "TMDB" };
  saveVersionManagerMetadataCache(cacheKey, "TMDB", metadata);
  return { status: "matched", identityStatus: "resolved", item: metadata, conflicts: [], confidence: 0.9, reason: "TMDb metadata lookup" };
}

export function resolveVersionIdentity(version: VersionRecord, catalogs: MetadataCatalog[]): ResolutionResult {
  const results = catalogs.map((catalog) => matchCatalog(version, catalog));
  const matched = results.filter((result) => result.status === "matched" && result.item);
  if (!matched.length) {
    const unavailable = results.find((result) => result.status === "configuration_unavailable" || result.status === "unavailable" || result.status === "authentication_failed");
    if (unavailable) return unavailable;
    const ambiguous = results.some((result) => result.status === "ambiguous");
    return { status: ambiguous ? "ambiguous" : "not_matched", identityStatus: ambiguous ? "uncertain" : "fallback", conflicts: [], confidence: version.fingerprint.identity.confidence, reason: "No metadata source matched" };
  }
  const items = matched.map((result) => result.item!);
  const strongMatch = matched.some((result) => result.strongMatch);
  const conflicts = [...matched.flatMap((result) => result.conflicts), ...conflictsFor(items, version, strongMatch)];
  return { status: "matched", identityStatus: conflicts.length ? "conflict" : "resolved", item: mergeItems(items), conflicts, confidence: conflicts.length ? 0.5 : Math.max(...matched.map((result) => result.confidence)), reason: conflicts.length ? "Metadata providers disagree" : "Metadata providers agree", strongMatch };
}

export async function enrichVersionMetadata(versions: VersionRecord[]): Promise<MetadataStats> {
  const catalogs = await Promise.all(mediaServerProviders.map((provider) => provider.catalog()));
  const plex = catalogs.find((catalog) => catalog.source === "PLEX") || { source: "PLEX" as const, status: "configuration_unavailable" as const, items: [] };
  const jellyfin = catalogs.find((catalog) => catalog.source === "JELLYFIN") || { source: "JELLYFIN" as const, status: "configuration_unavailable" as const, items: [] };
  const stats: MetadataStats = { plex: plex.items.length, jellyfin: jellyfin.items.length, tmdb: 0, matched: 0, unresolved: 0, conflicts: 0, filenameFallback: 0, originalLanguageResolved: 0, cacheHits: 0, cacheMisses: 0, tmdbResolutionAttempts: 0, tmdbRequests: 0, tmdbNotMatched: 0, tmdbAmbiguous: 0, tmdbUnavailable: 0, tmdbConfigurationUnavailable: 0, plexStatus: plex.status, jellyfinStatus: jellyfin.status, tmdbStatus: config.tmdbApiKey ? "not_matched" : "configuration_unavailable" };
  for (const version of versions) {
    const catalogResult = resolveVersionIdentity(version, catalogs);
    let result = catalogResult;
    if (catalogResult.status === "matched") { applyItem(version, catalogResult); stats.matched++; }
    else {
      result = await tmdbLookup(version, stats);
      if (result.status === "matched") { stats.tmdb++; stats.tmdbStatus = "matched"; applyItem(version, result); stats.matched++; }
      else { stats.unresolved++; stats.filenameFallback++; version.fingerprint.identity.resolutionStatus = result.status === "ambiguous" ? "uncertain" : "fallback"; }
    }
    if (version.fingerprint.identity.conflicts?.length) stats.conflicts++;
    if (version.fingerprint.identity.originalLanguage) stats.originalLanguageResolved++;
  }
  return stats;
}
