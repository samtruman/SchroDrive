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
exports.isMediaFile = isMediaFile;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const db_1 = require("../core/db");
const mediaClassifier_1 = require("../core/mediaClassifier");
const mediaParser_1 = require("./mediaParser");
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
        const scanPath = route.symlinkLibraryPath
            ? await exposeAsSymlink(route, event, providerPath)
            : providerPath;
        let commandBody = { name: commandName, path: scanPath, importMode: route.importMode || 'Copy' };
        if (route.symlinkLibraryPath) {
            const entityId = await findArrEntityId(route, event);
            commandName = route.kind === 'radarr' ? 'RescanMovie' : 'RescanSeries';
            commandBody = { name: commandName, [route.kind === 'radarr' ? 'movieId' : 'seriesId']: entityId };
        }
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
function normalizedTitle(value) {
    return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
async function findArrEntityId(route, event) {
    const filename = node_path_1.default.basename(event.path);
    const parsed = (0, mediaParser_1.parseMediaFilename)(filename, event.path);
    const title = normalizedTitle(parsed.title || event.path.split('/').filter(Boolean).slice(-2, -1)[0] || '');
    const endpoint = route.kind === 'radarr' ? 'movie' : 'series';
    const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/${endpoint}`, {
        headers: { 'X-Api-Key': route.apiKey },
    });
    if (!response.ok)
        throw new Error(`Arr ${endpoint} lookup failed: HTTP ${response.status}`);
    const records = await response.json();
    const match = records.find((record) => record.id && normalizedTitle(record.title || '') === title);
    if (!match?.id)
        throw new Error(`Arr ${endpoint} record not found for ${parsed.title || filename}`);
    return match.id;
}
function safeSegment(value) {
    return value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Unknown';
}
/**
 * Creates the Arr-facing library entry without copying provider data. The
 * target is deliberately a symlink into the shared SchröDrive mount.
 */
async function exposeAsSymlink(route, event, providerPath) {
    const library = route.symlinkLibraryPath;
    const filename = node_path_1.default.basename(event.path);
    const parsed = (0, mediaParser_1.parseMediaFilename)(filename, event.path);
    const pathParts = event.path.split('/').filter(Boolean);
    const title = safeSegment(parsed.title || pathParts[pathParts.length - 2] || node_path_1.default.parse(filename).name);
    const directory = event.sourceCategory === 'Shows'
        ? node_path_1.default.join(library, title, `Season ${parsed.season ?? 1}`)
        : node_path_1.default.join(library, parsed.year ? `${title} (${parsed.year})` : title);
    const destination = node_path_1.default.join(directory, filename);
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
    async listRecentSnapshot(limit) {
        const observedAt = new Date().toISOString();
        const torrents = (await this.provider.listTorrents())
            .sort((a, b) => (b.addedAt?.getTime() || 0) - (a.addedAt?.getTime() || 0))
            .slice(0, Math.max(0, limit));
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
        const current = mode === 'recent' && this.source.listRecentSnapshot
            ? await this.source.listRecentSnapshot(recentLimit)
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
            if (!action)
                continue;
            const event = this.makeEvent(item, action, nextFingerprint);
            await this.dispatch(event, item, nextFingerprint);
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
                events.push(event);
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
    async dispatch(event, item, fp) {
        if (this.store.hasEvent(event.stableDedupeKey))
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
                return;
            }
            catch (error) {
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
    }
    intakes() { return Array.isArray(this.intake) ? this.intake : [this.intake]; }
    async runRecent() { return (await Promise.all(this.intakes().map((intake) => intake.reconcile('recent', this.intervals.recentLimit || 30)))).flat(); }
    async runFull() { return (await Promise.all(this.intakes().map((intake) => intake.reconcile('full')))).flat(); }
    start() {
        if (this.recentTimer || this.fullTimer)
            return;
        this.runRecent().catch(() => undefined);
        if (this.intervals.runFullOnStart !== false)
            this.runFull().catch(() => undefined);
        this.recentTimer = setInterval(() => { this.runRecent().catch(() => undefined); }, this.intervals.recentMs);
        this.fullTimer = setInterval(() => { this.runFull().catch(() => undefined); }, this.intervals.fullMs);
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
