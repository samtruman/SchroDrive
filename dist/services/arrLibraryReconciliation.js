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
const organizerReview_1 = require("./organizerReview");
const tmdbService_1 = require("./tmdbService");
const arrTitleIdentity_1 = require("./arrTitleIdentity");
const manualIdentity_1 = require("./manualIdentity");
function normalize(value) {
    return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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
async function resolveArrRecordByParser(candidate, link, records) {
    const baseUrl = candidate.category === "movie" ? config_1.config.providerReconciliationRadarrUrl : config_1.config.providerReconciliationSonarrUrl;
    const apiKey = candidate.category === "movie" ? config_1.config.providerReconciliationRadarrApiKey : config_1.config.providerReconciliationSonarrApiKey;
    if (!baseUrl || !apiKey)
        return undefined;
    try {
        const url = baseUrl.replace(/\/$/, "") + "/api/v3/parse?title=" + encodeURIComponent(path.basename(link));
        const response = await fetch(url, { headers: { "X-Api-Key": apiKey, Accept: "application/json" } });
        if (!response.ok)
            return undefined;
        const parsed = await response.json();
        const media = candidate.category === "movie" ? (parsed.movie || parsed) : (parsed.series || parsed.tvSeries || parsed);
        const id = media?.id;
        if (id === undefined || id === null)
            return undefined;
        const record = records.find((item) => String(item.id || "") === String(id));
        if (!record)
            return undefined;
        if (candidate.category === "series" && !parsed.series && !parsed.tvSeries)
            return undefined;
        if (candidate.category === "movie" && !parsed.movie)
            return undefined;
        return record;
    }
    catch {
        return undefined;
    }
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
    const titleCandidates = [...new Set([folderTitle, parsed.title].filter((value) => Boolean(value)))];
    const resolvedTitle = numericMovie?.[1] || (releaseLikeFolder && parsed.title ? parsed.title : (folderTitle || parsed.title));
    const resolvedYear = numericMovie ? Number(numericMovie[2] || numericMovie[3]) : (parsed.year || (folderYear ? Number(folderYear) : undefined));
    if (category === "movies") {
        return { source, currentLink: link, category: "movie", title: resolvedTitle, titleCandidates, year: resolvedYear };
    }
    return {
        source,
        currentLink: link,
        category: "series",
        title: resolvedTitle,
        titleCandidates,
        year: parsed.year || (folderYear ? Number(folderYear) : undefined),
        season: parsed.season ?? (Number((parts.find((part) => /^Season\s+\d+$/i.test(part)) || "").replace(/\D/g, "")) || undefined),
    };
}
function findArrRecordByTmdb(tmdbId, records) {
    if (!tmdbId)
        return undefined;
    return records.find((item) => String(item.tmdbId || "") === tmdbId);
}
function findArrRecordByTitle(candidate, records) {
    const candidateTitles = [...new Set([candidate.title, ...(candidate.titleCandidates || [])].filter(Boolean).map((title) => (0, arrTitleIdentity_1.normalizeArrTitle)(title)))];
    if (!candidateTitles.length)
        return undefined;
    const titleMatches = records.filter((item) => candidateTitles.some((title) => (0, arrTitleIdentity_1.arrTitleAliases)(item).includes(title)));
    if (titleMatches.length === 1)
        return titleMatches[0];
    const yearMatches = titleMatches.filter((item) => !candidate.year || !item.year || Number(item.year) === candidate.year || Math.abs(Number(item.year) - candidate.year) === 1);
    return yearMatches.length === 1 ? yearMatches[0] : undefined;
}
function findArrRecord(candidate, records, tmdbId) {
    // ARR is authoritative for the path we must repair. Use the title/year
    // match first, then use TMDB only as a fallback when ARR metadata is enough
    // to identify the media but not enough to match its title spelling.
    return findArrRecordByTitle(candidate, records) || findArrRecordByTmdb(tmdbId, records);
}
function findArrRecordWithManualIdentity(candidate, records) {
    const manual = (0, manualIdentity_1.getManualIdentityOverride)({
        kind: candidate.category === "movie" ? "movie" : "episode",
        title: candidate.title,
        year: candidate.year,
        season: candidate.season,
    });
    const manualMatch = candidate.category === "movie" && manual?.tmdbId
        ? findArrRecordByTmdb(String(manual.tmdbId), records)
        : undefined;
    return manualMatch || findArrRecord(candidate, records);
}
function recordArrIdentityReview(candidate, link, reason) {
    const parsed = (0, mediaParser_1.parseMediaFilename)(path.basename(link), link);
    (0, organizerReview_1.recordOrganizerReview)(link, {
        ...parsed,
        status: "unmatched",
        kind: candidate.category === "movie" ? "movie" : "episode",
        title: candidate.title || parsed.title,
        year: candidate.year ?? parsed.year,
        season: candidate.season ?? parsed.season,
        reason,
    });
}
async function resolveTmdbId(candidate) {
    if (!candidate.title)
        return undefined;
    const result = await (0, tmdbService_1.searchTmdb)(candidate.title, candidate.category === "movie" ? "movie" : "tv", candidate.year, { retries: 1, timeoutMs: 5000 });
    return result.status === "matched" && result.metadata?.tmdbId ? String(result.metadata.tmdbId) : undefined;
}
async function removeEmptyOrganizedParents(start) {
    const root = path.resolve(config_1.config.organizedBase);
    let current = path.resolve(path.dirname(start));
    while (current.startsWith(root + path.sep)) {
        const relative = path.relative(root, current);
        if (!relative || relative.split(path.sep).length <= 1)
            break;
        const entries = await fsp.readdir(current).catch(() => null);
        if (!entries || entries.length > 0)
            break;
        await fsp.rmdir(current).catch(() => undefined);
        current = path.dirname(current);
    }
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
        await fsp.unlink(link);
        await removeEmptyOrganizedParents(link);
        return true;
    }
    else {
        await fsp.symlink(source, destination);
    }
    await fsp.unlink(link);
    await removeEmptyOrganizedParents(link);
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
        const records = candidate.category === "movie" ? movies : series;
        const arrTitleRecord = findArrRecordWithManualIdentity(candidate, records);
        const parserRecord = arrTitleRecord ? undefined : await resolveArrRecordByParser(candidate, link, records);
        const tmdbId = arrTitleRecord || parserRecord ? undefined : await resolveTmdbId(candidate).catch(() => undefined);
        const record = arrTitleRecord || parserRecord || findArrRecord(candidate, records, tmdbId);
        if (!record?.path) {
            const reason = record ? "arr-path-missing" : "arr-identity-unmatched";
            if (!record)
                recordArrIdentityReview(candidate, link, "ARR identity could not be matched by title/year or TMDB fallback");
            markUnresolved(candidate, reason);
            continue;
        }
        (0, organizerReview_1.resolveOrganizerReviewAutomatically)(link, "ARR identity and authoritative library path resolved during reconciliation");
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
