/**
 * Provider-agnostic direct-file reconciliation for mounted debrid providers.
 *
 * Providers do not need a push change feed for this path: the adapter
 * reconciles read-only torrent status plus completed file trees, emits stable
 * direct-file events, and hands added/changed files to Arr. It is deliberately
 * opt-in and separate from provider delete/repair lifecycle services.
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { getDb } from '../core/db';
import { config } from '../core/config';
import type { DebridProvider, TorrentInfo, VirtualDirectory } from '../providers';
import { classifyTorrent } from '../core/mediaClassifier';
import { parseMediaFilename } from './mediaParser';
import { searchTmdb } from './tmdbService';
import { arrTitleAliases, normalizeArrTitle } from './arrTitleIdentity';
import { getManualIdentityOverrideForProviderSource } from './manualIdentity';

export type DirectFileAction = 'added' | 'changed' | 'deleted';
export type SourceCategory = 'Movies' | 'Shows';
export type ArrKind = 'radarr' | 'sonarr';

export interface ProviderSnapshot {
  provider?: string;
  providerItemId: string;
  name: string;
  directoryName?: string;
  status: string;
  progress?: number;
  files: Array<{ path: string; size: number }>;
  observedAt: string;
}

export interface DirectFileEvent {
  provider: string;
  providerItemId: string;
  action: DirectFileAction;
  path: string;
  tree: Array<{ path: string; size: number }>;
  sourceCategory: SourceCategory;
  observedAt: string;
  stableDedupeKey: string;
}

export interface ArrRoute {
  kind: ArrKind;
  baseUrl: string;
  apiKey: string;
  /** Absolute path visible inside the target Arr container. */
  sourcePathPrefix?: string;
  /** Import mode used by Arr for provider-backed paths. */
  importMode?: 'Move' | 'Copy';
  /** Optional Arr-visible library root. When set, media is exposed by symlink. */
  symlinkLibraryPath?: string;
  /** Optional Arr-visible download staging root. When set, ARR performs the import. */
  stagingPath?: string;
  /** Maximum time to wait for newly-mounted provider files before notifying ARR. */
  mountReadyTimeoutMs?: number;
  /** Poll interval while waiting for the provider mount. */
  mountReadyPollMs?: number;
  /** Optional local endpoint used to invalidate the WebDAV mount cache. */
  mountRefreshUrl?: string;
}

export interface ArrCommandResult {
  commandId: string;
  status: string;
  result?: string;
}

export interface ArrClient {
  submitScan(route: ArrRoute, event: DirectFileEvent): Promise<ArrCommandResult>;
  getCommand(route: ArrRoute, commandId: string): Promise<ArrCommandResult>;
}

class ProviderMountNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderMountNotReadyError";
  }
}

export interface ArrDeletePropagationResult {
  removedSymlinks: number;
  arrEntityId?: number;
  arrCommandId?: string;
  warning?: string;
}

export interface IntakeStateStore {
  getItem(providerItemId: string): IntakeState | undefined;
  listItems(): IntakeState[];
  saveItem(state: IntakeState): void;
  hasEvent(key: string): boolean;
  saveEvent(event: DirectFileEvent, arr?: ArrCommandResult): void;
  getCursor(): { recentAt?: string; fullAt?: string };
  saveCursor(mode: 'recent' | 'full', observedAt: string): void;
}

export interface IntakeState {
  provider?: string;
  providerItemId: string;
  fingerprint: string;
  path: string;
  tree: Array<{ path: string; size: number }>;
  sourceCategory: SourceCategory;
  lastAction: DirectFileAction;
  commandId?: string;
  terminalStatus?: string;
  updatedAt: string;
}

export class InMemoryIntakeStateStore implements IntakeStateStore {
  private readonly items = new Map<string, IntakeState>();
  private readonly events = new Map<string, DirectFileEvent>();
  private cursor: { recentAt?: string; fullAt?: string } = {};

  getItem(id: string): IntakeState | undefined { return this.items.get(id); }
  listItems(): IntakeState[] { return [...this.items.values()]; }
  saveItem(state: IntakeState): void { this.items.set(state.providerItemId, state); }
  hasEvent(key: string): boolean { return this.events.has(key); }
  saveEvent(event: DirectFileEvent): void { this.events.set(event.stableDedupeKey, event); }
  getCursor(): { recentAt?: string; fullAt?: string } { return { ...this.cursor }; }
  saveCursor(mode: 'recent' | 'full', observedAt: string): void { this.cursor[mode === 'recent' ? 'recentAt' : 'fullAt'] = observedAt; }
}

/** Persistent reconciliation state in the configured SchröDrive DB. */
export class SqliteIntakeStateStore implements IntakeStateStore {
  constructor() {
    getDb().exec(`CREATE TABLE IF NOT EXISTS provider_reconciliation_intake (
      provider_item_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    getDb().exec(`CREATE TABLE IF NOT EXISTS provider_reconciliation_events (
      dedupe_key TEXT PRIMARY KEY,
      event_json TEXT NOT NULL,
      arr_json TEXT,
      created_at INTEGER NOT NULL
    )`);
    getDb().exec(`CREATE TABLE IF NOT EXISTS provider_reconciliation_cursor (
      name TEXT PRIMARY KEY,
      observed_at TEXT NOT NULL
    )`);
  }
  getItem(id: string): IntakeState | undefined {
    const row = getDb().prepare('SELECT state_json FROM provider_reconciliation_intake WHERE provider_item_id = ?').get(id) as { state_json?: string } | undefined;
    return row?.state_json ? JSON.parse(row.state_json) as IntakeState : undefined;
  }
  listItems(): IntakeState[] {
    return (getDb().prepare('SELECT state_json FROM provider_reconciliation_intake').all() as Array<{ state_json: string }>)
      .flatMap((row) => { try { return [JSON.parse(row.state_json) as IntakeState]; } catch { return []; } });
  }
  saveItem(state: IntakeState): void {
    getDb().prepare(`INSERT INTO provider_reconciliation_intake(provider_item_id,state_json,updated_at)
      VALUES (?,?,?) ON CONFLICT(provider_item_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at`)
      .run(state.providerItemId, JSON.stringify(state), Date.parse(state.updatedAt));
  }
  hasEvent(key: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM provider_reconciliation_events WHERE dedupe_key = ?').get(key);
  }
  saveEvent(event: DirectFileEvent, arr?: ArrCommandResult): void {
    getDb().prepare(`INSERT OR IGNORE INTO provider_reconciliation_events(dedupe_key,event_json,arr_json,created_at)
      VALUES (?,?,?,?)`).run(event.stableDedupeKey, JSON.stringify(event), arr ? JSON.stringify(arr) : null, Date.parse(event.observedAt));
  }
  getCursor(): { recentAt?: string; fullAt?: string } {
    const rows = getDb().prepare('SELECT name, observed_at FROM provider_reconciliation_cursor').all() as Array<{ name: string; observed_at: string }>;
    return Object.fromEntries(rows.map((row) => [row.name === 'recent' ? 'recentAt' : 'fullAt', row.observed_at]));
  }
  saveCursor(mode: 'recent' | 'full', observedAt: string): void {
    getDb().prepare(`INSERT INTO provider_reconciliation_cursor(name,observed_at) VALUES (?,?)
      ON CONFLICT(name) DO UPDATE SET observed_at=excluded.observed_at`).run(mode, observedAt);
  }
}

export class HttpArrClient implements ArrClient {
  async submitScan(route: ArrRoute, event: DirectFileEvent): Promise<ArrCommandResult> {
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
      ? await exposeAsSymlink(route, event, providerPath, arrPath!)
      : providerPath;
    let commandBody: Record<string, unknown> = { name: commandName, path: scanPath, importMode: route.importMode || 'Copy' };
    if (route.symlinkLibraryPath) {
      if (arrEntity?.id !== undefined) {
        commandName = route.kind === 'radarr' ? 'RescanMovie' : 'RescanSeries';
        commandBody = { name: commandName, [route.kind === 'radarr' ? 'movieId' : 'seriesId']: arrEntity.id };
      }
    }
    return this.submitCommand(route, commandBody);
  }

  private async submitCommand(route: ArrRoute, commandBody: Record<string, unknown>): Promise<ArrCommandResult> {
    const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/command`, {
      method: 'POST',
      headers: { 'X-Api-Key': route.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(commandBody),
    });
    if (!response.ok) throw new Error(`Arr command submission failed: HTTP ${response.status}`);
    const body = await response.json() as { id?: number; status?: string; result?: string };
    if (!body.id) throw new Error('Arr command response did not include an id');
    return { commandId: String(body.id), status: body.status || 'queued', result: body.result };
  }

  async getCommand(route: ArrRoute, commandId: string): Promise<ArrCommandResult> {
    const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/command/${encodeURIComponent(commandId)}`, {
      headers: { 'X-Api-Key': route.apiKey },
    });
    if (!response.ok) throw new Error(`Arr command status failed: HTTP ${response.status}`);
    const body = await response.json() as { id?: number; status?: string; result?: string };
    return { commandId, status: body.status || 'unknown', result: body.result };
  }
}

type ArrEntity = { id?: number; title?: string; originalTitle?: string; alternateTitles?: Array<string | { title?: string }>; tmdbId?: number | string; year?: number; path?: string };

async function fetchArrEntities(route: ArrRoute, endpoint: string): Promise<ArrEntity[]> {
  const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/${endpoint}`, {
    headers: { 'X-Api-Key': route.apiKey },
  });
  if (!response.ok) throw new Error(`Arr ${endpoint} lookup failed: HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body) ? body as ArrEntity[] : [];
}

async function parseArrEntity(route: ArrRoute, filename: string): Promise<ArrEntity | undefined> {
  const endpoint = route.kind === 'radarr' ? 'movie' : 'series';
  const response = await fetch(
    route.baseUrl.replace(/\/$/, '') + '/api/v3/parse?title=' + encodeURIComponent(filename),
    { headers: { 'X-Api-Key': route.apiKey } },
  );
  if (!response.ok) return undefined;
  const body = await response.json() as Record<string, unknown>;
  const entity = body[endpoint];
  return entity && typeof entity === 'object' ? entity as ArrEntity : undefined;
}

async function findArrEntity(route: ArrRoute, event: DirectFileEvent): Promise<ArrEntity | undefined> {
  const filename = path.basename(event.path);
  const parsed = parseMediaFilename(filename, event.path);
  const manual = getManualIdentityOverrideForProviderSource(event.provider, event.path, {
    kind: route.kind === 'radarr' ? 'movie' : 'episode',
    title: parsed.title,
    year: parsed.year,
    season: parsed.season,
    episode: parsed.episode,
  });
  const title = normalizeArrTitle(parsed.title || event.path.split('/').filter(Boolean).slice(-2, -1)[0] || '');
  const endpoint = route.kind === 'radarr' ? 'movie' : 'series';
  const kind = route.kind === 'radarr' ? 'movie' : 'tv';
  const records = await fetchArrEntities(route, endpoint);
  if (manual?.tmdbId) {
    const manualMatch = records.find((record) => record.id && String(record.tmdbId || '') === String(manual.tmdbId));
    if (manualMatch) return manualMatch;
  }
  const titleMatches = records.filter((record) => {
    if (!record.id || !arrTitleAliases(record).includes(title)) return false;
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
    if (!parsed.year || !record.year) return true;
    return Math.abs(Number(record.year) - parsed.year) <= 1;
  });
  if (nearYearMatches.length === 1) return nearYearMatches[0];

  // Use Arr's own metadata lookup for canonical TMDb identity, then map it
  // back to an already configured record. No second TMDb credential is needed.
  const lookup = await fetchArrEntities(route, `${endpoint}/lookup?term=${encodeURIComponent(parsed.title || filename)}`);
  const yearMatches = lookup.filter((candidate) => {
    if (!parsed.year || !candidate.year) return true;
    return Math.abs(Number(candidate.year) - parsed.year) <= 1;
  });
  const tmdbIds = new Set(yearMatches.map((candidate) => String(candidate.tmdbId || '')).filter(Boolean));
  const tmdbMatches = records.filter((record) => record.id && tmdbIds.has(String(record.tmdbId || '')));
  if (tmdbMatches.length === 1) return tmdbMatches[0];

  // ARR is authoritative. TMDB is only a fallback when ARR title aliases do
  // not produce one unambiguous result.
  const canonical = parsed.title ? await resolveCanonicalMetadata(parsed.title, kind, parsed.year) : undefined;
  const matchByTmdb = canonical?.tmdbId
    ? records.find((record) => record.id && String(record.tmdbId || '') === canonical.tmdbId)
    : undefined;
  return matchByTmdb;
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Unknown';
}

function safeRelativeMediaPath(value: string): string {
  const segments = value.split(/[\\/]+/).filter(Boolean).filter((segment) => segment !== '.' && segment !== '..');
  return segments.map(safeSegment).join(path.sep) || 'media-file';
}

const canonicalMetadataCache = new Map<string, { tmdbId: string; title: string; year?: number } | null>();

async function resolveCanonicalMetadata(title: string, kind: 'movie' | 'tv', year?: number): Promise<{ tmdbId: string; title: string; year?: number } | undefined> {
  const key = `${kind}:${title.toLocaleLowerCase()}:${year || ''}`;
  if (canonicalMetadataCache.has(key)) return canonicalMetadataCache.get(key) || undefined;
  const result = await searchTmdb(title, kind, year, { retries: 1, timeoutMs: 5000 });
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
async function exposeAsSymlink(route: ArrRoute, event: DirectFileEvent, providerPath: string, arrPath: string): Promise<string> {
  const libraryRoot = path.resolve(route.symlinkLibraryPath!);
  const authoritativeRoot = path.resolve(arrPath);
  if (authoritativeRoot !== libraryRoot && !authoritativeRoot.startsWith(`${libraryRoot}${path.sep}`)) {
    throw new Error(`Refusing Arr path outside configured symlink library: ${arrPath}`);
  }
  const filename = path.basename(event.path);
  const parsed = parseMediaFilename(filename, event.path);
  const destination = event.sourceCategory === 'Shows' && parsed.season
    ? path.join(arrPath, `Season ${String(parsed.season).padStart(2, '0')}`, filename)
    : path.join(arrPath, filename);
  const directory = path.dirname(destination);
  await fsp.mkdir(directory, { recursive: true });
  const existing = await fsp.lstat(destination).catch(() => undefined);
  if (existing?.isSymbolicLink()) {
    const current = await fsp.readlink(destination);
    if (current === providerPath) return destination;
    // Multiple providers may expose the same title. Keep the first healthy
    // provider-backed link instead of oscillating the library on every poll.
    return destination;
  } else if (existing) {
    throw new Error(`Refusing to overwrite non-symlink Arr library entry: ${destination}`);
  }
  // Use the container-visible absolute mount path. A relative link would be
  // resolved against the host bind source, which differs between SchröDrive
  // and Arr containers.
  await fsp.symlink(providerPath, destination);
  return destination;
}

/**
 * Uses the same staging contract as the qBittorrent-compatible bridge.
 * ARR receives the staging directory and is responsible for parsing the
 * release, creating its canonical folder, and importing the media.
 */
async function exposeAsArrStaging(route: ArrRoute, event: DirectFileEvent): Promise<string> {
  const stagingRoot = path.resolve(route.stagingPath!);
  const stagingDirectory = path.join(stagingRoot, safeSegment(`${event.provider}-${event.providerItemId}`));
  const firstTreePath = String(event.tree[0]?.path || path.basename(event.path)).replace(/^[/\\]+/, '');
  const eventPath = event.path.replace(/^[/\\]+/, '');
  const prefix = eventPath.endsWith(firstTreePath)
    ? eventPath.slice(0, -firstTreePath.length)
    : `${path.dirname(eventPath).replace(/\\/g, '/')}/`;
  const files = event.tree.length > 0 ? event.tree : [{ path: path.basename(event.path), size: 0 }];

  await fsp.mkdir(stagingDirectory, { recursive: true });
  for (const file of files) {
    const relativeFile = String(file.path).replace(/^[/\\]+/, '');
    const providerRelativePath = `${prefix}${relativeFile}`.replace(/\\/g, '/');
    const providerPath = route.sourcePathPrefix
      ? `${route.sourcePathPrefix.replace(/\/$/, '')}/${providerRelativePath}`
      : providerRelativePath;
    const destination = path.join(stagingDirectory, safeRelativeMediaPath(relativeFile));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const existing = await fsp.lstat(destination).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
      const current = await fsp.readlink(destination);
      if (current === providerPath) continue;
      await fsp.unlink(destination);
    } else if (existing) {
      throw new Error(`Refusing to overwrite non-symlink ARR staging entry: ${destination}`);
    }
    await fsp.symlink(providerPath, destination);
  }
  return stagingDirectory;
}

async function refreshProviderMount(route: ArrRoute, event?: DirectFileEvent): Promise<void> {
  if (route.mountRefreshUrl) {
    try {
      const response = await fetch(route.mountRefreshUrl, { method: "POST" });
      if (!response.ok) console.warn("[provider-reconciliation] provider mount refresh returned HTTP " + response.status);
    } catch (error) {
      console.warn("[provider-reconciliation] provider mount refresh unavailable; continuing with rclone/readiness refresh", error);
    }
  }
  if (!event || config.mountRcloneRcPort <= 0 || !route.sourcePathPrefix) return;
  const providerName = path.basename(route.sourcePathPrefix);
  const providerIndex = Math.max(0, config.providers.indexOf(providerName));
  const rcUrl = `http://127.0.0.1:${config.mountRcloneRcPort + providerIndex}/vfs/refresh`;
  const parts = event.path.replace(/^\/+|\/+$/g, "").split("/");
  const directory = parts.length >= 2 ? `/${parts.slice(0, 2).join("/")}` : `/${parts[0] || ""}`;
  try {
    const response = await fetch(rcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // rclone RC decodes JSON option values as strings. A boolean makes
      // vfs/refresh reject the request with HTTP 500 and leaves the mount
      // cache stale, so the completed item never reaches ARR.
      body: JSON.stringify({ fs: `${providerName}:`, dir: directory, recursive: "false" }),
    });
    if (!response.ok) console.warn("[provider-reconciliation] rclone VFS refresh returned HTTP " + response.status);
  } catch (error) {
    console.warn("[provider-reconciliation] rclone VFS refresh unavailable; continuing with readiness polling", error);
  }
}

async function waitForProviderMount(route: ArrRoute, event: DirectFileEvent): Promise<void> {
  if (!route.sourcePathPrefix) return;
  const timeoutMs = Math.max(0, route.mountReadyTimeoutMs ?? 0);
  if (timeoutMs === 0) return;
  const pollMs = Math.max(50, route.mountReadyPollMs ?? 500);
  const paths = providerTreePaths(route, event);
  if (paths.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  let missing = paths;
  do {
    missing = [];
    for (const candidate of paths) {
      try {
        const stat = await fsp.stat(candidate);
        if (!stat.isFile()) missing.push(candidate);
      } catch {
        missing.push(candidate);
      }
    }
    if (missing.length === 0) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new ProviderMountNotReadyError("Provider mount not ready for " + event.provider + ":" + event.providerItemId + "; missing " + missing.length + " file(s) after " + timeoutMs + "ms");
}

function providerTreePaths(route: ArrRoute, event: DirectFileEvent): string[] {
  if (!route.sourcePathPrefix) return [];
  const firstTreePath = String(event.tree[0]?.path || path.basename(event.path)).replace(/^[/\\]+/, "");
  const eventPath = event.path.replace(/^[/\\]+/, "");
  const prefix = eventPath.endsWith(firstTreePath)
    ? eventPath.slice(0, -firstTreePath.length)
    : path.dirname(eventPath).replace(/\\/g, "/") + "/";
  const files = event.tree.length > 0 ? event.tree : [{ path: path.basename(event.path), size: 0 }];
  const sourceRoot = route.sourcePathPrefix.replace(/\/$/, "");
  return files.map((file) => {
    const relativeFile = String(file.path).replace(/^[/\\]+/, "");
    return sourceRoot + "/" + (prefix + relativeFile).replace(/\\/g, "/");
  });
}

async function removeMatchingSymlinks(root: string, targets: Set<string>): Promise<number> {
  let removed = 0;
  async function visit(current: string): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const link = await fsp.readlink(candidate).catch(() => undefined);
        if (link && targets.has(path.normalize(link))) {
          await fsp.unlink(candidate);
          removed += 1;
        }
      } else if (entry.isDirectory()) {
        await visit(candidate);
      }
    }
  }
  await visit(root);
  return removed;
}

export async function propagateDeletedFile(route: ArrRoute, event: DirectFileEvent, options: { refreshArr?: boolean } = {}): Promise<ArrDeletePropagationResult> {
  const providerPath = route.sourcePathPrefix
    ? `${route.sourcePathPrefix.replace(/\/$/, '')}/${event.path.replace(/^\/+/, '')}`
    : event.path;
  const targets = new Set([path.normalize(providerPath)]);
  const roots = [route.symlinkLibraryPath, route.stagingPath].filter((value): value is string => Boolean(value));
  const removedSymlinks = (await Promise.all(roots.map((root) => removeMatchingSymlinks(root, targets))))
    .reduce((sum, count) => sum + count, 0);
  if (options.refreshArr === false) return { removedSymlinks };
  if (!route.baseUrl || !route.apiKey) return { removedSymlinks, warning: 'ARR route is not configured' };
  const arrEntity = await findArrEntity(route, event);
  if (!arrEntity?.id) return { removedSymlinks, warning: `No unambiguous ${route.kind} entity matched deleted path` };
  const commandName = route.kind === 'radarr' ? 'RescanMovie' : 'RescanSeries';
  const commandBody = { name: commandName, [route.kind === 'radarr' ? 'movieId' : 'seriesId']: arrEntity.id };
  const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/api/v3/command`, {
    method: 'POST',
    headers: { 'X-Api-Key': route.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(commandBody),
  });
  if (!response.ok) throw new Error(`Arr delete reconciliation failed: HTTP ${response.status}`);
  const body = await response.json() as { id?: number };
  if (!body.id) throw new Error('Arr delete reconciliation response did not include an id');
  return { removedSymlinks, arrEntityId: arrEntity.id, arrCommandId: String(body.id) };
}

export interface ProviderReadOnlySource {
  listSnapshot(): Promise<ProviderSnapshot[]>;
  listRecentSnapshot?(limit: number, knownProviderItemIds?: readonly string[]): Promise<ProviderSnapshot[]>;
}

/** Adapts SchröDrive's common provider contract to reconciliation snapshots. */
export class ProviderSnapshotSource implements ProviderReadOnlySource {
  constructor(private readonly provider: Pick<DebridProvider, 'id' | 'listTorrents' | 'fetchDirectories'> & { fetchDirectoriesForIds?: (torrents: TorrentInfo[]) => Promise<VirtualDirectory[]> }, private readonly namespaceIds = true) {}

  async listSnapshot(): Promise<ProviderSnapshot[]> {
    const observedAt = new Date().toISOString();
    const torrents = await this.provider.listTorrents();
    const directories = await this.provider.fetchDirectories();
    const trees = new Map(directories.map((directory) => [String(directory.id), directory]));
    return this.toSnapshots(torrents, trees, observedAt);
  }

  async listRecentSnapshot(limit: number, knownProviderItemIds: readonly string[] = []): Promise<ProviderSnapshot[]> {
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
      if (knownIds.has(String(torrent.id))) selected.set(String(torrent.id), torrent);
    }
    const torrents = [...selected.values()];
    const directories = this.provider.fetchDirectoriesForIds
      ? await this.provider.fetchDirectoriesForIds(torrents)
      : await this.provider.fetchDirectories();
    return this.toSnapshots(torrents, new Map(directories.map((directory) => [String(directory.id), directory])), observedAt);
  }

  private toSnapshots(torrents: TorrentInfo[], trees: Map<string, VirtualDirectory>, observedAt: string): ProviderSnapshot[] {
    return torrents.map((torrent) => {
      const directory = trees.get(String(torrent.id));
      return { provider: this.provider.id, providerItemId: this.namespaceIds ? `${this.provider.id}:${torrent.id}` : String(torrent.id), name: torrent.name, directoryName: directory?.name || directory?.originalName, status: torrent.status, progress: torrent.progress,
        files: ((directory?.files?.length ? directory.files : torrent.files) || []).map((file) => ({ path: 'path' in file ? file.path : file.name, size: file.size })), observedAt };
    });
  }
}

export interface IntakeOptions {
  dryRun?: boolean;
  maxAttempts?: number;
  routeFor: (category: SourceCategory, provider?: string) => ArrRoute;
  onEvent?: (event: DirectFileEvent) => Promise<void> | void;
  onSuccess?: (event: DirectFileEvent) => Promise<void> | void;
  onDeleted?: (event: DirectFileEvent) => Promise<void> | void;
  shouldRetry?: (event: DirectFileEvent) => boolean;
  onReview?: (event: DirectFileEvent, error: Error) => Promise<void> | void;
}

const VIDEO_EXTENSIONS = new Set(['3g2', '3gp', 'avi', 'flv', 'mkv', 'mk3d', 'm4v', 'mov', 'mp2', 'mp4', 'mpe', 'mpeg', 'mpg', 'mpv', 'ts', 'm2ts', 'webm', 'wmv', 'ogm']);
// Keep subtitles and sidecar subtitle attachments with the video tree.
const SUBTITLE_EXTENSIONS = new Set(['ass', 'idx', 'mpsub', 'sbv', 'smi', 'srt', 'ssa', 'sub', 'sup', 'vtt']);

export function isMediaFile(filePath: string): boolean {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  return VIDEO_EXTENSIONS.has(extension) || SUBTITLE_EXTENSIONS.has(extension);
}

function categoryFor(snapshot: ProviderSnapshot): SourceCategory {
  return classifyTorrent(snapshot.name, snapshot.files.map((file) => file.path)) === 'shows' ? 'Shows' : 'Movies';
}

function isFinished(snapshot: ProviderSnapshot): boolean {
  const status = snapshot.status.toLowerCase();
  return snapshot.progress === undefined
    ? ['finished', 'downloaded', 'completed', 'seeding', 'ready', 'cached'].includes(status)
    : snapshot.progress >= 100 || ['finished', 'downloaded', 'completed', 'seeding', 'ready', 'cached'].includes(status);
}

function fingerprint(snapshot: Pick<ProviderSnapshot, 'providerItemId' | 'files' | 'status'>): string {
  return createHash('sha256').update(JSON.stringify({ id: snapshot.providerItemId, status: snapshot.status, files: snapshot.files })).digest('hex');
}

function eventKey(provider: string, id: string, action: DirectFileAction, fp: string): string {
  return `${provider}:${id}:${action}:${fp}`;
}

export class ProviderReconciliationIntake {
  constructor(
    private readonly source: ProviderReadOnlySource,
    private readonly arr: ArrClient,
    private readonly store: IntakeStateStore,
    private readonly options: IntakeOptions,
  ) {}

  async reconcile(mode: 'recent' | 'full' = 'full', recentLimit = 30): Promise<DirectFileEvent[]> {
    await this.pollPendingCommands();
    const knownProviderItemIds = mode === 'recent'
      ? this.store.listItems().filter((item) => item.lastAction !== 'deleted').map((item) => item.providerItemId)
      : [];
    const current = mode === 'recent' && this.source.listRecentSnapshot
      ? await this.source.listRecentSnapshot(recentLimit, knownProviderItemIds)
      : await this.source.listSnapshot();
    const seen = new Set(current.map((item) => item.providerItemId));
    const events: DirectFileEvent[] = [];

    for (const item of current) {
      if (!isFinished(item) || item.files.length === 0) continue;
      item.files = item.files.filter((file) => isMediaFile(file.path));
      if (item.files.length === 0) continue;
      const prior = this.store.getItem(item.providerItemId);
      const nextFingerprint = fingerprint(item);
      const action: DirectFileAction | undefined = !prior || prior.lastAction === 'deleted'
        ? 'added' : prior.fingerprint === nextFingerprint ? undefined : 'changed';
      const retryEvent = !action && prior
        ? this.makeEvent(item, prior.lastAction === 'deleted' ? 'added' : prior.lastAction, nextFingerprint)
        : undefined;
      const retryPendingReview = Boolean(retryEvent && this.options.shouldRetry?.(retryEvent));
      if (!action && !retryPendingReview) continue;
      const event = action ? this.makeEvent(item, action, nextFingerprint) : retryEvent!;
      await this.dispatch(event, item, nextFingerprint, retryPendingReview);
      events.push(event);
    }

    // A missing status-list item is a removal, but an item still processing is not.
    for (const previous of mode === 'full' ? this.store.listItems().filter((item) => item.lastAction !== 'deleted') : []) {
      if (seen.has(previous.providerItemId)) continue;
      const event: DirectFileEvent = {
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
  private async pollPendingCommands(): Promise<void> {
    for (const item of this.store.listItems()) {
      if (!item.commandId || item.terminalStatus === 'completed' || item.terminalStatus === 'failed') continue;
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
      } catch {
        // A transient status failure is retried on the next reconciliation.
      }
    }
  }

  private makeEvent(item: ProviderSnapshot, action: DirectFileAction, fp: string): DirectFileEvent {
    const provider = item.provider || 'alldebrid';
    const category = categoryFor(item);
    const categoryDirectory = category.toLowerCase();
    const providerPath = item.files[0].path.replace(/^\/+/, '');
    const directoryName = item.directoryName?.replace(/^\/+|\/+$/g, '');
    // Some providers expose a single-file torrent as a virtual directory
    // whose name is exactly the file name. Do not duplicate that component:
    // `shows/file.mkv/file.mkv` prevents mount readiness and ARR discovery.
    const syntheticSingleFileDirectory = item.files.length === 1 &&
      !!directoryName &&
      (directoryName === providerPath || directoryName === path.basename(providerPath));
    const eventPath = item.directoryName
      && !syntheticSingleFileDirectory
      ? `${categoryDirectory}/${directoryName}/${providerPath}`
      : providerPath;
    return {
      provider, providerItemId: item.providerItemId, action,
      path: eventPath, tree: item.files, sourceCategory: category,
      observedAt: item.observedAt, stableDedupeKey: eventKey(provider, item.providerItemId, action, fp),
    };
  }

  private async dispatch(event: DirectFileEvent, item: ProviderSnapshot, fp: string, forceRetry = false): Promise<void> {
    if (!forceRetry && this.store.hasEvent(event.stableDedupeKey)) return;
    await this.options.onEvent?.(event);
    if (this.options.dryRun) {
      this.store.saveEvent(event);
      this.store.saveItem({ provider: event.provider, providerItemId: item.providerItemId, fingerprint: fp, path: event.path, tree: event.tree, sourceCategory: event.sourceCategory, lastAction: event.action, updatedAt: event.observedAt });
      return;
    }
    const route = this.options.routeFor(event.sourceCategory, event.provider);
    let lastError: unknown;
    for (let attempt = 1; attempt <= (this.options.maxAttempts || 3); attempt++) {
      try {
        const command = await this.arr.submitScan(route, event);
        this.store.saveEvent(event, command);
        this.store.saveItem({ provider: event.provider, providerItemId: item.providerItemId, fingerprint: fp, path: event.path, tree: event.tree, sourceCategory: event.sourceCategory, lastAction: event.action, commandId: command.commandId, terminalStatus: command.status, updatedAt: event.observedAt });
        await this.options.onSuccess?.(event);
        return;
      } catch (error) {
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

/**
 * Testable scheduler for the fork worker. It is intentionally not started by
 * the application entry point; provider reconciliation must explicitly opt in.
 */
export class ProviderReconciliationWorker {
  private recentTimer: ReturnType<typeof setInterval> | undefined;
  private fullTimer: ReturnType<typeof setInterval> | undefined;
  private runQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly intake: ProviderReconciliationIntake | ProviderReconciliationIntake[],
    private readonly intervals: { recentMs: number; fullMs: number; recentLimit?: number; runFullOnStart?: boolean },
  ) {}

  private intakes(): ProviderReconciliationIntake[] { return Array.isArray(this.intake) ? this.intake : [this.intake]; }
  private enqueue<T>(mode: 'recent' | 'full', run: () => Promise<T>): Promise<T> {
    const next = this.runQueue.then(async () => {
      const startedAt = Date.now();
      console.log(`[provider-reconciliation] ${mode} scan started`);
      try {
        const result = await run();
        console.log(`[provider-reconciliation] ${mode} scan completed in ${Date.now() - startedAt}ms`);
        return result;
      } catch (error) {
        console.error(`[provider-reconciliation] ${mode} scan failed`, error);
        throw error;
      }
    });
    this.runQueue = next.then(() => undefined, () => undefined);
    return next;
  }
  runRecent(): Promise<DirectFileEvent[]> {
    return this.enqueue('recent', async () => (await Promise.all(this.intakes().map((intake) => intake.reconcile('recent', this.intervals.recentLimit || 30)))).flat());
  }
  runFull(): Promise<DirectFileEvent[]> {
    return this.enqueue('full', async () => (await Promise.all(this.intakes().map((intake) => intake.reconcile('full')))).flat());
  }

  start(): void {
    if (this.recentTimer || this.fullTimer) return;
    void this.runRecent().catch(() => undefined);
    if (this.intervals.runFullOnStart !== false) void this.runFull().catch(() => undefined);
    this.recentTimer = setInterval(() => { void this.runRecent().catch(() => undefined); }, this.intervals.recentMs);
    this.fullTimer = setInterval(() => { void this.runFull().catch(() => undefined); }, this.intervals.fullMs);
  }

  stop(): void {
    if (this.recentTimer) clearInterval(this.recentTimer);
    if (this.fullTimer) clearInterval(this.fullTimer);
    this.recentTimer = undefined;
    this.fullTimer = undefined;
  }

  isRunning(): boolean {
    return !!this.recentTimer || !!this.fullTimer;
  }
}
