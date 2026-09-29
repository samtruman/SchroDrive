"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchTmdbCandidates = searchTmdbCandidates;
exports.searchTmdb = searchTmdb;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../core/config");
const mediaParser_1 = require("./mediaParser");
async function requestWithRetry(request, options = {}) {
    const timeoutMs = Math.max(250, options.timeoutMs ?? 10000);
    const retries = Math.max(0, options.retries ?? 0);
    const backoffMs = Math.max(0, options.backoffMs ?? 250);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("TMDb request timed out")), timeoutMs);
                request().then(resolve, reject).finally(() => clearTimeout(timer));
            });
        }
        catch (error) {
            lastError = error;
            if (attempt < retries)
                await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
        }
    }
    throw lastError;
}
/** Read-only candidate search for the manual Media Manager identity picker. */
async function searchTmdbCandidates(query, kind, year, options = {}) {
    if (!config_1.config.tmdbApiKey)
        throw new Error("TMDB_API_KEY is not configured");
    const params = { api_key: config_1.config.tmdbApiKey, query, include_adult: false };
    if (year)
        params[kind === "movie" ? "year" : "first_air_date_year"] = year;
    const response = await requestWithRetry(() => axios_1.default.get(`https://api.themoviedb.org/3/search/${kind}`, { params, timeout: options.timeoutMs ?? 10000 }), options);
    const results = Array.isArray(response.data?.results) ? response.data.results.slice(0, 10) : [];
    return Promise.all(results.map(async (item) => {
        const id = String(item.id);
        let external = {};
        try {
            const response = await requestWithRetry(() => axios_1.default.get(`https://api.themoviedb.org/3/${kind}/${id}/external_ids`, { params: { api_key: config_1.config.tmdbApiKey }, timeout: options.timeoutMs ?? 10000 }), options);
            external = response.data || {};
        }
        catch {
            // Search results remain useful when optional external-ID enrichment fails.
        }
        const releaseDate = String(kind === "movie" ? item.release_date || "" : item.first_air_date || "");
        return {
            tmdbId: id,
            title: String(kind === "movie" ? item.title || item.original_title || "" : item.name || item.original_name || ""),
            originalTitle: (kind === "movie" ? item.original_title : item.original_name) || undefined,
            mediaType: kind,
            releaseDate: releaseDate || undefined,
            year: Number(releaseDate.slice(0, 4)) || undefined,
            originalLanguage: item.original_language || undefined,
            imdbId: external.imdb_id || undefined,
            tvdbId: external.tvdb_id ? String(external.tvdb_id) : undefined,
            overview: item.overview || undefined,
        };
    }));
}
/** Shared read-only TMDb lookup used by Organizer and Version Manager. */
async function searchTmdb(title, kind, year, options = {}) {
    if (!config_1.config.tmdbApiKey)
        return { status: "configuration_unavailable", reason: "TMDB_API_KEY is not configured" };
    try {
        const params = { api_key: config_1.config.tmdbApiKey, query: title, include_adult: false };
        if (year)
            params[kind === "movie" ? "year" : "first_air_date_year"] = year;
        const searchUrl = `https://api.themoviedb.org/3/search/${kind}`;
        const response = await requestWithRetry(() => axios_1.default.get(searchUrl, { params, timeout: options.timeoutMs ?? 10000 }), options);
        const results = Array.isArray(response.data?.results) ? response.data.results : [];
        const candidates = results.map((item) => ({
            id: String(item.id),
            title: kind === "movie" ? (item.title || item.original_title || "") : (item.name || item.original_name || ""),
            kind: kind === "movie" ? "movie" : "show",
            year: Number(String(kind === "movie" ? item.release_date : item.first_air_date || "").slice(0, 4)) || undefined,
        }));
        const selection = (0, mediaParser_1.selectMediaCandidate)({ title, year, kind: kind === "movie" ? "movie" : "episode" }, candidates);
        if (selection.status === "ambiguous")
            return { status: "ambiguous", reason: "TMDb candidates are too close" };
        if (selection.status !== "matched" || !selection.candidate)
            return { status: "not_matched", reason: "TMDb returned no reliable candidate" };
        const hit = results.find((item) => String(item.id) === String(selection.candidate?.id));
        if (!hit)
            return { status: "not_matched", reason: "TMDb candidate disappeared before enrichment" };
        const [external, details] = await Promise.all([
            requestWithRetry(() => axios_1.default.get(`https://api.themoviedb.org/3/${kind === "movie" ? "movie" : "tv"}/${hit.id}/external_ids`, { params: { api_key: config_1.config.tmdbApiKey }, timeout: options.timeoutMs ?? 10000 }), options),
            requestWithRetry(() => axios_1.default.get(`https://api.themoviedb.org/3/${kind === "movie" ? "movie" : "tv"}/${hit.id}`, { params: { api_key: config_1.config.tmdbApiKey }, timeout: options.timeoutMs ?? 10000 }), options),
        ]);
        const releaseDate = kind === "movie" ? hit.release_date : hit.first_air_date;
        return {
            status: "matched",
            reason: "TMDb title/year lookup",
            metadata: {
                tmdbId: String(hit.id),
                imdbId: external.data?.imdb_id || undefined,
                tvdbId: external.data?.tvdb_id ? String(external.data.tvdb_id) : undefined,
                title: kind === "movie" ? (hit.title || hit.original_title || title) : (hit.name || hit.original_name || title),
                year: Number(String(releaseDate || "").slice(0, 4)) || year,
                kind,
                originalLanguage: details.data?.original_language || undefined,
            },
        };
    }
    catch (error) {
        return { status: "unavailable", reason: error?.message || "TMDb request failed" };
    }
}
