import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { registry, type TorrentInfo } from "../src/providers";
import { fingerprintTorrent, isMediaFileName, type VersionRecord } from "../src/services/versionManager";
import { getCachedVersionManagerMetadata, saveVersionManagerMetadataCache } from "../src/services/versionManagerMetadata";
import { enrichVersionMetadata } from "../src/services/versionManagerMetadata";
import { mediaServerProviders } from "../src/services/mediaServerProvider";
import { evaluateVersionGroups, defaultVersionProfiles } from "../src/services/versionManager";
import { deriveAcquisitionNeeds } from "../src/services/acquisition";
import { exportMigrationLibrary } from "../src/services/migrationExporter";
import { searchTmdb } from "../src/services/tmdbService";
import { normalizeMediaTitle } from "../src/services/mediaParser";

type LookupState = "success" | "failure" | "timeout";
type CheckpointEntry = { key: string; state: LookupState; cache: "hit" | "miss"; updatedAt: string };
type Checkpoint = { schemaVersion: 1; entries: Record<string, CheckpointEntry> };

const sampleSize = Math.max(1, Number(process.env.MATRIX_SAMPLE_SIZE || 8));
const requestTimeoutMs = Math.max(250, Number(process.env.MATRIX_REQUEST_TIMEOUT_MS || 3000));
const retryLimit = Math.max(0, Number(process.env.MATRIX_RETRIES || 1));
const globalTimeoutMs = Math.max(1000, Number(process.env.MATRIX_GLOBAL_TIMEOUT_MS || 30000));
const sampleOffset = Math.max(0, Number(process.env.MATRIX_SAMPLE_OFFSET || 0));
const ignoreCache = process.env.MATRIX_IGNORE_CACHE === "true";
const testDelayMs = Math.max(0, Number(process.env.MATRIX_TEST_DELAY_MS || 0));
const fullMatrix = process.env.MATRIX_FULL === "true";
const checkpointPath = process.env.MATRIX_CHECKPOINT || "/data/version-manager-matrix-checkpoint.json";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("TMDB_REQUEST_TIMEOUT")), milliseconds)),
  ]);
}

function loadCheckpoint(): Checkpoint {
  if (!existsSync(checkpointPath)) return { schemaVersion: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
    if (parsed?.schemaVersion === 1 && parsed.entries && typeof parsed.entries === "object") return parsed;
  } catch { /* corrupted checkpoints are safely restarted */ }
  return { schemaVersion: 1, entries: {} };
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
}

function lookupKey(version: VersionRecord): { key: string; title: string; kind: "movie" | "tv"; year?: number } | undefined {
  const identity = version.fingerprint.identity;
  if (!identity.title || !isMediaFileName(version.fingerprint.storage.path)) return undefined;
  const kind = identity.kind === "episode" ? "tv" : identity.kind === "movie" ? "movie" : undefined;
  if (!kind) return undefined;
  const normalized = normalizeMediaTitle(identity.title);
  return { key: `tmdb:${kind}:${normalized}:${identity.year || ""}`, title: identity.title, kind, year: identity.year };
}

async function lookupWithRetry(item: { title: string; kind: "movie" | "tv"; year?: number }): Promise<{ state: LookupState; cache: "hit" | "miss" }> {
  const cacheKey = `tmdb:${item.kind}:${normalizeMediaTitle(item.title)}:${item.year || ""}`;
  if (!ignoreCache && getCachedVersionManagerMetadata(cacheKey)) return { state: "success", cache: "hit" };
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      const operation = (async () => {
        if (testDelayMs) await new Promise((resolve) => setTimeout(resolve, testDelayMs));
        return searchTmdb(item.title, item.kind, item.year);
      })();
      const result = await timeout(operation, requestTimeoutMs);
      if (result.status === "matched" && result.metadata) {
        saveVersionManagerMetadataCache(cacheKey, "TMDB", {
          title: result.metadata.title,
          year: result.metadata.year,
          kind: result.metadata.kind === "tv" ? "show" : "movie",
          tmdbId: result.metadata.tmdbId,
          imdbId: result.metadata.imdbId,
          tvdbId: result.metadata.tvdbId,
          originalLanguage: result.metadata.originalLanguage,
          source: "TMDB",
        });
        return { state: "success", cache: "miss" };
      }
      return { state: "failure", cache: "miss" };
    } catch (error: any) {
      const isTimeout = error?.message === "TMDB_REQUEST_TIMEOUT";
      if (attempt >= retryLimit) return { state: isTimeout ? "timeout" : "failure", cache: "miss" };
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  return { state: "failure", cache: "miss" };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const checkpoint = loadCheckpoint();
  const inventory = (await Promise.all(registry.configured().map((provider) => provider.listTorrents()))).flat();
  const versions = inventory.flatMap((torrent) => fingerprintTorrent(torrent, "alldebrid"));
  const unique = new Map<string, { item: ReturnType<typeof lookupKey>; fingerprintId: string }>();
  for (const version of versions) {
    const item = lookupKey(version);
    if (item && !unique.has(item.key)) unique.set(item.key, { item, fingerprintId: version.id });
  }
  const selected = [...unique.values()].slice(sampleOffset, sampleOffset + sampleSize);
  const summary = { totalFingerprints: versions.length, uniqueLookupKeys: unique.size, selected: selected.length, resumed: 0, cacheHit: 0, cacheMiss: 0, success: 0, failure: 0, timeout: 0, interrupted: false, elapsedMs: 0 };
  console.log(JSON.stringify({ event: "matrix-start", total: selected.length, fingerprints: versions.length, checkpoint: checkpointPath, requestTimeoutMs, retryLimit, globalTimeoutMs, sampleOffset, ignoreCache, testDelayMs }));
  const run = (async () => {
    for (let index = 0; index < selected.length; index += 1) {
      const selectedItem = selected[index];
      if (!selectedItem.item) continue;
      const prior = checkpoint.entries[selectedItem.item.key];
      if (prior) { summary.resumed += 1; summary[prior.cache === "hit" ? "cacheHit" : "cacheMiss"] += 1; summary[prior.state] += 1; console.log(JSON.stringify({ event: "progress", index: index + 1, total: selected.length, fingerprint: hash(selectedItem.fingerprintId), lookup: hash(selectedItem.item.key), state: prior.state, cache: prior.cache, resumed: true })); continue; }
      const result = await lookupWithRetry(selectedItem.item);
      checkpoint.entries[selectedItem.item.key] = { key: hash(selectedItem.item.key), state: result.state, cache: result.cache, updatedAt: new Date().toISOString() };
      saveCheckpoint(checkpoint);
      summary[result.cache === "hit" ? "cacheHit" : "cacheMiss"] += 1;
      summary[result.state] += 1;
      console.log(JSON.stringify({ event: "progress", index: index + 1, total: selected.length, fingerprint: hash(selectedItem.fingerprintId), lookup: hash(selectedItem.item.key), state: result.state, cache: result.cache, elapsedMs: Date.now() - startedAt }));
    }
  })();
  try { await timeout(run, globalTimeoutMs); } catch (error: any) { summary.interrupted = true; console.log(JSON.stringify({ event: "global-timeout", reason: error?.message || "MATRIX_TIMEOUT" })); }
  summary.elapsedMs = Date.now() - startedAt;
  saveCheckpoint(checkpoint);
  console.log(JSON.stringify({ event: "matrix-summary", ...summary }));
  if (fullMatrix) await runFullMatrix(inventory);
}

async function runFullMatrix(inventory: TorrentInfo[]): Promise<void> {
  const profiles = defaultVersionProfiles.map((profile) => profile.id === "remote" ? { ...profile, enabled: true } : profile);
  const modes: Record<string, typeof mediaServerProviders> = {
    "TMDb only": [],
    "TMDb + Plex": mediaServerProviders.filter((provider) => provider.id === "PLEX"),
    "TMDb + Jellyfin": mediaServerProviders.filter((provider) => provider.id === "JELLYFIN"),
    "TMDb + Plex + Jellyfin": [...mediaServerProviders],
  };
  for (const [mode, providers] of Object.entries(modes)) {
    const started = Date.now();
    const versions = inventory.flatMap((torrent) => fingerprintTorrent(torrent, "alldebrid")).map((version) => structuredClone(version));
    let processed = 0;
    let interrupted = false;
    console.log(JSON.stringify({ event: "matrix-pass-start", mode, total: versions.length, providers: providers.map((provider) => provider.id) }));
    const pass = enrichVersionMetadata(versions, {
      providers,
      tmdb: { timeoutMs: requestTimeoutMs, retries: retryLimit, backoffMs: 250 },
      onProgress: (progress) => {
        processed = progress.index;
        if (progress.index === 1 || progress.index % 25 === 0 || progress.index === progress.total) console.log(JSON.stringify({ event: "matrix-progress", mode, index: progress.index, total: progress.total, fingerprint: hash(progress.fingerprintId), state: progress.state, cache: progress.cache, elapsedMs: progress.elapsedMs }));
      },
    });
    let metadata;
    try { metadata = await timeout(pass, globalTimeoutMs); } catch (error: any) { interrupted = true; console.log(JSON.stringify({ event: "matrix-pass-timeout", mode, processed, reason: error?.message || "MATRIX_TIMEOUT" })); }
    if (interrupted || !metadata) continue;
    const groups = evaluateVersionGroups(versions, profiles, { enableRemote: true, acquireMissingRemote: true });
    const needs = deriveAcquisitionNeeds(groups, profiles, { adapterId: "seerr", acquisitionEnabled: true });
    const primarySatisfied = groups.filter((group) => group.profileStatuses?.find((item) => item.profileId === "primary")?.satisfied).length;
    const remoteSatisfied = groups.filter((group) => group.remote?.status === "SATISFIED").length;
    const remoteMissing = groups.filter((group) => group.remote?.status === "REMOTE_MISSING").length;
    const remote2160 = groups.flatMap((group) => group.versions.filter((version) => version.fingerprint.video.resolution === "2160p" && version.evaluations.some((evaluation) => evaluation.profileId === "remote" && evaluation.eligible))).length;
    const identity = Object.fromEntries(["resolved", "fallback", "uncertain", "conflict"].map((state) => [state, versions.filter((version) => version.fingerprint.identity.resolutionStatus === state).length]));
    const exportResult = exportMigrationLibrary(inventory, groups, { mode: "FULL_LIBRARY" });
    console.log(JSON.stringify({ event: "matrix-pass-summary", mode, providerItems: inventory.length, completed: inventory.filter((item: any) => item.status === "finished" && item.progress === 100).length, fingerprints: versions.length, groups: groups.length, multiversion: groups.filter((group) => group.versions.length > 1).length, identity, originalLanguageKnown: versions.filter((version) => Boolean(version.fingerprint.identity.originalLanguage)).length, metadata, profiles: { primarySatisfied, primaryMissing: groups.length - primarySatisfied, remoteSatisfied, remoteMissing, remote2160 }, acquisition: { total: needs.length, eligible: needs.filter((need) => need.acquisitionEligibility.eligible).length, blocked: needs.filter((need) => !need.acquisitionEligibility.eligible).length, primary: needs.filter((need) => need.missingProfileId === "primary").length, remote: needs.filter((need) => need.missingProfileId === "remote").length }, export: { items: exportResult.manifest.items.length, exportable: exportResult.manifest.exportableItemCount, magnets: exportResult.manifest.magnetCount }, elapsedMs: Date.now() - started }));
  }
}

await main();
