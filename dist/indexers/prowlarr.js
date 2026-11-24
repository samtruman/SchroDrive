"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testProwlarrConnection = testProwlarrConnection;
exports.searchProwlarr = searchProwlarr;
exports.pickBestResult = pickBestResult;
exports.getMagnet = getMagnet;
exports.getMagnetOrResolve = getMagnetOrResolve;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../core/config");
const httpClient_1 = require("../core/httpClient");
const shared_1 = require("./shared");
function buildProwlarrSearchUrl(baseUrl, query, categories, indexerIds, limit) {
    const params = new URLSearchParams({ query, type: "search" });
    for (const category of categories ?? [])
        params.append("categories", category);
    for (const indexerId of indexerIds ?? [])
        params.append("indexerIds", indexerId);
    if (limit)
        params.set("limit", String(limit));
    return `${baseUrl.toString()}?${params.toString()}`;
}
let searchIndexerCache;
async function discoverSearchIndexers(base, headers, timeoutMs) {
    if (searchIndexerCache && searchIndexerCache.expiresAt > Date.now())
        return searchIndexerCache.indexers;
    const response = await axios_1.default.get(`${base}/api/v1/indexer`, { headers, timeout: timeoutMs });
    const indexers = (Array.isArray(response.data) ? response.data : [])
        .map((item) => ({
        id: String(item?.id ?? "").trim(),
        name: typeof item?.name === "string" ? item.name : undefined,
        enabled: item?.enable !== false,
        protocol: typeof item?.protocol === "string" ? item.protocol : undefined,
    }))
        .filter((item) => item.id && item.enabled && item.protocol !== "usenet");
    searchIndexerCache = { expiresAt: Date.now() + 5 * 60000, indexers };
    return indexers;
}
async function searchProwlarrPartial(base, query, categories, configuredIndexerIds, limit, headers, timeoutMs) {
    let indexers;
    try {
        indexers = configuredIndexerIds?.length
            ? configuredIndexerIds.map((id) => ({ id: String(id), name: `indexer-${id}` }))
            : await discoverSearchIndexers(base, headers, Math.min(timeoutMs, 10000));
    }
    catch (error) {
        console.warn(`[${new Date().toISOString()}][prowlarr] partial search indexer discovery failed`, { error: error?.message || String(error) });
        return [];
    }
    if (!indexers.length)
        return [];
    // Prowlarr's aggregate endpoint waits for every configured indexer. Query
    // each indexer independently so one GatewayTimeout cannot hide successful
    // results from the others. Keep the per-indexer deadline bounded even when
    // the global Prowlarr timeout is configured very high.
    const perIndexerTimeoutMs = Math.max(5000, Math.min(timeoutMs, 15000));
    const results = await Promise.all(indexers.slice(0, 12).map(async (indexer) => {
        const url = buildProwlarrSearchUrl(new URL("/api/v1/search", base), query, categories, [indexer.id], limit);
        const started = Date.now();
        try {
            const response = await axios_1.default.get(url, { headers, timeout: perIndexerTimeoutMs });
            const data = Array.isArray(response.data) ? response.data : [];
            console.log(`[${new Date().toISOString()}][prowlarr] partial response`, {
                indexer: indexer.name || indexer.id,
                count: data.length,
                ms: Date.now() - started,
            });
            return data;
        }
        catch (error) {
            console.warn(`[${new Date().toISOString()}][prowlarr] partial indexer failed`, {
                indexer: indexer.name || indexer.id,
                ms: Date.now() - started,
                error: error?.message || String(error),
            });
            return [];
        }
    }));
    return results.flat();
}
async function testProwlarrConnection() {
    try {
        const base = (0, shared_1.normaliseBaseUrl)(config_1.config.prowlarrUrl ?? "");
        if (!base || !config_1.config.prowlarrApiKey)
            return false;
        const started = Date.now();
        const timeoutMs = (0, httpClient_1.requestTimeoutMs)(config_1.config.prowlarrTimeoutMs, 60000, 10000);
        console.log(`[${new Date().toISOString()}][prowlarr] testing connection to ${base}`, { timeoutMs });
        const res = await axios_1.default.get(`${base}/api/v1/indexer`, {
            headers: { "X-Api-Key": config_1.config.prowlarrApiKey },
            timeout: timeoutMs,
        });
        console.log(`[${new Date().toISOString()}][prowlarr] connection test successful`, {
            ms: Date.now() - started,
            indexerCount: Array.isArray(res.data) ? res.data.length : 0
        });
        return true;
    }
    catch (err) {
        console.error(`[${new Date().toISOString()}][prowlarr] connection test failed`, {
            error: err?.message || String(err),
            code: err?.code,
            status: err?.response?.status,
            statusText: err?.response?.statusText,
        });
        return false;
    }
}
async function searchProwlarr(query, opts) {
    if (!config_1.config.prowlarrUrl || !config_1.config.prowlarrApiKey) {
        throw new Error("Prowlarr not configured. Set PROWLARR_URL and PROWLARR_API_KEY.");
    }
    const base = (0, shared_1.normaliseBaseUrl)(config_1.config.prowlarrUrl);
    const url = new URL("/api/v1/search", base);
    // Cap length before regex processing — an unbounded run of whitespace here would make
    // \s*TMDB\d+\b (combined with the global flag) do quadratic backtracking work.
    const originalQuery = String(query || "").slice(0, 200);
    const withoutTmdb = (0, shared_1.stripTmdbQuery)(originalQuery);
    const usedQuery = withoutTmdb || originalQuery;
    const searchType = 'search';
    const categories = (opts?.categories?.length ? opts.categories : (config_1.config.prowlarrCategories?.length ? config_1.config.prowlarrCategories : undefined));
    const indexerIds = (opts?.indexerIds?.length ? opts.indexerIds : (config_1.config.prowlarrIndexerIds?.length ? config_1.config.prowlarrIndexerIds : undefined));
    const limit = opts?.limit ?? (Number.isFinite(config_1.config.prowlarrSearchLimit) ? config_1.config.prowlarrSearchLimit : undefined);
    const searchUrl = buildProwlarrSearchUrl(url, usedQuery, categories, indexerIds, limit);
    const maskedKey = config_1.config.prowlarrApiKey ? `${config_1.config.prowlarrApiKey.slice(0, 4)}…` : "unset";
    const headers = { "X-Api-Key": config_1.config.prowlarrApiKey };
    const started = Date.now();
    console.log(`[${new Date().toISOString()}][prowlarr] GET ${searchUrl}`, {
        query: originalQuery,
        usedQuery,
        categories,
        indexerIds,
        limit,
        apikey: maskedKey,
        timeoutMs: config_1.config.prowlarrTimeoutMs,
        type: searchType,
    });
    const timeoutMs = (0, httpClient_1.requestTimeoutMs)(config_1.config.prowlarrTimeoutMs, 120000, 15000);
    let data = await searchProwlarrPartial(base, usedQuery, categories, indexerIds, limit, headers, timeoutMs);
    console.log(`[${new Date().toISOString()}][prowlarr] response`, {
        count: data.length,
        ms: Date.now() - started,
        sample: data.slice(0, 5).map((r) => ({
            title: r.title,
            seeders: r.seeders,
            size: r.size,
            hasMagnet: !!(r.magnetUrl || r.guid || r.link),
            indexer: r.indexer,
        })),
    });
    // Fallback: if no results and query contains a year, retry without the year
    if (!data.length && /\b(19|20)\d{2}\b/.test(usedQuery)) {
        const withoutYear = usedQuery.replace(/\b(19|20)\d{2}\b/g, "").replace(/\s{2,}/g, " ").trim();
        if (withoutYear && withoutYear !== usedQuery) {
            const started2 = Date.now();
            const fallbackUrl = buildProwlarrSearchUrl(url, withoutYear, categories, indexerIds, limit);
            console.log(`[${new Date().toISOString()}][prowlarr] fallback GET ${fallbackUrl}`, {
                originalQuery,
                usedQuery,
                fallbackQuery: withoutYear,
                categories,
                indexerIds,
                limit,
                apikey: maskedKey,
                timeoutMs: config_1.config.prowlarrTimeoutMs,
                type: searchType,
            });
            data = await searchProwlarrPartial(base, withoutYear, categories, indexerIds, limit, headers, timeoutMs);
            console.log(`[${new Date().toISOString()}][prowlarr] fallback response`, {
                count: data.length,
                ms: Date.now() - started2,
                sample: data.slice(0, 5).map((r) => ({ title: r.title, seeders: r.seeders, size: r.size, indexer: r.indexer })),
            });
        }
    }
    // Fallback: if still no results and categories were used, try without categories
    if (!data.length && categories?.length) {
        const started3 = Date.now();
        const fallbackNoCategoriesUrl = buildProwlarrSearchUrl(url, usedQuery, undefined, indexerIds, limit);
        console.log(`[${new Date().toISOString()}][prowlarr] fallback (no categories) GET ${fallbackNoCategoriesUrl}`, {
            originalQuery,
            usedQuery,
            categoriesRemoved: true,
            indexerIds,
            limit,
            apikey: maskedKey,
            timeoutMs: config_1.config.prowlarrTimeoutMs,
            type: searchType,
        });
        data = await searchProwlarrPartial(base, usedQuery, undefined, indexerIds, limit, headers, timeoutMs);
        console.log(`[${new Date().toISOString()}][prowlarr] fallback (no categories) response`, {
            count: data.length,
            ms: Date.now() - started3,
            sample: data.slice(0, 5).map((r) => ({ title: r.title, seeders: r.seeders, size: r.size, indexer: r.indexer })),
        });
    }
    return data;
}
function pickBestResult(results) {
    // Filter out dead torrents (0 seeders) — they'll never download
    const alive = results.filter((r) => (r.seeders || 0) > 0);
    // Fall back to all results if every result has 0 seeders
    const pool = alive.length > 0 ? alive : results;
    // Sort purely by seeders desc, then size desc — magnet availability is
    // handled by the caller's resolution loop in overseerr.ts
    const sorted = pool
        .slice()
        .sort((a, b) => (b.seeders || 0) - (a.seeders || 0) || (b.size || 0) - (a.size || 0));
    const chosen = sorted[0];
    console.log(`[${new Date().toISOString()}][prowlarr] pickBestResult`, {
        inputCount: results.length,
        aliveCount: alive.length,
        poolCount: pool.length,
        chosen: chosen ? { title: chosen.title, seeders: chosen.seeders, size: chosen.size } : null,
        top3: sorted.slice(0, 3).map(r => ({ title: r.title, seeders: r.seeders, size: r.size })),
    });
    return chosen;
}
function getMagnet(r) {
    if (!r)
        return undefined;
    const direct = r.magnetUrl || r.guid || r.link;
    const ok = (0, shared_1.isValidMagnetUri)(direct);
    console.log(`[${new Date().toISOString()}][prowlarr] getMagnet`, { hasCandidate: !!direct, ok });
    if (ok)
        return direct;
    const hashCand = (r.infoHash || r.infohash || r.hash || "").toString().trim();
    const built = (0, shared_1.buildMagnetFromHash)(hashCand, r.title);
    if (built) {
        console.log(`[${new Date().toISOString()}][prowlarr] getMagnet built from infoHash`, { built: true });
        return built;
    }
    return undefined;
}
function isMagnet(s) {
    return typeof s === 'string' && s.startsWith('magnet:');
}
function absoluteUrl(u, base) {
    try {
        return new URL(u, base).toString();
    }
    catch {
        return u;
    }
}
/**
 * Prowlarr can emit download URLs pointing at its own loopback listener.
 * Those URLs are valid from the Prowlarr host, but not from SchroDrive's
 * container. Resolve loopback URLs through the configured Docker service
 * instead, while preserving the path and query string.
 */
function normaliseProwlarrUrl(u, base) {
    try {
        const parsed = new URL(u, base);
        const configured = new URL(base);
        if (["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
            parsed.protocol = configured.protocol;
            parsed.hostname = configured.hostname;
            parsed.port = configured.port;
        }
        return parsed.toString();
    }
    catch {
        return u;
    }
}
async function getMagnetOrResolve(r) {
    if (!r)
        return undefined;
    const direct = getMagnet(r);
    if (direct)
        return direct;
    const base = (0, shared_1.normaliseBaseUrl)(config_1.config.prowlarrUrl ?? "");
    if (!base)
        return undefined;
    const candidate = r.downloadUrl || r.download || r.downloadurl || r.download_link || r.link;
    let url = typeof candidate === 'string' ? normaliseProwlarrUrl(absoluteUrl(candidate, base), base) : '';
    if (!url || !(url.startsWith('http://') || url.startsWith('https://')))
        return undefined;
    const maxHops = Math.max(1, Math.min(Number(config_1.config.prowlarrRedirectMaxHops || 5), 10));
    const timeoutMs = (0, httpClient_1.requestTimeoutMs)(config_1.config.prowlarrTimeoutMs, 120000, 15000);
    let hops = 0;
    while (hops < maxHops && url && (url.startsWith('http://') || url.startsWith('https://'))) {
        hops++;
        let resp;
        try {
            resp = await axios_1.default.head(url, { headers: { 'X-Api-Key': config_1.config.prowlarrApiKey }, maxRedirects: 0, validateStatus: () => true, timeout: timeoutMs });
        }
        catch {
            try {
                resp = await axios_1.default.get(url, { headers: { 'X-Api-Key': config_1.config.prowlarrApiKey }, maxRedirects: 0, validateStatus: () => true, timeout: timeoutMs });
            }
            catch (e) {
                console.warn(`[${new Date().toISOString()}][prowlarr] resolveMagnet failed`, { url, err: e?.message });
                return undefined;
            }
        }
        let status = resp?.status || 0;
        let location = String(resp?.headers?.location || '');
        let ctype = String(resp?.headers?.['content-type'] || '').toLowerCase();
        // Prowlarr's download proxy commonly rejects HEAD with 405 while GET
        // returns the actual magnet redirect. Retry the same URL with GET before
        // classifying the result as unresolved.
        if (status === 405 || status === 501) {
            try {
                resp = await axios_1.default.get(url, { headers: { 'X-Api-Key': config_1.config.prowlarrApiKey }, maxRedirects: 0, validateStatus: () => true, timeout: timeoutMs });
                status = resp?.status || 0;
                location = String(resp?.headers?.location || '');
                ctype = String(resp?.headers?.['content-type'] || '').toLowerCase();
            }
            catch (e) {
                console.warn(`[${new Date().toISOString()}][prowlarr] resolveMagnet GET fallback failed`, { url, err: e?.message });
                return undefined;
            }
        }
        if (status >= 300 && status < 400 && location) {
            if (isMagnet(location)) {
                console.log(`[${new Date().toISOString()}][prowlarr] resolveMagnet redirect->magnet`, { hops, hash: (location.match(/btih:([^&]+)/i) || [])[1] });
                return location;
            }
            url = absoluteUrl(location, base);
            if (url.endsWith('.torrent')) {
                console.log(`[${new Date().toISOString()}][prowlarr] Captured .torrent URL: ${url}`);
                return `torrent:${url}`; // Return with prefix for caller to detect
            }
            continue;
        }
        if (ctype.includes('bittorrent') || url.endsWith('.torrent')) {
            console.log(`[${new Date().toISOString()}][prowlarr] Captured .torrent URL: ${url}`);
            return `torrent:${url}`; // Return with prefix for caller to detect
        }
        break;
    }
    return undefined;
}
