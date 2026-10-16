"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileOrganizedLibraryWithArr = reconcileOrganizedLibraryWithArr;
const fsp = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const config_1 = require("../core/config");
const mediaParser_1 = require("./mediaParser");
const tmdbService_1 = require("./tmdbService");
function normalize(value) {
    return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
function normalizeArrTitle(value) {
    // Sonarr may append a territory marker, e.g. `Ghosts (US)`.
    return normalize(value
        .replace(/\s*\((?:US|UK|AU|CA|IE|NZ)\)\s*$/i, "")
        .replace(/\s+(?:US|UK|AU|CA|IE|NZ)\s*$/i, ""));
}
function looksLikeReleasePath(value) {
    const base = path.basename(value).toLocaleLowerCase();
    return /(?:^|[. _-])(mkv|mp4|m4v|avi|mov)$/.test(base) ||
        /(?:2160p|1080p|720p|bluray|web[- .]?dl|webrip|hevc|x265|h[.]?264|mirc?rew|subs?)/i.test(base);
}
function inferredLibraryDirectory(link, candidate, organizedBase, record) {
    const relative = path.relative(organizedBase, link);
    const category = relative.split(path.sep)[0]?.toLowerCase();
    const expectedCategory = candidate.category === "movie" ? "movies" : "tv";
    if (category !== expectedCategory)
        return undefined;
    const directory = candidate.category === "movie"
        ? path.dirname(link)
        : path.dirname(path.dirname(link));
    const folderName = path.basename(directory);
    const folder = folderName.replace(/\s*\(\d{4}\)$/, "");
    const title = normalize(candidate.title || "");
    if (title && normalize(folder) === title)
        return directory;
    // A bootstrap scan can place a release-like folder under organized (for
    // example "2019 4K HDR ... (1917)"). Once ARR has identified the item,
    // derive the canonical library directory from ARR's title.
    if (!record.title)
        return undefined;
    const libraryRoot = path.join(organizedBase, candidate.category === "movie" ? "Movies" : "TV");
    const canonicalFolder = candidate.category === "movie" && (record.year || candidate.year)
        ? `${record.title} (${record.year || candidate.year})`
        : record.title;
    return path.join(libraryRoot, canonicalFolder);
}
function configured() {
    return Boolean(config_1.config.providerReconciliationRadarrUrl && config_1.config.providerReconciliationRadarrApiKey ||
        config_1.config.providerReconciliationSonarrUrl && config_1.config.providerReconciliationSonarrApiKey);
}
async function fetchArr(baseUrl, apiKey, endpoint) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v3/${endpoint}`, {
        headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
    if (!response.ok)
        throw new Error(`Arr ${endpoint} lookup failed: HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body) ? body : [];
}
async function walkSymlinks(root, out = []) {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        const stat = await fsp.lstat(full).catch(() => undefined);
        if (!stat)
            continue;
        if (stat.isDirectory())
            await walkSymlinks(full, out);
        else if (stat.isSymbolicLink())
            out.push(full);
    }
    return out;
}
function candidateFor(link, organizedBase) {
    const relative = path.relative(organizedBase, link);
    const parts = relative.split(path.sep);
    const category = parts[0]?.toLowerCase();
    const source = link;
    if (category !== "movies" && category !== "tv" && category !== "anime")
        return undefined;
    const parsed = (0, mediaParser_1.parseMediaFilename)(path.basename(link), link);
    const rawFolderTitle = parts[1] || "";
    const folderTitle = rawFolderTitle.replace(/\s*\(\d{4}\)$/, "");
    const folderYear = rawFolderTitle.match(/\((\d{4})\)$/)?.[1];
    const releaseLikeFolder = looksLikeReleasePath(rawFolderTitle) || /^\d{4}\b/.test(rawFolderTitle);
    const numericMovie = path.basename(link).match(/^(\d{1,4})[._\s-]+(?:\(((?:19|20|21)\d{2})\)|((?:19|20|21)\d{2}))(?:[._\s-]|$)/i);
    const resolvedTitle = numericMovie?.[1] || (releaseLikeFolder && parsed.title ? parsed.title : (folderTitle || parsed.title));
    const resolvedYear = numericMovie ? Number(numericMovie[2] || numericMovie[3]) : (parsed.year || (folderYear ? Number(folderYear) : undefined));
    if (category === "movies") {
        return { source, currentLink: link, category: "movie", title: resolvedTitle, year: resolvedYear };
    }
    return {
        source,
        currentLink: link,
        category: "series",
        title: resolvedTitle,
        year: parsed.year || (folderYear ? Number(folderYear) : undefined),
        season: parsed.season ?? (Number((parts.find((part) => /^Season\s+\d+$/i.test(part)) || "").replace(/\D/g, "")) || undefined),
    };
}
function findArrRecord(candidate, tmdbId, records) {
    if (tmdbId) {
        const byTmdb = records.find((item) => String(item.tmdbId || "") === tmdbId);
        if (byTmdb)
            return byTmdb;
    }
    const exact = records.find((item) => normalize(item.title || "") === normalize(candidate.title || ""));
    if (exact)
        return exact;
    const candidateTitle = normalizeArrTitle(candidate.title || "");
    if (!candidateTitle)
        return undefined;
    const aliases = records.filter((item) => normalizeArrTitle(item.title || "") === candidateTitle);
    // Do not guess when two regional variants are configured.
    return aliases.length === 1 ? aliases[0] : undefined;
}
async function resolveTmdbId(candidate) {
    if (!candidate.title)
        return undefined;
    const result = await (0, tmdbService_1.searchTmdb)(candidate.title, candidate.category === "movie" ? "movie" : "tv", candidate.year, { retries: 1, timeoutMs: 5000 });
    return result.status === "matched" && result.metadata?.tmdbId ? String(result.metadata.tmdbId) : undefined;
}
async function moveSymlink(link, destination) {
    if (path.normalize(link) === path.normalize(destination))
        return false;
    const rawSource = await fsp.readlink(link).catch(() => undefined);
    if (!rawSource)
        return false;
    // Organizer-created links are relative, while provider-reconciliation
    // links are absolute. Resolve the old link before moving it so a relative
    // target does not silently become relative to the new Arr directory.
    const source = path.isAbsolute(rawSource)
        ? rawSource
        : path.resolve(path.dirname(link), rawSource);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const existing = await fsp.lstat(destination).catch(() => undefined);
    if (existing) {
        if (!existing.isSymbolicLink())
            return false;
        const rawExistingTarget = await fsp.readlink(destination).catch(() => undefined);
        if (!rawExistingTarget)
            return false;
        const existingTarget = path.isAbsolute(rawExistingTarget)
            ? rawExistingTarget
            : path.resolve(path.dirname(destination), rawExistingTarget);
        if (path.normalize(existingTarget) !== path.normalize(source))
            return false;
    }
    else {
        await fsp.symlink(source, destination);
    }
    await fsp.unlink(link);
    return true;
}
async function requestArrRescan(category, recordId) {
    const baseUrl = category === "movie" ? config_1.config.providerReconciliationRadarrUrl : config_1.config.providerReconciliationSonarrUrl;
    const apiKey = category === "movie" ? config_1.config.providerReconciliationRadarrApiKey : config_1.config.providerReconciliationSonarrApiKey;
    if (!baseUrl || !apiKey)
        return;
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v3/command`, {
        method: "POST",
        headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
            name: category === "movie" ? "RescanMovie" : "RescanSeries",
            [category === "movie" ? "movieId" : "seriesId"]: recordId,
        }),
    });
    if (!response.ok)
        throw new Error(`Arr rescan failed: HTTP ${response.status}`);
}
async function repairArrPath(category, record, destination) {
    if (!record.id || !record.path || path.normalize(record.path) === path.normalize(destination))
        return;
    const baseUrl = category === "movie" ? config_1.config.providerReconciliationRadarrUrl : config_1.config.providerReconciliationSonarrUrl;
    const apiKey = category === "movie" ? config_1.config.providerReconciliationRadarrApiKey : config_1.config.providerReconciliationSonarrApiKey;
    if (!baseUrl || !apiKey)
        return;
    const endpoint = category === "movie" ? "movie" : "series";
    const url = `${baseUrl.replace(/\/$/, "")}/api/v3/${endpoint}/${record.id}`;
    const current = await fetch(url, { headers: { "X-Api-Key": apiKey, Accept: "application/json" } });
    if (!current.ok)
        throw new Error(`Arr ${endpoint} ${record.id} lookup failed: HTTP ${current.status}`);
    const body = await current.json();
    body.path = destination;
    const response = await fetch(`${url}?moveFiles=false&moveMovie=false&moveSeries=false&sendUpdatesToClient=false`, {
        method: "PUT",
        headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok)
        throw new Error(`Arr ${endpoint} ${record.id} path update failed: HTTP ${response.status}`);
}
/**
 * Reconciles links created by both the bootstrap organizer and later
 * AllDebrid manifest scans with the authoritative Radarr/Sonarr library path.
 * It is deliberately symlink-only and safe to run repeatedly.
 */
async function reconcileOrganizedLibraryWithArr() {
    if (!configured())
        return { scanned: 0, moved: 0, unresolved: 0, unresolvedByReason: {}, unresolvedSamples: [] };
    const organizedBase = config_1.config.organizedBase;
    const links = [];
    for (const category of ["Movies", "TV", "Anime"]) {
        links.push(...await walkSymlinks(path.join(organizedBase, category)));
    }
    let movies = [];
    let series = [];
    if (config_1.config.providerReconciliationRadarrUrl && config_1.config.providerReconciliationRadarrApiKey) {
        try {
            movies = await fetchArr(config_1.config.providerReconciliationRadarrUrl, config_1.config.providerReconciliationRadarrApiKey, "movie");
        }
        catch (error) {
            console.warn(`[${new Date().toISOString()}][organize] Radarr path reconciliation unavailable`, { err: error?.message || String(error) });
        }
    }
    if (config_1.config.providerReconciliationSonarrUrl && config_1.config.providerReconciliationSonarrApiKey) {
        try {
            series = await fetchArr(config_1.config.providerReconciliationSonarrUrl, config_1.config.providerReconciliationSonarrApiKey, "series");
        }
        catch (error) {
            console.warn(`[${new Date().toISOString()}][organize] Sonarr path reconciliation unavailable`, { err: error?.message || String(error) });
        }
    }
    let moved = 0;
    let unresolved = 0;
    const unresolvedByReason = {};
    const unresolvedSamples = [];
    const markUnresolved = (candidate, reason) => {
        unresolved++;
        unresolvedByReason[reason] = (unresolvedByReason[reason] || 0) + 1;
        if (unresolvedSamples.length < 20)
            unresolvedSamples.push({ title: candidate.title, path: candidate.currentLink, reason });
    };
    const rescannedRecords = new Set();
    for (const link of links) {
        const candidate = candidateFor(link, organizedBase);
        if (!candidate)
            continue;
        const tmdbId = await resolveTmdbId(candidate).catch(() => undefined);
        const records = candidate.category === "movie" ? movies : series;
        const record = findArrRecord(candidate, tmdbId, records);
        if (!record?.path) {
            markUnresolved(candidate, record ? "arr-path-missing" : "arr-identity-unmatched");
            continue;
        }
        let authoritativePath = record.path;
        let pathRepaired = false;
        if (authoritativePath && looksLikeReleasePath(authoritativePath)) {
            const inferred = inferredLibraryDirectory(link, candidate, organizedBase, record);
            if (!inferred) {
                markUnresolved(candidate, "release-path-without-safe-library-directory");
                console.warn(`[${new Date().toISOString()}][organize] ARR path looks like a release path; no safe library directory`, {
                    title: record.title,
                    path: authoritativePath,
                });
                continue;
            }
            try {
                await repairArrPath(candidate.category, record, inferred);
                authoritativePath = inferred;
                pathRepaired = true;
            }
            catch (error) {
                markUnresolved(candidate, "arr-path-repair-failed");
                console.warn(`[${new Date().toISOString()}][organize] ARR path repair deferred`, {
                    title: record.title,
                    path: authoritativePath,
                    inferred,
                    err: error?.message || String(error),
                });
                continue;
            }
        }
        const destination = candidate.category === "series" && candidate.season
            ? path.join(authoritativePath, `Season ${String(candidate.season).padStart(2, "0")}`, path.basename(link))
            : path.join(authoritativePath, path.basename(link));
        const movedThisLink = await moveSymlink(link, destination);
        if (movedThisLink)
            moved++;
        if (record.id) {
            const rescanKey = `${candidate.category}:${record.id}`;
            if (!rescannedRecords.has(rescanKey)) {
                rescannedRecords.add(rescanKey);
                try {
                    await requestArrRescan(candidate.category, record.id);
                }
                catch (error) {
                    console.warn(`[${new Date().toISOString()}][organize] Arr rescan deferred after path reconciliation`, {
                        title: record.title,
                        err: error?.message || String(error),
                    });
                }
            }
        }
    }
    return { scanned: links.length, moved, unresolved, unresolvedByReason, unresolvedSamples };
}
