"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isArrConfigured = isArrConfigured;
exports.pushReleaseToArr = pushReleaseToArr;
const config_1 = require("../core/config");
function routeFor(mediaType) {
    if (mediaType === "movie") {
        return {
            baseUrl: config_1.config.providerReconciliationRadarrUrl,
            apiKey: config_1.config.providerReconciliationRadarrApiKey,
            name: "Radarr",
        };
    }
    return {
        baseUrl: config_1.config.providerReconciliationSonarrUrl,
        apiKey: config_1.config.providerReconciliationSonarrApiKey,
        name: "Sonarr",
    };
}
/** Whether the ARR target for this media type is configured. */
function isArrConfigured(mediaType) {
    const route = routeFor(mediaType);
    return Boolean(route.baseUrl && route.apiKey);
}
function normaliseBaseUrl(url) {
    return url.replace(/\/$/, "");
}
function apiHeaders(apiKey) {
    return {
        "X-Api-Key": apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
    };
}
async function readJson(response, context) {
    const text = await response.text();
    let body = undefined;
    if (text.trim()) {
        try {
            body = JSON.parse(text);
        }
        catch {
            body = text.slice(0, 500);
        }
    }
    if (!response.ok) {
        const detail = typeof body === "string" ? `: ${body}` : "";
        throw new Error(`${context} failed: HTTP ${response.status}${detail}`);
    }
    return body;
}
async function arrGet(route, path) {
    const endpoint = `${normaliseBaseUrl(route.baseUrl)}${path}`;
    const response = await fetch(endpoint, { headers: apiHeaders(route.apiKey) });
    return readJson(response, `${route.name} GET ${path}`);
}
async function arrPost(route, path, body) {
    const endpoint = `${normaliseBaseUrl(route.baseUrl)}${path}`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: apiHeaders(route.apiKey),
        body: JSON.stringify(body),
    });
    return readJson(response, `${route.name} POST ${path}`);
}
function normaliseHash(value) {
    return String(value || "").replace(/[^a-f0-9]/gi, "").toLowerCase();
}
function hashFromMagnet(magnet) {
    try {
        const xt = new URL(magnet).searchParams.get("xt") || "";
        return normaliseHash(xt.replace(/^urn:btih:/i, ""));
    }
    catch {
        return "";
    }
}
function normaliseTitle(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/\.[a-z0-9]{2,4}$/i, "")
        .replace(/[^a-z0-9]+/g, "")
        .trim();
}
function releaseMatches(candidate, input, magnet) {
    const selectedHash = normaliseHash(input?.infoHash) || hashFromMagnet(magnet);
    const candidateHash = normaliseHash(candidate?.infoHash || candidate?.releaseHash);
    if (selectedHash && candidateHash)
        return selectedHash === candidateHash;
    const selectedTitle = normaliseTitle(input?.title);
    const candidateTitle = normaliseTitle(candidate?.title);
    if (!selectedTitle || !candidateTitle || selectedTitle !== candidateTitle)
        return false;
    const selectedSize = Number(input?.size || 0);
    const candidateSize = Number(candidate?.size || 0);
    if (!selectedSize || !candidateSize)
        return true;
    return Math.abs(selectedSize - candidateSize) / Math.max(selectedSize, candidateSize) < 0.03;
}
function findByTmdbId(items, tmdbId) {
    return (Array.isArray(items) ? items : []).find((item) => String(item?.tmdbId || "") === tmdbId);
}
function firstConfiguredId(items, label) {
    const match = (Array.isArray(items) ? items : []).find((item) => Number(item?.id) > 0);
    if (!match)
        throw new Error(`${label} non ha un profilo configurato`);
    return Number(match.id);
}
function firstAccessibleRootFolder(items, label) {
    const match = (Array.isArray(items) ? items : []).find((item) => item?.path && item?.accessible !== false);
    if (!match)
        throw new Error(`${label} non ha una root folder accessibile`);
    return String(match.path);
}
async function lookupArrEntity(route, mediaType, identity) {
    const tmdbId = String(identity.tmdbId || "").trim();
    const title = String(identity.title || "").trim();
    const endpoint = mediaType === "movie" ? "/api/v3/movie/lookup" : "/api/v3/series/lookup";
    const terms = [`tmdb:${tmdbId}`, title].filter(Boolean);
    for (const term of terms) {
        try {
            const results = await arrGet(route, `${endpoint}?term=${encodeURIComponent(term)}`);
            const exact = (Array.isArray(results) ? results : []).find((item) => String(item?.tmdbId || "") === tmdbId);
            if (exact)
                return exact;
        }
        catch {
            // Some ARR versions do not accept the tmdb:<id> lookup syntax. The
            // title fallback below keeps creation compatible with those versions.
        }
    }
    throw new Error(`${route.name} non riesce a risolvere il titolo TMDB ${tmdbId} per la creazione automatica`);
}
async function ensureArrEntity(route, mediaType, identity) {
    const tmdbId = String(identity.tmdbId || "").trim();
    if (!tmdbId)
        throw new Error(`Identità TMDB mancante per ${route.name}`);
    const collectionEndpoint = mediaType === "movie" ? "/api/v3/movie" : "/api/v3/series";
    const existing = findByTmdbId(await arrGet(route, collectionEndpoint), tmdbId);
    if (existing)
        return { entity: existing, created: false };
    const metadata = await lookupArrEntity(route, mediaType, identity);
    const [qualityProfiles, rootFolders] = await Promise.all([
        arrGet(route, "/api/v3/qualityprofile"),
        arrGet(route, "/api/v3/rootfolder"),
    ]);
    const qualityProfileId = firstConfiguredId(qualityProfiles, route.name);
    const rootFolderPath = firstAccessibleRootFolder(rootFolders, route.name);
    const payload = {
        ...metadata,
        tmdbId: Number(tmdbId),
        title: metadata.title || identity.title,
        year: metadata.year || identity.year,
        qualityProfileId,
        rootFolderPath,
        monitored: true,
        ...(mediaType === "movie"
            ? { addOptions: { searchForMovie: false } }
            : { seasonFolder: true, addOptions: { searchForMissingEpisodes: false } }),
    };
    const created = await arrPost(route, collectionEndpoint, payload);
    return { entity: created, created: true };
}
function seasonFromTitle(title) {
    const match = title.match(/\bS0*(\d{1,3})(?:E\d{1,3})*\b/i)
        || title.match(/\bSeason\s*0*(\d{1,3})\b/i);
    return match ? Number(match[1]) : undefined;
}
async function findArrRelease(route, mediaType, identity, input, magnet) {
    const tmdbId = String(identity.tmdbId || "").trim();
    const title = String(input?.title || identity.title || "").trim();
    if (!tmdbId)
        throw new Error(`Identità TMDB mancante per ${route.name}`);
    if (mediaType === "movie") {
        const { entity: movie, created } = await ensureArrEntity(route, mediaType, identity);
        const searchEndpoint = `/api/v3/release?movieId=${encodeURIComponent(String(movie.id))}`;
        const releases = await arrGet(route, searchEndpoint);
        const candidate = (Array.isArray(releases) ? releases : []).find((release) => releaseMatches(release, input, magnet));
        if (!candidate) {
            throw new Error(`Radarr non ha restituito la release selezionata per "${title || identity.title}"; ripeti la ricerca manuale in Radarr`);
        }
        return { candidate, searchEndpoint, created };
    }
    const { entity: series, created } = await ensureArrEntity(route, mediaType, identity);
    const season = seasonFromTitle(title);
    if (!season) {
        throw new Error("Sonarr richiede stagione/episodio nel titolo della release per eseguire il grab manuale");
    }
    const searchEndpoint = `/api/v3/release?seriesId=${encodeURIComponent(String(series.id))}&seasonNumber=${encodeURIComponent(String(season))}`;
    const releases = await arrGet(route, searchEndpoint);
    const candidate = (Array.isArray(releases) ? releases : []).find((release) => releaseMatches(release, input, magnet));
    if (!candidate) {
        throw new Error(`Sonarr non ha restituito la release selezionata per "${title || identity.title}"; ripeti la ricerca manuale in Sonarr`);
    }
    return { candidate, searchEndpoint, created };
}
/**
 * Grab a release through the same cached manual-search path used by ARR UI.
 *
 * `/api/v3/release/push` is the RSS path and can silently reject a release
 * (notably when the movie/series is unmonitored). The manual path must first
 * search the ARR indexers, then POST the exact cached ReleaseResource returned
 * by that search to `/api/v3/release`.
 */
async function pushReleaseToArr(mediaType, input) {
    const route = routeFor(mediaType);
    if (!route.baseUrl || !route.apiKey) {
        throw new Error(`${route.name} API is not configured for manual ARR grab`);
    }
    const { candidate, searchEndpoint, created } = await findArrRelease(route, mediaType, input.identity, input.release, input.magnet);
    const endpoint = `${normaliseBaseUrl(route.baseUrl)}/api/v3/release`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: apiHeaders(route.apiKey),
        body: JSON.stringify(candidate),
    });
    const body = await readJson(response, `${route.name} manual grab`);
    return { mediaType, endpoint, searchEndpoint, arrEntityCreated: created, response: body };
}
