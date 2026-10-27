"use strict";
/**
 * Provider-agnostic direct-file reconciliation for mounted debrid providers.
 *
 * Providers do not need a push change feed for this path: the adapter
 * reconciles read-only torrent status plus completed file trees, emits stable
 * direct-file events, and hands added/changed files to Arr. It is deliberately
 * opt-in and separate from provider delete/repair lifecycle services.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderReconciliationWorker = exports.ProviderReconciliationIntake = exports.ProviderSnapshotSource = exports.HttpArrClient = exports.SqliteIntakeStateStore = exports.InMemoryIntakeStateStore = void 0;
exports.propagateDeletedFile = propagateDeletedFile;
exports.isMediaFile = isMediaFile;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const db_1 = require("../core/db");
const config_1 = require("../core/config");
const mediaClassifier_1 = require("../core/mediaClassifier");
const mediaParser_1 = require("./mediaParser");
const tmdbService_1 = require("./tmdbService");
const arrTitleIdentity_1 = require("./arrTitleIdentity");
const manualIdentity_1 = require("./manualIdentity");
class ProviderMountNotReadyError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProviderMountNotReadyError";
    }
}
class InMemoryIntakeStateStore {
    constructor() {
        this.items = new Map();
        this.events = new Map();
        this.cursor = {};
    }
    getItem(id) { return this.items.get(id); }
    listItems() { return [...this.items.values()]; }
    saveItem(state) { this.items.set(state.providerItemId, state); }
    hasEvent(key) { return this.events.has(key); }
    saveEvent(event) { this.events.set(event.stableDedupeKey, event); }
    getCursor() { return { ...this.cursor }; }
    saveCursor(mode, observedAt) { this.cursor[mode === 'recent' ? 'recentAt' : 'fullAt'] = observedAt; }
}
exports.InMemoryIntakeStateStore = InMemoryIntakeStateStore;
/** Persistent reconciliation state in the configured SchröDrive DB. */
class SqliteIntakeStateStore {
    constructor() {
        (0, db_1.getDb)().exec(`CREATE TABLE IF NOT EXISTS provider_reconciliation_intake (
      provider_item_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
        (0, db_1.getDb)().exec(`CREATE TABLE IF NOT EXISTS provider_reconciliation_events (
      dedupe_key TEXT PRIMARY KEY,
      event_json TEXT NOT NULL,
      arr_json TEXT,
      created_at INTEGER NOT NULL
    )`);
        (0, db_1.getDb)().exec(`CREATE TABLE IF NOT EXISTS provider_reconciliation_cursor (
      name TEXT PRIMARY KEY,
      observed_at TEXT NOT NULL
    )`);
    }
    getItem(id) {
        const row = (0, db_1.getDb)().prepare('SELECT state_json FROM provider_reconciliation_intake WHERE provider_item_id = ?').get(id);
        return row?.state_json ? JSON.parse(row.state_json) : undefined;
    }
    listItems() {
        return (0, db_1.getDb)().prepare('SELECT state_json FROM provider_reconciliation_intake').all()
            .flatMap((row) => { try {
            return [JSON.parse(row.state_json)];
        }
        catch {
            return [];
        } });
    }
    saveItem(state) {
        (0, db_1.getDb)().prepare(`INSERT INTO provider_reconciliation_intake(provider_item_id,state_json,updated_at)
      VALUES (?,?,?) ON CONFLICT(provider_item_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at`)
            .run(state.providerItemId, JSON.stringify(state), Date.parse(state.updatedAt));
    }
    hasEvent(key) {
        return !!(0, db_1.getDb)().prepare('SELECT 1 FROM provider_reconciliation_events WHERE dedupe_key = ?').get(key);
    }
    saveEvent(event, arr) {
        (0, db_1.getDb)().prepare(`INSERT OR IGNORE INTO provider_reconciliation_events(dedupe_key,event_json,arr_json,created_at)
      VALUES (?,?,?,?)`).run(event.stableDedupeKey, JSON.stringify(event), arr ? JSON.stringify(arr) : null, Date.parse(event.observedAt));
    }
    getCursor() {
        const rows = (0, db_1.getDb)().prepare('SELECT name, observed_at FROM provider_reconciliation_cursor').all();
        return Object.fromEntries(rows.map((row) => [row.name === 'recent' ? 'recentAt' : 'fullAt', row.observed_at]));
    }
    saveCursor(mode, observedAt) {
        (0, db_1.getDb)().prepare(`INSERT INTO provider_reconciliation_cursor(name,observed_at) VALUES (?,?)
      ON CONFLICT(name) DO UPDATE SET observed_at=excluded.observed_at`).run(mode, observedAt);
    }
}
exports.SqliteIntakeStateStore = SqliteIntakeStateStore;
class HttpArrClient {
    async submitScan(route, event) {
        let commandName = route.kind === 'radarr' ? 'DownloadedMoviesScan' : 'DownloadedEpisodesScan';
        const providerPath = route.sourcePathPrefix
            ? `${route.sourcePathPrefix.replace(/\/$/, '')}/${event.path.replace(/^\/+/, '')}`
            : event.path;
        if (route.stagingPath) {
            await refreshProviderMount(route, event);
            await waitForProviderMount(route, event);
            const scanPath = await exposeAsArrStaging(route, event);
            return this.submitCommand(route, { name: commandName, path: scanPath, importMode: route.importMode || 'Copy' });
        }
        const arrEntity = route.symlinkLibraryPath ? await findArrEntity(route, event) : undefined;
        const arrPath = arrEntity?.path;
        if (route.symlinkLibraryPath && !arrPath) {
            throw new Error(`Arr ${route.kind} path is unavailable for this item; deferring provider reconciliation instead of creating a canonical fallback`);
        }
        const scanPath = route.symlinkLibraryPath
            ? await exposeAsSymlink(route, event, providerPath, arrPath)
            : providerPath;
        let commandBody = { name: commandName, path: scanPath, importMode: route.importMode || 'Copy' };
        if (route.symlinkLibraryPath) {
            if (arrEntity?.id !== undefined) {
                commandName = route.kind === 'radarr' ? 'RescanMovie' : 'RescanSeries';
                commandBody = { name: commandName, [route.kind === 'radarr' ? 'movieId' : 'seriesId']: arrEntity.id };
            }
        }
        return this.submitCommand(route, commandBody);
    }
    async submitCommand(route, commandBody) {
        const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/command`, {
            method: 'POST',
            headers: { 'X-Api-Key': route.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(commandBody),
        });
        if (!response.ok)
            throw new Error(`Arr command submission failed: HTTP ${response.status}`);
        const body = await response.json();
        if (!body.id)
            throw new Error('Arr command response did not include an id');
        return { commandId: String(body.id), status: body.status || 'queued', result: body.result };
    }
    async getCommand(route, commandId) {
        const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/command/${encodeURIComponent(commandId)}`, {
            headers: { 'X-Api-Key': route.apiKey },
        });
        if (!response.ok)
            throw new Error(`Arr command status failed: HTTP ${response.status}`);
        const body = await response.json();
        return { commandId, status: body.status || 'unknown', result: body.result };
    }
}
exports.HttpArrClient = HttpArrClient;
async function fetchArrEntities(route, endpoint) {
    const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/${endpoint}`, {
        headers: { 'X-Api-Key': route.apiKey },
    });
    if (!response.ok)
        throw new Error(`Arr ${endpoint} lookup failed: HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body) ? body : [];
}
async function parseArrEntity(route, filename) {
    const endpoint = route.kind === 'radarr' ? 'movie' : 'series';
    const response = await fetch(route.baseUrl.replace(/\/$/, '') + '/api/v3/parse?title=' + encodeURIComponent(filename), { headers: { 'X-Api-Key': route.apiKey } });
    if (!response.ok)
        return undefined;
    const body = await response.json();
    const entity = body[endpoint];
    return entity && typeof entity === 'object' ? entity : undefined;
}
async function findArrEntity(route, event) {
    const filename = node_path_1.default.basename(event.path);
    const parsed = (0, mediaParser_1.parseMediaFilename)(filename, event.path);
    const manual = (0, manualIdentity_1.getManualIdentityOverrideForProviderSource)(event.provider, event.path, {
        kind: route.kind === 'radarr' ? 'movie' : 'episode',
        title: parsed.title,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
    });
    const title = (0, arrTitleIdentity_1.normalizeArrTitle)(parsed.title || event.path.split('/').filter(Boolean).slice(-2, -1)[0] || '');
    const endpoint = route.kind === 'radarr' ? 'movie' : 'series';
    const kind = route.kind === 'radarr' ? 'movie' : 'tv';
    const records = await fetchArrEntities(route, endpoint);
    if (manual?.tmdbId) {
        const manualMatch = records.find((record) => record.id && String(record.tmdbId || '') === String(manual.tmdbId));
        if (manualMatch)
            return manualMatch;
    }
    const titleMatches = records.filter((record) => {
        if (!record.id || !(0, arrTitleIdentity_1.arrTitleAliases)(record).includes(title))
            return false;
        return true;
    });
    // Let Arr parse the release first. If it identifies an entity that is not
    // configured in this Arr instance, fail closed instead of guessing by title.
    const parsedEntity = await parseArrEntity(route, filename);
    if (parsedEntity?.id) {
        return records.find((record) => String(record.id) === String(parsedEntity.id));
    }
    // The year is secondary evidence: it disambiguates duplicate ARR titles,
    // but a distant remake must not be accepted as a unique match.
    const nearYearMatches = titleMatches.filter((record) => {
        if (!parsed.year || !record.year)
            return true;
        return Math.abs(Number(record.year) - parsed.year) <= 1;
    });
    if (nearYearMatches.length === 1)
        return nearYearMatches[0];
    // Use Arr's own metadata lookup for canonical TMDb identity, then map it
    // back to an already configured record. No second TMDb credential is needed.
    const lookup = await fetchArrEntities(route, `${endpoint}/lookup?term=${encodeURIComponent(parsed.title || filename)}`);
    const yearMatches = lookup.filter((candidate) => {
        if (!parsed.year || !candidate.year)
            return true;
        return Math.abs(Number(candidate.year) - parsed.year) <= 1;
    });
    const tmdbIds = new Set(yearMatches.map((candidate) => String(candidate.tmdbId || '')).filter(Boolean));
    const tmdbMatches = records.filter((record) => record.id && tmdbIds.has(String(record.tmdbId || '')));
    if (tmdbMatches.length === 1)
        return tmdbMatches[0];
    // ARR is authoritative. TMDB is only a fallback when ARR title aliases do
    // not produce one unambiguous result.
    const canonical = parsed.title ? await resolveCanonicalMetadata(parsed.title, kind, parsed.year) : undefined;
    const matchByTmdb = canonical?.tmdbId
        ? records.find((record) => record.id && String(record.tmdbId || '') === canonical.tmdbId)
        : undefined;
    return matchByTmdb;
}
function safeSegment(value) {
    return value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Unknown';
}
function safeRelativeMediaPath(value) {
    const segments = value.split(/[\\/]+/).filter(Boolean).filter((segment) => segment !== '.' && segment !== '..');
    return segments.map(safeSegment).join(node_path_1.default.sep) || 'media-file';
}
const canonicalMetadataCache = new Map();
async function resolveCanonicalMetadata(title, kind, year) {
    const key = `${kind}:${title.toLocaleLowerCase()}:${year || ''}`;
    if (canonicalMetadataCache.has(key))
        return canonicalMetadataCache.get(key) || undefined;
    const result = await (0, tmdbService_1.searchTmdb)(title, kind, year, { retries: 1, timeoutMs: 5000 });
    const metadata = result.status === 'matched' && result.metadata
        ? { tmdbId: result.metadata.tmdbId, title: result.metadata.title, year: result.metadata.year }
        : null;
    canonicalMetadataCache.set(key, metadata);
    return metadata || undefined;
}
/**
 * Creates the Arr-facing library entry without copying provider data. The
 * target is deliberately a symlink into the shared SchröDrive mount.
 */
async function exposeAsSymlink(route, event, providerPath, arrPath) {
    const libraryRoot = node_path_1.default.resolve(route.symlinkLibraryPath);
    const authoritativeRoot = node_path_1.default.resolve(arrPath);
    if (authoritativeRoot !== libraryRoot && !authoritativeRoot.startsWith(`${libraryRoot}${node_path_1.default.sep}`)) {
        throw new Error(`Refusing Arr path outside configured symlink library: ${arrPath}`);
    }
    const filename = node_path_1.default.basename(event.path);
    const parsed = (0, mediaParser_1.parseMediaFilename)(filename, event.path);
    const destination = event.sourceCategory === 'Shows' && parsed.season
        ? node_path_1.default.join(arrPath, `Season ${String(parsed.season).padStart(2, '0')}`, filename)
        : node_path_1.default.join(arrPath, filename);
    const directory = node_path_1.default.dirname(destination);
    await node_fs_1.promises.mkdir(directory, { recursive: true });
    const existing = await node_fs_1.promises.lstat(destination).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
        const current = await node_fs_1.promises.readlink(destination);
        if (current === providerPath)
            return destination;
        // Multiple providers may expose the same title. Keep the first healthy
        // provider-backed link instead of oscillating the library on every poll.
        return destination;
    }
    else if (existing) {
        throw new Error(`Refusing to overwrite non-symlink Arr library entry: ${destination}`);
    }
    // Use the container-visible absolute mount path. A relative link would be
    // resolved against the host bind source, which differs between SchröDrive
    // and Arr containers.
    await node_fs_1.promises.symlink(providerPath, destination);
    return destination;
}
/**
 * Uses the same staging contract as the qBittorrent-compatible bridge.
 * ARR receives the staging directory and is responsible for parsing the
 * release, creating its canonical folder, and importing the media.
 */
async function exposeAsArrStaging(route, event) {
    const stagingRoot = node_path_1.default.resolve(route.stagingPath);
    const stagingDirectory = node_path_1.default.join(stagingRoot, safeSegment(`${event.provider}-${event.providerItemId}`));
    const firstTreePath = String(event.tree[0]?.path || node_path_1.default.basename(event.path)).replace(/^[/\\]+/, '');
    const eventPath = event.path.replace(/^[/\\]+/, '');
    const prefix = eventPath.endsWith(firstTreePath)
        ? eventPath.slice(0, -firstTreePath.length)
        : `${node_path_1.default.dirname(eventPath).replace(/\\/g, '/')}/`;
    const files = event.tree.length > 0 ? event.tree : [{ path: node_path_1.default.basename(event.path), size: 0 }];
    await node_fs_1.promises.mkdir(stagingDirectory, { recursive: true });
    for (const file of files) {
        const relativeFile = String(file.path).replace(/^[/\\]+/, '');
        const providerRelativePath = `${prefix}${relativeFile}`.replace(/\\/g, '/');
        const providerPath = route.sourcePathPrefix
            ? `${route.sourcePathPrefix.replace(/\/$/, '')}/${providerRelativePath}`
            : providerRelativePath;
        const destination = node_path_1.default.join(stagingDirectory, safeRelativeMediaPath(relativeFile));
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(destination), { recursive: true });
        const existing = await node_fs_1.promises.lstat(destination).catch(() => undefined);
        if (existing?.isSymbolicLink()) {
            const current = await node_fs_1.promises.readlink(destination);
            if (current === providerPath)
                continue;
            await node_fs_1.promises.unlink(destination);
        }
        else if (existing) {
            throw new Error(`Refusing to overwrite non-symlink ARR staging entry: ${destination}`);
        }
        await node_fs_1.promises.symlink(providerPath, destination);
    }
    return stagingDirectory;
}
async function refreshProviderMount(route, event) {
    if (route.mountRefreshUrl) {
        try {
            const response = await fetch(route.mountRefreshUrl, { method: "POST" });
            if (!response.ok)
                console.warn("[provider-reconciliation] provider mount refresh returned HTTP " + response.status);
        }
        catch (error) {
            console.warn("[provider-reconciliation] provider mount refresh unavailable; continuing with rclone/readiness refresh", error);
        }
    }
    if (!event || config_1.config.mountRcloneRcPort <= 0 || !route.sourcePathPrefix)
        return;
    const providerName = node_path_1.default.basename(route.sourcePathPrefix);
    const providerIndex = Math.max(0, config_1.config.providers.indexOf(providerName));
    const rcUrl = `http://127.0.0.1:${config_1.config.mountRcloneRcPort + providerIndex}/vfs/refresh`;
    const parts = event.path.replace(/^\/+|\/+$/g, "").split("/");
    const directory = parts.length >= 2 ? `/${parts.slice(0, 2).join("/")}` : `/${parts[0] || ""}`;
    try {
        const response = await fetch(rcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: directory, recursive: false }),
        });
        if (!response.ok)
            console.warn("[provider-reconciliation] rclone VFS refresh returned HTTP " + response.status);
    }
    catch (error) {
        console.warn("[provider-reconciliation] rclone VFS refresh unavailable; continuing with readiness polling", error);
    }
}
async function waitForProviderMount(route, event) {
    if (!route.sourcePathPrefix)
        return;
    const timeoutMs = Math.max(0, route.mountReadyTimeoutMs ?? 0);
    if (timeoutMs === 0)
        return;
    const pollMs = Math.max(50, route.mountReadyPollMs ?? 500);
    const paths = providerTreePaths(route, event);
    if (paths.length === 0)
        return;
    const deadline = Date.now() + timeoutMs;
    let missing = paths;
    do {
        missing = [];
        for (const candidate of paths) {
            try {
                const stat = await node_fs_1.promises.stat(candidate);
                if (!stat.isFile())
                    missing.push(candidate);
            }
            catch {
                missing.push(candidate);
            }
        }
        if (missing.length === 0)
            return;
        if (Date.now() >= deadline)
            break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    } while (Date.now() < deadline);
    throw new ProviderMountNotReadyError("Provider mount not ready for " + event.provider + ":" + event.providerItemId + "; missing " + missing.length + " file(s) after " + timeoutMs + "ms");
}
function providerTreePaths(route, event) {
    if (!route.sourcePathPrefix)
        return [];
    const firstTreePath = String(event.tree[0]?.path || node_path_1.default.basename(event.path)).replace(/^[/\\]+/, "");
    const eventPath = event.path.replace(/^[/\\]+/, "");
    const prefix = eventPath.endsWith(firstTreePath)
        ? eventPath.slice(0, -firstTreePath.length)
        : node_path_1.default.dirname(eventPath).replace(/\\/g, "/") + "/";
    const files = event.tree.length > 0 ? event.tree : [{ path: node_path_1.default.basename(event.path), size: 0 }];
    const sourceRoot = route.sourcePathPrefix.replace(/\/$/, "");
    return files.map((file) => {
        const relativeFile = String(file.path).replace(/^[/\\]+/, "");
        return sourceRoot + "/" + (prefix + relativeFile).replace(/\\/g, "/");
    });
}
async function removeMatchingSymlinks(root, targets) {
    let removed = 0;
    async function visit(current) {
        const entries = await node_fs_1.promises.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const candidate = node_path_1.default.join(current, entry.name);
            if (entry.isSymbolicLink()) {
                const link = await node_fs_1.promises.readlink(candidate).catch(() => undefined);
                if (link && targets.has(node_path_1.default.normalize(link))) {
                    await node_fs_1.promises.unlink(candidate);
                    removed += 1;
                }
            }
            else if (entry.isDirectory()) {
                await visit(candidate);
            }
        }
    }
    await visit(root);
    return removed;
}
async function propagateDeletedFile(route, event, options = {}) {
    const providerPath = route.sourcePathPrefix
        ? `${route.sourcePathPrefix.replace(/\/$/, '')}/${event.path.replace(/^\/+/, '')}`
        : event.path;
    const targets = new Set([node_path_1.default.normalize(providerPath)]);
    const roots = [route.symlinkLibraryPath, route.stagingPath].filter((value) => Boolean(value));
    const removedSymlinks = (await Promise.all(roots.map((root) => removeMatchingSymlinks(root, targets))))
        .reduce((sum, count) => sum + count, 0);
    if (options.refreshArr === false)
        return { removedSymlinks };
    if (!route.baseUrl || !route.apiKey)
        return { removedSymlinks, warning: 'ARR route is not configured' };
    const arrEntity = await findArrEntity(route, event);
    if (!arrEntity?.id)
        return { removedSymlinks, warning: `No unambiguous ${route.kind} entity matched deleted path` };
    const commandName = route.kind === 'radarr' ? 'RescanMovie' : 'RescanSeries';
    const commandBody = { name: commandName, [route.kind === 'radarr' ? 'movieId' : 'seriesId']: arrEntity.id };
    const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/command`, {
        method: 'POST',
        headers: { 'X-Api-Key': route.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(commandBody),
    });
    if (!response.ok)
        throw new Error(`Arr delete reconciliation failed: HTTP ${response.status}`);
    const body = await response.json();
    if (!body.id)
        throw new Error('Arr delete reconciliation response did not include an id');
    return { removedSymlinks, arrEntityId: arrEntity.id, arrCommandId: String(body.id) };
}
/** Adapts SchröDrive's common provider contract to reconciliation snapshots. */
class ProviderSnapshotSource {
    constructor(provider, namespaceIds = true) {
        this.provider = provider;
        this.namespaceIds = namespaceIds;
    }
    async listSnapshot() {
        const observedAt = new Date().toISOString();
        const torrents = await this.provider.listTorrents();
        const directories = await this.provider.fetchDirectories();
        const trees = new Map(directories.map((directory) => [String(directory.id), directory]));
        return this.toSnapshots(torrents, trees, observedAt);
    }
    async listRecentSnapshot(limit, knownProviderItemIds = []) {
        const observedAt = new Date().toISOString();
        const allTorrents = await this.provider.listTorrents();
        const knownIds = new Set(knownProviderItemIds.map((value) => {
            const text = String(value);
            const separator = text.indexOf(":");
            return separator >= 0 ? text.slice(separator + 1) : text;
        }));
        const recent = allTorrents
            .sort((a, b) => (b.addedAt?.getTime() || 0) - (a.addedAt?.getTime() || 0))
            .slice(0, Math.max(0, limit));
        const selected = new Map(recent.map((torrent) => [String(torrent.id), torrent]));
        for (const torrent of allTorrents) {
            if (knownIds.has(String(torrent.id)))
                selected.set(String(torrent.id), torrent);
        }
        const torrents = [...selected.values()];
        const directories = this.provider.fetchDirectoriesForIds
            ? await this.provider.fetchDirectoriesForIds(torrents)
            : await this.provider.fetchDirectories();
        return this.toSnapshots(torrents, new Map(directories.map((directory) => [String(directory.id), directory])), observedAt);
    }
    toSnapshots(torrents, trees, observedAt) {
        return torrents.map((torrent) => {
            const directory = trees.get(String(torrent.id));
            return { provider: this.provider.id, providerItemId: this.namespaceIds ? `${this.provider.id}:${torrent.id}` : String(torrent.id), name: torrent.name, directoryName: directory?.name || directory?.originalName, status: torrent.status, progress: torrent.progress,
                files: ((directory?.files?.length ? directory.files : torrent.files) || []).map((file) => ({ path: 'path' in file ? file.path : file.name, size: file.size })), observedAt };
        });
    }
}
exports.ProviderSnapshotSource = ProviderSnapshotSource;
const VIDEO_EXTENSIONS = new Set(['3g2', '3gp', 'avi', 'flv', 'mkv', 'mk3d', 'm4v', 'mov', 'mp2', 'mp4', 'mpe', 'mpeg', 'mpg', 'mpv', 'ts', 'm2ts', 'webm', 'wmv', 'ogm']);
// Keep subtitles and sidecar subtitle attachments with the video tree.
const SUBTITLE_EXTENSIONS = new Set(['ass', 'idx', 'mpsub', 'sbv', 'smi', 'srt', 'ssa', 'sub', 'sup', 'vtt']);
function isMediaFile(filePath) {
    const extension = filePath.split('.').pop()?.toLowerCase() || '';
    return VIDEO_EXTENSIONS.has(extension) || SUBTITLE_EXTENSIONS.has(extension);
}
function categoryFor(snapshot) {
    return (0, mediaClassifier_1.classifyTorrent)(snapshot.name, snapshot.files.map((file) => file.path)) === 'shows' ? 'Shows' : 'Movies';
}
function isFinished(snapshot) {
    const status = snapshot.status.toLowerCase();
    return snapshot.progress === undefined
        ? ['finished', 'downloaded', 'completed', 'seeding', 'ready', 'cached'].includes(status)
        : snapshot.progress >= 100 || ['finished', 'downloaded', 'completed', 'seeding', 'ready', 'cached'].includes(status);
}
function fingerprint(snapshot) {
    return (0, node_crypto_1.createHash)('sha256').update(JSON.stringify({ id: snapshot.providerItemId, status: snapshot.status, files: snapshot.files })).digest('hex');
}
function eventKey(provider, id, action, fp) {
    return `${provider}:${id}:${action}:${fp}`;
}
class ProviderReconciliationIntake {
    constructor(source, arr, store, options) {
        this.source = source;
        this.arr = arr;
        this.store = store;
        this.options = options;
    }
    async reconcile(mode = 'full', recentLimit = 30) {
        await this.pollPendingCommands();
        const knownProviderItemIds = mode === 'recent'
            ? this.store.listItems().filter((item) => item.lastAction !== 'deleted').map((item) => item.providerItemId)
            : [];
        const current = mode === 'recent' && this.source.listRecentSnapshot
            ? await this.source.listRecentSnapshot(recentLimit, knownProviderItemIds)
            : await this.source.listSnapshot();
        const seen = new Set(current.map((item) => item.providerItemId));
        const events = [];
        for (const item of current) {
            if (!isFinished(item) || item.files.length === 0)
                continue;
            item.files = item.files.filter((file) => isMediaFile(file.path));
            if (item.files.length === 0)
                continue;
            const prior = this.store.getItem(item.providerItemId);
            const nextFingerprint = fingerprint(item);
            const action = !prior || prior.lastAction === 'deleted'
                ? 'added' : prior.fingerprint === nextFingerprint ? undefined : 'changed';
            const retryEvent = !action && prior
                ? this.makeEvent(item, prior.lastAction === 'deleted' ? 'added' : prior.lastAction, nextFingerprint)
                : undefined;
            const retryPendingReview = Boolean(retryEvent && this.options.shouldRetry?.(retryEvent));
            if (!action && !retryPendingReview)
                continue;
            const event = action ? this.makeEvent(item, action, nextFingerprint) : retryEvent;
            await this.dispatch(event, item, nextFingerprint, retryPendingReview);
            events.push(event);
        }
        // A missing status-list item is a removal, but an item still processing is not.
        for (const previous of mode === 'full' ? this.store.listItems().filter((item) => item.lastAction !== 'deleted') : []) {
            if (seen.has(previous.providerItemId))
                continue;
            const event = {
                provider: previous.provider || 'alldebrid', providerItemId: previous.providerItemId, action: 'deleted',
                path: previous.path, tree: [], sourceCategory: previous.sourceCategory,
                observedAt: new Date().toISOString(), stableDedupeKey: eventKey(previous.provider || 'alldebrid', previous.providerItemId, 'deleted', previous.fingerprint),
            };
            if (!this.store.hasEvent(event.stableDedupeKey)) {
                await this.options.onEvent?.(event);
                this.store.saveEvent(event);
                this.store.saveItem({ ...previous, tree: previous.tree || [], lastAction: 'deleted', updatedAt: event.observedAt });
                await this.options.onDeleted?.(event);
                events.push(event);
            }
        }
        // Older versions could persist a deleted intake item while leaving its
        // provider review pending. Replaying this idempotent callback during a
        // full scan closes those stale, no-longer-actionable reviews.
        if (mode === 'full') {
            for (const previous of this.store.listItems().filter((item) => item.lastAction === 'deleted')) {
                await this.options.onDeleted?.({
                    provider: previous.provider || 'alldebrid', providerItemId: previous.providerItemId,
                    action: 'deleted', path: previous.path, tree: previous.tree || [], sourceCategory: previous.sourceCategory,
                    observedAt: new Date().toISOString(), stableDedupeKey: eventKey(previous.provider || 'alldebrid', previous.providerItemId, 'deleted', previous.fingerprint),
                });
            }
        }
        this.store.saveCursor(mode, new Date().toISOString());
        return events;
    }
    /** Reconciles Arr command state after a crash or an interrupted poll. */
    async pollPendingCommands() {
        for (const item of this.store.listItems()) {
            if (!item.commandId || item.terminalStatus === 'completed' || item.terminalStatus === 'failed')
                continue;
            try {
                const command = await this.arr.getCommand(this.options.routeFor(item.sourceCategory, item.provider), item.commandId);
                this.store.saveItem({ ...item, terminalStatus: command.status, updatedAt: new Date().toISOString() });
                if (command.status === 'failed') {
                    await this.options.onReview?.({
                        provider: item.provider || 'alldebrid', providerItemId: item.providerItemId, action: item.lastAction,
                        path: item.path, tree: item.tree || [], sourceCategory: item.sourceCategory,
                        observedAt: new Date().toISOString(),
                        stableDedupeKey: eventKey(item.provider || 'alldebrid', item.providerItemId, item.lastAction, item.fingerprint),
                    }, new Error(`Arr command ${item.commandId} failed`));
                }
            }
            catch {
                // A transient status failure is retried on the next reconciliation.
            }
        }
    }
    makeEvent(item, action, fp) {
        const provider = item.provider || 'alldebrid';
        const category = categoryFor(item);
        const categoryDirectory = category.toLowerCase();
        const providerPath = item.files[0].path.replace(/^\/+/, '');
        const path = item.directoryName
            ? `${categoryDirectory}/${item.directoryName.replace(/^\/+|\/+$/g, '')}/${providerPath}`
            : providerPath;
        return {
            provider, providerItemId: item.providerItemId, action,
            path, tree: item.files, sourceCategory: category,
            observedAt: item.observedAt, stableDedupeKey: eventKey(provider, item.providerItemId, action, fp),
        };
    }
    async dispatch(event, item, fp, forceRetry = false) {
        if (!forceRetry && this.store.hasEvent(event.stableDedupeKey))
            return;
        await this.options.onEvent?.(event);
        if (this.options.dryRun) {
            this.store.saveEvent(event);
            this.store.saveItem({ provider: event.provider, providerItemId: item.providerItemId, fingerprint: fp, path: event.path, tree: event.tree, sourceCategory: event.sourceCategory, lastAction: event.action, updatedAt: event.observedAt });
            return;
        }
        const route = this.options.routeFor(event.sourceCategory, event.provider);
        let lastError;
        for (let attempt = 1; attempt <= (this.options.maxAttempts || 3); attempt++) {
            try {
                const command = await this.arr.submitScan(route, event);
                this.store.saveEvent(event, command);
                this.store.saveItem({ provider: event.provider, providerItemId: item.providerItemId, fingerprint: fp, path: event.path, tree: event.tree, sourceCategory: event.sourceCategory, lastAction: event.action, commandId: command.commandId, terminalStatus: command.status, updatedAt: event.observedAt });
                await this.options.onSuccess?.(event);
                return;
            }
            catch (error) {
                if (error instanceof ProviderMountNotReadyError) {
                    console.warn("[provider-reconciliation] mount not ready; deferring ARR scan", error.message);
                    return;
                }
                lastError = error;
            }
        }
        const error = lastError instanceof Error ? lastError : new Error(String(lastError));
        await this.options.onReview?.(event, error);
        throw error;
    }
}
exports.ProviderReconciliationIntake = ProviderReconciliationIntake;
/**
 * Testable scheduler for the fork worker. It is intentionally not started by
 * the application entry point; provider reconciliation must explicitly opt in.
 */
class ProviderReconciliationWorker {
    constructor(intake, intervals) {
        this.intake = intake;
        this.intervals = intervals;
        this.runQueue = Promise.resolve();
    }
    intakes() { return Array.isArray(this.intake) ? this.intake : [this.intake]; }
    enqueue(mode, run) {
        const next = this.runQueue.then(async () => {
            const startedAt = Date.now();
            console.log(`[provider-reconciliation] ${mode} scan started`);
            try {
                const result = await run();
                console.log(`[provider-reconciliation] ${mode} scan completed in ${Date.now() - startedAt}ms`);
                return result;
            }
            catch (error) {
                console.error(`[provider-reconciliation] ${mode} scan failed`, error);
                throw error;
            }
        });
        this.runQueue = next.then(() => undefined, () => undefined);
        return next;
    }
    runRecent() {
        return this.enqueue('recent', async () => (await Promise.all(this.intakes().map((intake) => intake.reconcile('recent', this.intervals.recentLimit || 30)))).flat());
    }
    runFull() {
        return this.enqueue('full', async () => (await Promise.all(this.intakes().map((intake) => intake.reconcile('full')))).flat());
    }
    start() {
        if (this.recentTimer || this.fullTimer)
            return;
        void this.runRecent().catch(() => undefined);
        if (this.intervals.runFullOnStart !== false)
            void this.runFull().catch(() => undefined);
        this.recentTimer = setInterval(() => { void this.runRecent().catch(() => undefined); }, this.intervals.recentMs);
        this.fullTimer = setInterval(() => { void this.runFull().catch(() => undefined); }, this.intervals.fullMs);
    }
    stop() {
        if (this.recentTimer)
            clearInterval(this.recentTimer);
        if (this.fullTimer)
            clearInterval(this.fullTimer);
        this.recentTimer = undefined;
        this.fullTimer = undefined;
    }
    isRunning() {
        return !!this.recentTimer || !!this.fullTimer;
    }
}
exports.ProviderReconciliationWorker = ProviderReconciliationWorker;
