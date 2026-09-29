"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedVersionManagerMetadata = getCachedVersionManagerMetadata;
exports.saveVersionManagerMetadataCache = saveVersionManagerMetadataCache;
exports.invalidateVersionManagerMetadataCache = invalidateVersionManagerMetadataCache;
exports.resolveVersionIdentity = resolveVersionIdentity;
exports.enrichVersionMetadata = enrichVersionMetadata;
const config_1 = require("../core/config");
const db_1 = require("../core/db");
const mediaParser_1 = require("./mediaParser");
const tmdbService_1 = require("./tmdbService");
const mediaServerProvider_1 = require("./mediaServerProvider");
function key(title, year, kind, season, episode) {
    return [(0, mediaParser_1.normalizeMediaTitle)(title || ""), year || "", kind || "", season || "", episode || ""].join(":");
}
function basename(value) { return (value || "").split(/[\\/]/).pop()?.toLowerCase() || ""; }
function normalPath(value) { return (value || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase(); }
function itemIds(item) {
    return { ...(item.tmdbId ? { tmdbId: String(item.tmdbId) } : {}), ...(item.imdbId ? { imdbId: item.imdbId } : {}), ...(item.tvdbId ? { tvdbId: String(item.tvdbId) } : {}) };
}
function conflictsFor(items, version, ignoreFilenameValues = false, suppressDescriptive = false) {
    const conflicts = [];
    const disagreements = [];
    const fields = [
        ["tmdbId", (item) => item.tmdbId, (identity) => identity.tmdbId],
        ["imdbId", (item) => item.imdbId, (identity) => identity.imdbId],
        ["tvdbId", (item) => item.tvdbId, (identity) => identity.tvdbId],
        ["title", (item) => item.title ? (0, mediaParser_1.normalizeMediaTitle)(item.title) : undefined, (identity) => identity.normalizedTitle],
        ["year", (item) => item.year ? String(item.year) : undefined, (identity) => identity.year ? String(identity.year) : undefined],
        ["season", (item) => item.season ? String(item.season) : undefined, (identity) => identity.season ? String(identity.season) : undefined],
        ["episode", (item) => item.episode ? String(item.episode) : undefined, (identity) => identity.episode ? String(identity.episode) : undefined],
    ];
    for (const [field, readItem, readIdentity] of fields) {
        const values = items.map((item) => ({ value: readItem(item), source: item.source })).filter((entry) => Boolean(entry.value));
        const identityValue = readIdentity(version.fingerprint.identity);
        const identitySource = version.fingerprint.identity.provenance?.[field] || "FILENAME";
        if (identityValue && !(ignoreFilenameValues && identitySource === "FILENAME"))
            values.push({ value: identityValue, source: identitySource });
        const unique = [...new Map(values.map((entry) => [entry.value, entry.source])).entries()];
        if (unique.length > 1) {
            const sources = new Set(unique.map(([, source]) => source));
            const code = ["tmdbId", "imdbId", "tvdbId"].includes(field)
                ? "PROVIDER_ID_MISMATCH"
                : sources.has("FILENAME") && sources.size > 1
                    ? "FILENAME_PROVIDER_DISAGREEMENT"
                    : items.length > 1 && sources.size === 1 && sources.has("PLEX")
                        ? "MULTIPLE_PLEX_CANDIDATES"
                        : ["season", "episode"].includes(field)
                            ? "SEASON_EPISODE_MISMATCH"
                            : sources.size > 1
                                ? "CROSS_PROVIDER_DISAGREEMENT"
                                : field === "title"
                                    ? "TITLE_MISMATCH"
                                    : field === "year"
                                        ? "YEAR_MISMATCH"
                                        : "IDENTITY_FIELD_MISMATCH";
            const disagreement = { code, field, values: unique.map(([value, source]) => ({ value, source })) };
            if (suppressDescriptive && ["title", "year"].includes(field))
                disagreements.push(disagreement);
            else
                conflicts.push(disagreement);
        }
    }
    return { conflicts, disagreements };
}
function hasStrongCanonicalAgreement(items, version) {
    const identity = version.fingerprint.identity;
    const fields = [
        ["tmdbId", identity.provenance?.tmdbId], ["imdbId", identity.provenance?.imdbId], ["tvdbId", identity.provenance?.tvdbId],
    ];
    return fields.some(([field, provenance]) => {
        const values = items.map((item) => item[field]).filter(Boolean).map(String);
        if (provenance && provenance !== "FILENAME" && identity[field])
            values.push(String(identity[field]));
        return values.length > 0 && new Set(values).size === 1;
    });
}
function mergeItems(items) {
    if (!items.length)
        return undefined;
    const result = { ...items[0] };
    for (const item of items.slice(1)) {
        for (const field of ["title", "year", "kind", "season", "episode", "path", "tmdbId", "imdbId", "tvdbId", "originalLanguage"]) {
            if (result[field] === undefined && item[field] !== undefined)
                result[field] = item[field];
        }
    }
    return result;
}
function matchCatalog(version, catalog) {
    if (catalog.status === "configuration_unavailable" || catalog.status === "unavailable" || catalog.status === "authentication_failed")
        return { status: catalog.status, identityStatus: "uncertain", conflicts: [], descriptiveDisagreements: [], confidence: version.fingerprint.identity.confidence, reason: catalog.error || `${catalog.source} unavailable` };
    const identity = version.fingerprint.identity;
    const versionIds = new Set([identity.tmdbId, identity.imdbId, identity.tvdbId].filter(Boolean).map(String));
    const byId = catalog.items.filter((item) => Object.values(itemIds(item)).some((value) => versionIds.has(value)));
    const pathValue = normalPath(version.fingerprint.storage.path);
    const byPath = catalog.items.filter((item) => item.path && (normalPath(item.path) === pathValue || basename(item.path) === basename(pathValue)));
    const byKey = catalog.items.filter((item) => key(item.title, item.year, item.kind, item.season, item.episode) === key(identity.title, identity.year, identity.kind, identity.season, identity.episode));
    const candidates = byId.length ? byId : byPath.length ? byPath : byKey;
    if (candidates.length > 1 && !byId.length && !byPath.length)
        return { status: "ambiguous", identityStatus: "uncertain", conflicts: [], descriptiveDisagreements: [], confidence: Math.min(identity.confidence, 0.55), reason: `${catalog.source} returned multiple title/episode candidates` };
    if (!candidates.length)
        return { status: "not_matched", identityStatus: "fallback", conflicts: [], descriptiveDisagreements: [], confidence: identity.confidence, reason: `${catalog.source} had no matching item` };
    const merged = mergeItems(candidates);
    const result = merged ? conflictsFor(candidates, version, Boolean(byId.length || byPath.length), hasStrongCanonicalAgreement(candidates, version)) : { conflicts: [], disagreements: [] };
    return { status: "matched", identityStatus: result.conflicts.length ? "conflict" : "resolved", item: merged, conflicts: result.conflicts, descriptiveDisagreements: result.disagreements, confidence: result.conflicts.length ? Math.min(identity.confidence, 0.5) : 0.98, reason: result.conflicts.length ? `${catalog.source} match contains conflicting identifiers` : `${catalog.source} matched by provider ID, path or structured identity`, strongMatch: Boolean(byId.length || byPath.length) };
}
function applyItem(version, result) {
    const identity = version.fingerprint.identity;
    const item = result.item;
    if (!item) {
        if (result.status === "not_matched")
            identity.resolutionStatus || (identity.resolutionStatus = "fallback");
        if (result.status === "ambiguous" || result.status === "unavailable" || result.status === "configuration_unavailable")
            identity.resolutionStatus = "uncertain";
        identity.confidence = Math.min(identity.confidence, result.confidence);
        return;
    }
    const source = item.source;
    for (const [field, value] of Object.entries(itemIds(item))) {
        const keyName = field;
        if (!identity[keyName])
            identity[keyName] = value;
        identity.provenance = { ...identity.provenance, [keyName]: source };
    }
    if (item.title) {
        identity.title = item.title;
        identity.normalizedTitle = (0, mediaParser_1.normalizeMediaTitle)(item.title);
        identity.provenance = { ...identity.provenance, title: source, normalizedTitle: source };
    }
    if (item.year) {
        identity.year = item.year;
        identity.provenance = { ...identity.provenance, year: source };
    }
    if (item.originalLanguage) {
        identity.originalLanguage = item.originalLanguage.toLowerCase();
        identity.provenance = { ...identity.provenance, originalLanguage: source };
    }
    if (item.streams?.length) {
        const video = item.streams.find((stream) => stream.type === "video");
        if (video) {
            if (!version.fingerprint.video.width && video.width)
                version.fingerprint.video.width = video.width;
            if (!version.fingerprint.video.height && video.height)
                version.fingerprint.video.height = video.height;
            if (!version.fingerprint.video.resolution && video.height)
                version.fingerprint.video.resolution = `${video.height}p`;
            if (!version.fingerprint.video.codec && video.codec)
                version.fingerprint.video.codec = video.codec;
            if (!version.fingerprint.video.bitrate && video.bitrate)
                version.fingerprint.video.bitrate = video.bitrate;
            if (!version.fingerprint.video.bitDepth && video.bitDepth)
                version.fingerprint.video.bitDepth = video.bitDepth;
            if (!version.fingerprint.video.hdrFormat && video.hdr)
                version.fingerprint.video.hdrFormat = video.hdr;
            version.fingerprint.video.provenance = { ...version.fingerprint.video.provenance, ...(video.width ? { width: source } : {}), ...(video.height ? { height: source } : {}), ...(video.codec ? { codec: source } : {}), ...(video.bitrate ? { bitrate: source } : {}), ...(video.hdr ? { hdrFormat: source } : {}) };
        }
        const audio = item.streams.filter((stream) => stream.type === "audio");
        if (audio.length && version.fingerprint.audio.length === 0)
            version.fingerprint.audio = audio.map((stream) => ({ language: stream.language || "und", codec: stream.codec, channels: stream.channels, bitrate: stream.bitrate, atmos: stream.atmos, provenance: { language: source, codec: source, channels: source, bitrate: source, atmos: source } }));
        const subtitles = item.streams.filter((stream) => stream.type === "subtitle");
        if (subtitles.length && version.fingerprint.subtitles.length === 0)
            version.fingerprint.subtitles = subtitles.map((stream) => ({ language: stream.language || "und", codec: stream.codec, forced: stream.forced, provenance: { language: source, codec: source, forced: source } }));
    }
    identity.resolutionStatus = result.identityStatus;
    identity.conflicts = result.conflicts.length ? result.conflicts : undefined;
    identity.descriptiveDisagreements = result.descriptiveDisagreements.length ? result.descriptiveDisagreements : undefined;
    identity.confidence = result.confidence;
    identity.source = "provider";
}
function getCachedVersionManagerMetadata(cacheKey) {
    const row = (0, db_1.getDb)().prepare("SELECT metadata_json, expires_at FROM version_manager_metadata_cache WHERE cache_key = ?").get(cacheKey);
    if (!row || new Date(row.expires_at).getTime() <= Date.now())
        return undefined;
    try {
        return JSON.parse(row.metadata_json);
    }
    catch {
        return undefined;
    }
}
function saveVersionManagerMetadataCache(cacheKey, provider, metadata, ttlMs = 86400000) {
    const now = new Date();
    (0, db_1.getDb)().prepare("INSERT OR REPLACE INTO version_manager_metadata_cache (cache_key, provider, metadata_json, status, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(cacheKey, provider, JSON.stringify(metadata), "matched", now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
}
function invalidateVersionManagerMetadataCache(provider) {
    if (provider)
        (0, db_1.getDb)().prepare("DELETE FROM version_manager_metadata_cache WHERE provider = ?").run(provider);
    else
        (0, db_1.getDb)().exec("DELETE FROM version_manager_metadata_cache");
}
async function tmdbLookup(version, stats, options, memo) {
    const identity = version.fingerprint.identity;
    stats.tmdbResolutionAttempts++;
    if (!config_1.config.tmdbApiKey || !identity.title) {
        stats.tmdbConfigurationUnavailable++;
        return { status: "configuration_unavailable", identityStatus: "uncertain", conflicts: [], descriptiveDisagreements: [], confidence: identity.confidence, reason: "TMDb API key or title unavailable" };
    }
    const type = identity.kind === "episode" ? "tv" : "movie";
    const cacheKey = `tmdb:${type}:${(0, mediaParser_1.normalizeMediaTitle)(identity.title)}:${identity.year || ""}`;
    const memoized = memo.get(cacheKey);
    if (memoized)
        return memoized;
    const cached = getCachedVersionManagerMetadata(cacheKey);
    if (cached) {
        stats.cacheHits++;
        const result = { status: "matched", identityStatus: "resolved", item: cached, conflicts: [], descriptiveDisagreements: [], confidence: 0.9, reason: "TMDb metadata cache hit" };
        memo.set(cacheKey, result);
        return result;
    }
    stats.cacheMisses++;
    stats.tmdbRequests++;
    const lookup = await (0, tmdbService_1.searchTmdb)(identity.title, type, identity.year, options.tmdb);
    if (lookup.status === "not_matched")
        stats.tmdbNotMatched++;
    else if (lookup.status === "ambiguous")
        stats.tmdbAmbiguous++;
    else if (lookup.status === "unavailable")
        stats.tmdbUnavailable++;
    else if (lookup.status === "configuration_unavailable")
        stats.tmdbConfigurationUnavailable++;
    if (lookup.status !== "matched" || !lookup.metadata) {
        if (/timed out/i.test(lookup.reason))
            stats.tmdbTimeouts++;
        const result = { status: lookup.status, identityStatus: (lookup.status === "ambiguous" || lookup.status === "configuration_unavailable" ? "uncertain" : "fallback"), conflicts: [], descriptiveDisagreements: [], confidence: lookup.status === "ambiguous" ? Math.min(identity.confidence, 0.55) : identity.confidence, reason: lookup.reason };
        memo.set(cacheKey, result);
        return result;
    }
    const metadata = { title: lookup.metadata.title, year: lookup.metadata.year || identity.year, kind: type === "tv" ? "show" : "movie", tmdbId: lookup.metadata.tmdbId, imdbId: lookup.metadata.imdbId, tvdbId: lookup.metadata.tvdbId, originalLanguage: lookup.metadata.originalLanguage, source: "TMDB" };
    saveVersionManagerMetadataCache(cacheKey, "TMDB", metadata);
    const result = { status: "matched", identityStatus: "resolved", item: metadata, conflicts: [], descriptiveDisagreements: [], confidence: 0.9, reason: "TMDb metadata lookup" };
    memo.set(cacheKey, result);
    return result;
}
function resolveVersionIdentity(version, catalogs) {
    const results = catalogs.map((catalog) => matchCatalog(version, catalog));
    const matched = results.filter((result) => result.status === "matched" && result.item);
    if (!matched.length) {
        const unavailable = results.find((result) => result.status === "configuration_unavailable" || result.status === "unavailable" || result.status === "authentication_failed");
        if (unavailable)
            return unavailable;
        const ambiguous = results.some((result) => result.status === "ambiguous");
        return { status: ambiguous ? "ambiguous" : "not_matched", identityStatus: ambiguous ? "uncertain" : "fallback", conflicts: [], descriptiveDisagreements: [], confidence: version.fingerprint.identity.confidence, reason: "No metadata source matched" };
    }
    const items = matched.map((result) => result.item);
    const strongMatch = matched.some((result) => result.strongMatch);
    const cross = conflictsFor(items, version, strongMatch, hasStrongCanonicalAgreement(items, version));
    const conflicts = [...matched.flatMap((result) => result.conflicts), ...cross.conflicts];
    const descriptiveDisagreements = [...matched.flatMap((result) => result.descriptiveDisagreements), ...cross.disagreements];
    return { status: "matched", identityStatus: conflicts.length ? "conflict" : "resolved", item: mergeItems(items), conflicts, descriptiveDisagreements, confidence: conflicts.length ? 0.5 : Math.max(...matched.map((result) => result.confidence)), reason: conflicts.length ? "Metadata providers disagree" : "Metadata providers agree", strongMatch };
}
async function enrichVersionMetadata(versions, options = {}) {
    const providers = options.providers || mediaServerProvider_1.mediaServerProviders;
    const catalogs = await Promise.all(providers.map((provider) => provider.catalog()));
    const plex = catalogs.find((catalog) => catalog.source === "PLEX") || { source: "PLEX", status: "configuration_unavailable", items: [] };
    const jellyfin = catalogs.find((catalog) => catalog.source === "JELLYFIN") || { source: "JELLYFIN", status: "configuration_unavailable", items: [] };
    const stats = { plex: plex.items.length, jellyfin: jellyfin.items.length, tmdb: 0, matched: 0, unresolved: 0, conflicts: 0, filenameFallback: 0, originalLanguageResolved: 0, cacheHits: 0, cacheMisses: 0, tmdbResolutionAttempts: 0, tmdbRequests: 0, tmdbNotMatched: 0, tmdbAmbiguous: 0, tmdbUnavailable: 0, tmdbConfigurationUnavailable: 0, tmdbTimeouts: 0, plexStatus: plex.status, jellyfinStatus: jellyfin.status, tmdbStatus: config_1.config.tmdbApiKey ? "not_matched" : "configuration_unavailable" };
    const memo = new Map();
    const startedAt = Date.now();
    for (const [index, version] of versions.entries()) {
        const catalogResult = resolveVersionIdentity(version, catalogs);
        let result = catalogResult;
        if (catalogResult.status === "matched") {
            applyItem(version, catalogResult);
            stats.matched++;
        }
        else {
            result = await tmdbLookup(version, stats, options, memo);
            if (result.status === "matched") {
                stats.tmdb++;
                stats.tmdbStatus = "matched";
                applyItem(version, result);
                stats.matched++;
            }
            else {
                stats.unresolved++;
                stats.filenameFallback++;
                version.fingerprint.identity.resolutionStatus = result.status === "ambiguous" ? "uncertain" : "fallback";
            }
        }
        if (version.fingerprint.identity.conflicts?.length)
            stats.conflicts++;
        if (version.fingerprint.identity.originalLanguage)
            stats.originalLanguageResolved++;
        await options.onProgress?.({ index: index + 1, total: versions.length, fingerprintId: version.id, state: version.fingerprint.identity.resolutionStatus || "fallback", cache: result.reason.includes("cache hit") ? "hit" : "miss", elapsedMs: Date.now() - startedAt });
    }
    return stats;
}
