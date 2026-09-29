"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediaServerProviders = exports.JellyfinMediaServerProvider = exports.PlexMediaServerProvider = void 0;
exports.normalizeMediaServerTitle = normalizeMediaServerTitle;
const config_1 = require("../core/config");
const mediaParser_1 = require("./mediaParser");
async function requestJson(url, init) {
    try {
        const response = await fetch(url, init);
        if (response.status === 401 || response.status === 403)
            return { status: response.status };
        return { status: response.status, data: response.ok ? await response.json() : undefined };
    }
    catch {
        return { status: 0 };
    }
}
function idsFromGuids(guids = []) {
    const result = {};
    for (const guid of guids) {
        const value = guid.id || "";
        const match = value.match(/(?:tmdb|themoviedb|imdb|tvdb):\/\/?(.+)/i);
        if (!match)
            continue;
        const type = value.split(":")[0].toLowerCase();
        if (type.includes("tmdb"))
            result.tmdbId = match[1];
        if (type.includes("imdb"))
            result.imdbId = match[1];
        if (type.includes("tvdb"))
            result.tvdbId = match[1];
    }
    return result;
}
function streamFromPlex(stream) {
    const type = stream.streamType === 1 ? "video" : stream.streamType === 2 ? "audio" : stream.streamType === 3 ? "subtitle" : undefined;
    if (!type)
        return undefined;
    return { type, codec: stream.codec, width: stream.width, height: stream.height, bitrate: stream.bitrate, language: stream.language, channels: stream.channels, forced: Boolean(stream.forced), atmos: /atmos/i.test(`${stream.title || ""} ${stream.displayTitle || ""}`) };
}
function streamFromJellyfin(stream, container, runtimeSeconds) {
    const type = String(stream.Type || "").toLowerCase();
    if (type !== "video" && type !== "audio" && type !== "subtitle")
        return undefined;
    const hdr = stream.VideoRangeType || stream.VideoRange;
    return {
        type,
        codec: stream.Codec,
        width: stream.Width,
        height: stream.Height,
        bitrate: stream.BitRate,
        bitDepth: stream.BitDepth,
        hdr,
        language: stream.Language,
        channels: stream.Channels,
        forced: Boolean(stream.IsForced),
        atmos: /atmos/i.test(`${stream.DisplayTitle || ""} ${stream.Title || ""}`),
        container,
        runtimeSeconds,
    };
}
function catalogStatus(response) {
    if (response.status === 401 || response.status === 403)
        return "authentication_failed";
    return response.data ? "matched" : "unavailable";
}
class PlexMediaServerProvider {
    constructor() {
        this.id = "PLEX";
    }
    capabilities() { return { identity: true, externalIds: true, pathMapping: true, mediaMetadata: true, mediaStreams: true }; }
    async catalog() {
        if (!config_1.config.plexUrl || !config_1.config.plexToken)
            return { source: this.id, status: "configuration_unavailable", items: [], error: "Plex URL/token not configured" };
        const headers = { Accept: "application/json", "X-Plex-Token": config_1.config.plexToken };
        const base = config_1.config.plexUrl.replace(/\/$/, "");
        const sections = await requestJson(`${base}/library/sections`, { headers });
        const status = catalogStatus(sections);
        if (!sections.data)
            return { source: this.id, status, items: [], error: "Plex library sections request failed" };
        const items = [];
        for (const section of sections.data?.MediaContainer?.Directory || []) {
            const data = await requestJson(`${base}/library/sections/${section.key}/all?includeGuids=1&includeExtras=0&X-Plex-Container-Size=100000`, { headers });
            for (const item of data.data?.MediaContainer?.Metadata || []) {
                const part = item.Media?.[0]?.Part?.[0];
                const streams = (part?.Stream || []).map(streamFromPlex).filter(Boolean);
                items.push({ title: item.title, year: item.year, kind: item.type === "episode" ? "episode" : item.type === "show" ? "show" : "movie", season: item.parentIndex, episode: item.index, path: part?.file, ...idsFromGuids(item.Guid), streams, source: this.id });
            }
        }
        return { source: this.id, status: "matched", items };
    }
}
exports.PlexMediaServerProvider = PlexMediaServerProvider;
class JellyfinMediaServerProvider {
    constructor() {
        this.id = "JELLYFIN";
    }
    capabilities() { return { identity: true, externalIds: true, pathMapping: true, mediaMetadata: true, mediaStreams: true }; }
    async catalog() {
        if (!config_1.config.jellyfinUrl || !config_1.config.jellyfinApiKey)
            return { source: this.id, status: "configuration_unavailable", items: [], error: "Jellyfin URL/API key not configured" };
        const url = `${config_1.config.jellyfinUrl.replace(/\/$/, "")}/Items?Recursive=true&IncludeItemTypes=Movie,Series,Episode&Fields=ProviderIds,Path,ProductionYear,ParentIndexNumber,IndexNumber,OriginalLanguage,MediaSources&Limit=100000`;
        const response = await requestJson(url, { headers: { Authorization: `MediaBrowser Token="${config_1.config.jellyfinApiKey}"` } });
        const status = catalogStatus(response);
        if (!response.data)
            return { source: this.id, status, items: [], error: "Jellyfin library request failed" };
        const items = (response.data.Items || []).map((item) => {
            const source = item.MediaSources?.[0];
            const runtimeSeconds = item.RunTimeTicks ? Number(item.RunTimeTicks) / 10000000 : undefined;
            const streams = (source?.MediaStreams || []).map((stream) => streamFromJellyfin(stream, source?.Container, runtimeSeconds)).filter(Boolean);
            return { title: item.Name, year: item.ProductionYear, kind: item.Type === "Episode" ? "episode" : item.Type === "Series" ? "show" : "movie", season: item.ParentIndexNumber, episode: item.IndexNumber, path: item.Path, tmdbId: item.ProviderIds?.Tmdb, imdbId: item.ProviderIds?.Imdb, tvdbId: item.ProviderIds?.Tvdb, originalLanguage: item.OriginalLanguage, streams, source: this.id };
        });
        return { source: this.id, status: "matched", items };
    }
}
exports.JellyfinMediaServerProvider = JellyfinMediaServerProvider;
exports.mediaServerProviders = [new PlexMediaServerProvider(), new JellyfinMediaServerProvider()];
function normalizeMediaServerTitle(value) {
    return (0, mediaParser_1.normalizeMediaTitle)(value || "");
}
