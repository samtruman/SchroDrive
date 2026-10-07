/**
 * SchroDrive — HTTP API Server
 *
 * Defines the Express HTTP server with all REST API routes and SSE streaming
 * endpoints powering the SchroDrive web GUI. Provides endpoints for:
 *
 * - Health checks and system status
 * - Configuration management (read, update, restart)
 * - Provider connectivity and torrent/download listing
 * - SSE streaming for real-time torrent and download data
 * - Indexer search (Jackett/Prowlarr) and magnet submission
 * - Log viewing and streaming
 * - Overseerr webhook integration
 * - Mounted filesystem browsing
 *
 * @module server
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { config } from "./core/config";
import { searchIndexer, pickBestResult, getMagnet, getProviderName, isIndexerConfigured } from "./indexers/index";
import { registry, type DebridProvider, type RecoverabilityEvidence, type TorrentInfo, type DownloadInfo } from "./providers";
import { startOverseerrPoller } from "./services/overseerr";
import { startAutoUpdater } from "./services/autoUpdate";
import { getConfigWithSources, saveConfigToFile, triggerRestart, isRunningInDocker, CONFIG_SCHEMA } from "./core/configApi";
import { logBuffer } from "./core/logger";
import { rateLimiter } from "./core/rateLimiter";
import { getBridgeStatuses, refreshBridges, getExternalWebdavStatus, getMountReadiness } from "./services/mount";
import { getPreWarmStatus } from "./services/cloudLinks/bridge";
import { getBlacklistEntries, getBlacklistCount, addToBlacklist, removeFromBlacklist, isBlacklisted } from "./core/blacklist";
import { tokenRotator } from "./core/tokenRotator";
import { clearOrganizerReviewOverride, decideOrganizerReview, filterOrganizerReviewsByParserStatus, listOrganizerReviewAudit, listOrganizerReviews, retryOrganizerReview, validateReviewOverride } from "./services/organizerReview";
import { browseMountedFilesystem, FilesystemBrowserError } from "./core/filesystemBrowser";
import { evaluateVersionGroups, validateRule, validateScoringRules, versionManagerPolicyHash, type VersionRecord } from "./services/versionManager";
import { loadMediaManagerInventory, type MediaManagerInventoryStats } from "./services/mediaManagerInventory";
import { deriveAcquisitionNeeds } from "./services/acquisition";
import { SeerrAcquisitionAdapter } from "./services/seerrAcquisitionAdapter";
import { getLatestVersionManagerRecords, getLatestVersionManagerScan, getLatestVersionManagerSnapshot, getVersionManagerPolicy, getVersionProfiles, saveVersionManagerPolicy, saveVersionManagerPreviewAudit, saveVersionManagerScan, saveVersionManagerSnapshot, saveVersionProfiles } from "./services/versionManagerStore";
import { probeVersionRecords } from "./services/versionManagerProbe";
import { enrichVersionMetadata } from "./services/versionManagerMetadata";
import { searchTmdbCandidates } from "./services/tmdbService";
import { applyManualIdentityOverrides, clearManualIdentityOverride, clearManualIdentityOverrideForVersion, identityOverrideKey, saveManualIdentityOverride, saveManualIdentityOverrideForVersion, type ManualIdentityOverride } from "./services/manualIdentity";
import { exportMigrationLibrary, normalizeMigrationExportMode, resolveProviderItemRecoverability } from "./services/migrationExporter";
import { analyzeMigrationImport, executeMigrationImportBulk, executeMigrationImportItem, getRecoverableManifestItem, migrationAuditOutcome } from "./services/migrationImporter";
import { aggregateMigrationJobs, effectiveMigrationStatus } from "./services/migrationState";
import { migrationRouteLevel, providerMigrationCapabilities } from "./services/providerMigrationCapabilities";
import { listMigrationAudit, listVersionManagerDeleteAudit, recordAcquisitionAudit, recordMigrationAudit, recordVersionManagerDeleteAudit } from "./core/db";
import { buildUnifiedReviewQueue, setVersionManagerReviewDismissed } from "./services/unifiedReview";
import { getVersionManagerScanRuntimeStatus, getVersionManagerScanStatus, startVersionManagerScan } from "./services/versionManagerScanJob";
import { createMagnetBackup, deleteMagnetBackup, getMagnetBackupSchedule, listMagnetBackups, magnetBackupDirectory, readMagnetBackup, saveMagnetBackupSchedule, startMagnetBackupScheduler, verifyMagnetBackup } from "./services/magnetBackup";
import { buildDeleteImpact } from "./services/deleteImpact";
import { BatchDeleteExecutionError, ProviderInventoryDriftError, executeVersionManagerDelete, executeVersionManagerDeleteBatch } from "./services/deleteExecutor";
import { getMigrationJob, listMigrationJobs, startMigrationJob } from "./services/migrationJob";
import { discoverSeerrArrProfiles } from "./services/seerrArrProfiles";

// ===========================================================================
// Server Initialisation
// ===========================================================================

async function loadVersionManagerInventory(stats?: MediaManagerInventoryStats): Promise<VersionRecord[]> {
  return loadMediaManagerInventory(undefined, stats);
}

function configuredMediaManagerProvider(requested?: unknown): DebridProvider | undefined {
  const providers = registry.configured();
  const id = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (id) return providers.find((provider) => provider.id === id);
  return providers.find((provider) => provider.id === "alldebrid") || providers[0];
}

function readVersionManagerGroups(providerId: string): { groups: any[]; snapshotId: string; snapshotCreatedAt: string; snapshotPolicyHash?: string; providerId: string } | null {
  const snapshot = getLatestVersionManagerSnapshot(providerId);
  if (!snapshot) return null;
  const storedVersions = snapshot.groups.flatMap((group: any) => (group.versions || []).map((version: any) => ({ id: version.id, fingerprint: version.fingerprint })));
  const evaluated = applyManualIdentityOverrides(storedVersions);
  return {
    groups: evaluateVersionGroups(evaluated, getVersionProfiles(), getVersionManagerPolicy()),
    snapshotId: snapshot.id,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotPolicyHash: snapshot.policyHash,
    providerId,
  };
}

function summarizeVersionManagerGroups(groups: any[], policy: ReturnType<typeof getVersionManagerPolicy>, profiles = getVersionProfiles()) {
  const versions = groups.flatMap((group) => group.versions || []);
  const primaryProfileIds = new Set(profiles.filter((profile) => profile.enabled && profile.target !== "DIRECT_PLAY").map((profile) => profile.id));
  const primaryMissing = groups.filter((group) => group.profileStatuses?.some((status: any) => primaryProfileIds.has(status.profileId) && !status.satisfied) || false).length;
  const remoteMissing = policy.enableRemote ? groups.filter((group) => group.remote?.status === "REMOTE_MISSING").length : 0;
  return {
    contentCount: groups.length,
    versionGroupCount: groups.length,
    versionCount: versions.length,
    keepCount: versions.filter((version: any) => version.decision === "KEEP").length,
    deleteCandidateCount: versions.filter((version: any) => version.decision === "DELETE_CANDIDATE").length,
    reviewCount: versions.filter((version: any) => version.decision === "REVIEW").length,
    primaryMissing,
    remoteMissing,
  };
}

function applyVersionManagerDeletionDelta(providerId: string, snapshotId: string, deletedProviderItemIds: string[]) {
  const snapshot = getLatestVersionManagerSnapshot(providerId);
  if (!snapshot || snapshot.id !== snapshotId) throw new Error("Inventory changed; reload Delete before continuing");
  const deleted = new Set(deletedProviderItemIds.map(String));
  const originalVersionCount = snapshot.groups.reduce((count, group) => count + group.versions.length, 0);
  const records = snapshot.groups
    .flatMap((group) => group.versions)
    .filter((version) => {
      const storage = (version.fingerprint as any)?.storage;
      return !(String(storage?.provider || "") === providerId && deleted.has(String(storage?.torrentId || "")));
    })
    .map((version) => ({ id: version.id, fingerprint: version.fingerprint }));
  const evaluated = evaluateVersionGroups(applyManualIdentityOverrides(records), getVersionProfiles(), getVersionManagerPolicy());
  const profiles = getVersionProfiles();
  const policy = getVersionManagerPolicy();
  const newSnapshotId = saveVersionManagerSnapshot(evaluated, profiles, {
    providerId,
    policyHash: versionManagerPolicyHash(policy, profiles),
    status: "VALID",
  });
  const summary = summarizeVersionManagerGroups(evaluated, policy, profiles);
  saveVersionManagerPreviewAudit({
    policyHash: versionManagerPolicyHash(policy, profiles),
    evaluatedAt: new Date().toISOString(),
    ...summary,
  });
  return { snapshotId: newSnapshotId, removedVersionCount: originalVersionCount - evaluated.reduce((count, group) => count + group.versions.length, 0), ...summary };
}

/**
 * Initialises and starts the Express HTTP server with all API routes,
 * SSE streaming endpoints, and optional background services (Overseerr poller,
 * auto-updater).
 *
 * The server listens on the port specified in `config.port`.
 */
export function startServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cors()); // Allow web GUI to connect

  // ===========================================================================
  // Health Check
  // ===========================================================================

  /** GET /health — Simple liveness probe. */
  app.get("/health", (_req, res) => {
    const preWarm = getPreWarmStatus();
    res.json({
      ok: true,
      cloudLinksPreWarm: preWarm,
    });
  });

  // ===========================================================================
  // Configuration API
  // ===========================================================================

  /**
   * GET /api/config — Returns the current configuration with metadata.
   * Includes the env file path, Docker detection flag, and schema definition
   * for the web GUI's settings editor.
   */
  app.get("/api/config", (_req, res) => {
    try {
      const { config: configData, envPath } = getConfigWithSources();
      res.json({
        ok: true,
        config: configData,
        envPath,
        isDocker: isRunningInDocker(),
        schema: CONFIG_SCHEMA,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/config — Persists configuration updates to the env file.
   * Expects `{ config: { key: value, ... } }` in the request body.
   */
  app.post("/api/config", (req, res) => {
    try {
      const updates = req.body?.config || {};
      const result = saveConfigToFile(updates);
      if (result.success) {
        res.json({ ok: true, message: "Configuration saved", path: result.path });
      } else {
        res.status(500).json({ ok: false, error: result.error, path: result.path });
      }
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** POST /api/restart — Triggers a graceful process restart. */
  app.post("/api/restart", (_req, res) => {
    try {
      const result = triggerRestart();
      res.json({ ok: result.success, message: result.message });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/status — Returns system status including active services
   * and indexer configuration.
   */
  app.get("/api/status", (_req, res) => {
    res.json({
      ok: true,
      isDocker: isRunningInDocker(),
      services: {
        webhook: config.runWebhook,
        poller: config.runPoller,
        mount: config.runMount,
        deadScanner: config.runDeadScanner,
        deadScannerWatch: config.runDeadScannerWatch,
        organizerWatch: config.runOrganizerWatch,
        watchlistPoller: config.runWatchlistPoller,
      },
      indexer: {
        configured: isIndexerConfigured(),
        provider: isIndexerConfigured() ? getProviderName() : null,
      },
      mediaServers: {
        plex: { configured: !!config.plexUrl && !!config.plexToken, url: config.plexUrl || null },
        jellyfin: { configured: !!config.jellyfinUrl && !!config.jellyfinApiKey, url: config.jellyfinUrl || null },
        emby: { configured: !!config.embyUrl && !!config.embyApiKey, url: config.embyUrl || null },
      },
      infringementList: {
        version: '1.0',
        lastModified: new Date().toISOString(),
        count: getBlacklistCount(),
      },
      webdavBridges: getBridgeStatuses(),
      externalWebdavMounts: getExternalWebdavStatus(),
      tokenRotation: (() => {
        const status = tokenRotator.getAllStatus();
        const summary: Record<string, { activeTokens: number; limitedTokens: number; totalTokens: number }> = {};
        for (const [provider, s] of Object.entries(status)) {
          summary[provider] = {
            activeTokens: s.activeCount,
            limitedTokens: s.limitedCount,
            totalTokens: s.downloadTokens.length || 1,
          };
        }
        return summary;
      })(),
    });
  });

  // ===========================================================================
  // Version Manager (read-only preview)
  // ===========================================================================

  /**
   * GET /api/version-manager/status — Reports the safe initial state.
   * The first milestone is deliberately read-only and never calls a provider
   * delete operation.
   */
  app.get("/api/version-manager/providers", (_req, res) => {
    const configured = registry.configured().sort((left, right) => Number(right.id === "alldebrid") - Number(left.id === "alldebrid"));
    const providers = configured.map((provider, index) => ({ id: provider.id, name: provider.displayName, default: index === 0 }));
    res.json({ ok: true, providers });
  });

  app.get("/api/version-manager/status", (_req, res) => {
    const provider = configuredMediaManagerProvider(_req.query.provider);
    if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
    const profiles = getVersionProfiles();
    const policy = getVersionManagerPolicy();
    const currentPolicyHash = versionManagerPolicyHash(policy, profiles);
    const evaluated = readVersionManagerGroups(provider.id);
    res.json({
      ok: true,
      enabled: true,
      mode: policy.safety?.deleteDryRun !== false ? "DRY_RUN" : "LIVE",
      deleteExecutor: "enabled",
      policy,
      policyHash: versionManagerPolicyHash(policy, profiles),
      profiles,
      provider: { id: provider.id, name: provider.displayName },
      latestScan: getLatestVersionManagerScan(provider.id) || null,
      policyEvaluation: evaluated ? {
        status: evaluated.snapshotPolicyHash === currentPolicyHash ? "CURRENT" : "STALE",
        snapshotPolicyHash: evaluated.snapshotPolicyHash || null,
        currentPolicyHash,
        snapshotId: evaluated.snapshotId,
        evaluatedAt: evaluated.snapshotCreatedAt,
        counts: summarizeVersionManagerGroups(evaluated.groups, policy, profiles),
      } : { status: "NOT_EVALUATED", snapshotPolicyHash: null, currentPolicyHash },
      scanJob: getVersionManagerScanRuntimeStatus(provider.id),
    });
  });

  /** Read-only Seerr gateway discovery. ARR profiles remain owned by ARR. */
  app.get("/api/version-manager/acquisition/arr-profiles", async (_req, res) => {
    try { return res.json({ ok: true, readOnly: true, discovery: await discoverSeerrArrProfiles() }); }
    catch (error: any) { return res.status(503).json({ ok: false, error: error?.message || "Seerr ARR discovery unavailable" }); }
  });

  /** Evaluates unsaved profile changes against the latest valid snapshot only. */
  app.post("/api/version-manager/profiles/preview", (req, res) => {
    try {
      if (!Array.isArray(req.body?.profiles) || req.body.profiles.length === 0) return res.status(400).json({ ok: false, error: "profiles must be a non-empty array" });
      const provider = configuredMediaManagerProvider(req.body?.provider);
      if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
      const snapshot = getLatestVersionManagerSnapshot(provider.id);
      if (!snapshot || snapshot.status !== "VALID") return res.status(409).json({ ok: false, error: "No valid inventory snapshot is available" });
      const profiles = req.body.profiles.map((profile: any) => ({ ...profile, arrProfiles: profile.arrProfiles ? {
        movie: profile.arrProfiles.movie ? { ...profile.arrProfiles.movie, provider: "radarr" } : undefined,
        tv: profile.arrProfiles.tv ? { ...profile.arrProfiles.tv, provider: "sonarr" } : undefined,
      } : undefined, hardRequirements: profile.hardRequirements ? validateRule(profile.hardRequirements) : undefined, scoringRules: profile.scoringRules ? validateScoringRules(profile.scoringRules) : undefined }));
      const policy = { ...getVersionManagerPolicy(), ...(req.body.policy || {}), safety: { ...getVersionManagerPolicy().safety, ...(req.body.policy?.safety || {}) } };
      const records = applyManualIdentityOverrides(getLatestVersionManagerRecords(provider.id));
      const current = evaluateVersionGroups(records, getVersionProfiles(), getVersionManagerPolicy());
      const proposed = evaluateVersionGroups(records, profiles, policy);
      const decisions = (groups: any[]) => groups.flatMap((group) => group.versions).reduce((counts: Record<string, number>, version: any) => { counts[version.decision] = (counts[version.decision] || 0) + 1; return counts; }, {});
      const currentDecisions = decisions(current); const proposedDecisions = decisions(proposed);
      const currentById = new Map(current.flatMap((group) => group.versions).map((version: any) => [version.id, version.decision]));
      const changed = proposed.flatMap((group) => group.versions).filter((version: any) => currentById.get(version.id) !== version.decision).map((version: any) => ({ id: version.id, from: currentById.get(version.id), to: version.decision, identity: version.fingerprint.identity }));
      return res.json({ ok: true, readOnly: true, snapshotId: snapshot.id, current: { decisions: currentDecisions }, proposed: { decisions: proposedDecisions, policyHash: versionManagerPolicyHash(policy, profiles) }, changed, missingProfiles: proposed.flatMap((group) => group.remote?.status === "REMOTE_MISSING" ? [group] : []).length });
    } catch (err: any) { return res.status(400).json({ ok: false, error: err?.message || "Unable to preview profile impact" }); }
  });

  /** POST /api/version-manager/scan — starts or joins the canonical scan job. */
  app.post("/api/version-manager/scan", (_req, res) => {
    const provider = configuredMediaManagerProvider(_req.query.provider || _req.body?.provider);
    if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
    const job = startVersionManagerScan(provider.id);
    res.status(202).json({ ok: true, provider: provider.id, job, statusUrl: `/api/version-manager/scan/${encodeURIComponent(job.id)}`, resultUrl: `/api/version-manager/preview?provider=${encodeURIComponent(provider.id)}` });
  });

  /** GET /api/version-manager/scan — returns the current scan job, if any. */
  app.get("/api/version-manager/scan", (_req, res) => {
    const provider = configuredMediaManagerProvider(_req.query.provider);
    if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
    res.json({ ok: true, provider: provider.id, ...getVersionManagerScanRuntimeStatus(provider.id) });
  });

  app.get("/api/version-manager/scan/:id", (req, res) => {
    const job = getVersionManagerScanStatus(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: "Scan job not found" });
    return res.json({ ok: true, job, resultUrl: `/api/version-manager/preview?provider=${encodeURIComponent(job.providerId)}` });
  });

  /** Applies a successful provider deletion to the cached inventory without a provider rescan. */
  app.post("/api/version-manager/snapshot/apply-deletion", (req, res) => {
    try {
      const provider = configuredMediaManagerProvider(req.body?.provider);
      const snapshotId = String(req.body?.snapshotId || "");
      const providerItemIds = Array.isArray(req.body?.providerItemIds) ? req.body.providerItemIds.map(String).filter(Boolean) : [];
      if (!provider || !snapshotId || providerItemIds.length === 0) return res.status(400).json({ ok: false, error: "provider, snapshotId and providerItemIds are required" });
      const result = applyVersionManagerDeletionDelta(provider.id, snapshotId, providerItemIds);
      return res.json({ ok: true, mode: "INCREMENTAL", provider: provider.id, ...result });
    } catch (error: any) {
      return res.status(409).json({ ok: false, error: error?.message || "Unable to update inventory snapshot incrementally", refreshRequired: true });
    }
  });

  /**
   * GET /api/version-manager/preview — Builds a live, read-only inventory
   * projection and evaluates configured profiles in memory.
   */
  app.get("/api/version-manager/preview", async (_req, res) => {
    try {
      const provider = configuredMediaManagerProvider(_req.query.provider);
      if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
      const snapshot = readVersionManagerGroups(provider.id);
      if (!snapshot) return res.status(503).json({ ok: false, snapshotAvailable: false, error: "No valid inventory snapshot is available; start a scan" });
      const groups = snapshot.groups;
      const policy = getVersionManagerPolicy();
      const profiles = getVersionProfiles();
      const versions = groups.flatMap((group: any) => group.versions || []);
      return res.json({ ok: true, provider: provider.id, mode: "dry-run", scanId: snapshot.snapshotId, snapshotCreatedAt: snapshot.snapshotCreatedAt, policyHash: versionManagerPolicyHash(policy, profiles), inventoryCount: versions.length, groupCount: groups.length, groups });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Version Manager preview failed" });
    }
  });

  /** Read-only policy evaluation intended for cleanup review. It never calls provider delete. */
  app.get("/api/version-manager/delete-preview", async (_req, res) => {
    try {
      const startedAt = Date.now();
      const provider = configuredMediaManagerProvider(_req.query.provider);
      if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
      const snapshot = readVersionManagerGroups(provider.id);
      if (!snapshot) return res.status(503).json({ ok: false, snapshotAvailable: false, error: "No valid inventory snapshot is available; start a scan" });
      const groups = snapshot.groups;
      const policy = getVersionManagerPolicy();
      const profiles = getVersionProfiles();
      const versionsFlat = groups.flatMap((group) => group.versions);
      const counts = {
        contents: groups.length,
        versionGroups: groups.length,
        versions: versionsFlat.length,
        KEEP: versionsFlat.filter((version) => version.decision === "KEEP").length,
        DELETE_CANDIDATE: versionsFlat.filter((version) => version.decision === "DELETE_CANDIDATE").length,
        REVIEW: versionsFlat.filter((version) => version.decision === "REVIEW").length,
        primaryMissing: groups.filter((group: any) => group.profileStatuses?.some((status: any) => status.profileId === "primary" && !status.satisfied)).length,
        remoteMissing: policy.enableRemote ? groups.filter((group: any) => group.remote?.status === "REMOTE_MISSING").length : 0,
      };
      const evaluatedAt = new Date().toISOString();
      const policyHash = versionManagerPolicyHash(policy, profiles);
      saveVersionManagerPreviewAudit({ policyHash, evaluatedAt, contentCount: counts.contents, versionGroupCount: counts.versionGroups, versionCount: counts.versions, keepCount: counts.KEEP, deleteCandidateCount: counts.DELETE_CANDIDATE, reviewCount: counts.REVIEW, primaryMissing: counts.primaryMissing, remoteMissing: counts.remoteMissing });
      const dryRun = policy.safety?.deleteDryRun !== false;
      return res.json({ ok: true, provider: provider.id, readOnly: dryRun, mode: dryRun ? "DRY_RUN" : "LIVE", deleteExecutor: "enabled", snapshotId: snapshot.snapshotId, snapshotCreatedAt: snapshot.snapshotCreatedAt, evaluatedAt, policyVersion: policy.policyVersion || "1", policyHash, counts, groups, performance: { totalMs: Date.now() - startedAt, source: "persisted-snapshot" } });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Delete preview failed" });
    }
  });

  /** Physical delete-unit impact. Execution mode is controlled by the persisted safety flag. */
  app.get("/api/version-manager/delete", (_req, res) => {
    try {
      const provider = configuredMediaManagerProvider(_req.query.provider);
      if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
      const snapshot = readVersionManagerGroups(provider.id);
      if (!snapshot) return res.status(503).json({ ok: false, snapshotAvailable: false, error: "No valid inventory snapshot is available; start a scan" });
      const query = typeof _req.query.q === "string" ? _req.query.q : "";
      const scope = typeof _req.query.scope === "string" ? _req.query.scope : "all";
      const dryRun = getVersionManagerPolicy().safety?.deleteDryRun !== false;
      return res.json({ ok: true, provider: provider.id, readOnly: dryRun, executorEnabled: true, dryRun, mode: dryRun ? "DRY_RUN" : "LIVE", scope, snapshotId: snapshot.snapshotId, items: buildDeleteImpact(snapshot.groups, query, scope) });
    } catch (error: any) { return res.status(500).json({ ok: false, error: error?.message || "Delete impact unavailable" }); }
  });

  app.get("/api/version-manager/delete/history", (_req, res) => {
    try { return res.json({ ok: true, items: listVersionManagerDeleteAudit(200) }); }
    catch (error: any) { return res.status(500).json({ ok: false, error: error?.message || "Delete history unavailable" }); }
  });

  app.post("/api/version-manager/delete/execute", async (req, res) => {
    const providerId = String(req.body?.provider || "");
    const providerItemId = String(req.body?.providerItemId || "");
    const requestedSnapshotId = String(req.body?.snapshotId || "");
    const selection = Array.isArray(req.body?.selection)
      ? req.body.selection.map((item: any) => ({ provider: String(item?.provider || ""), providerItemId: String(item?.providerItemId || "") })).filter((item: any) => item.provider && item.providerItemId)
      : undefined;
    const snapshot = providerId ? readVersionManagerGroups(providerId) : null;
    const policyDryRun = getVersionManagerPolicy().safety?.deleteDryRun !== false;
    const dryRun = policyDryRun || req.body?.dryRun === true;
    const mode = dryRun ? "DRY_RUN" as const : "LIVE" as const;
    try {
      if (!providerId || !providerItemId || !requestedSnapshotId) return res.status(400).json({ ok: false, error: "provider, providerItemId and snapshotId are required" });
      if (!snapshot) return res.status(503).json({ ok: false, error: "No valid inventory snapshot is available; start a scan" });
      if (snapshot.snapshotId !== requestedSnapshotId) return res.status(409).json({ ok: false, error: "Inventory changed; reload Delete before continuing" });
      const provider = registry.get(providerId);
      if (!provider) return res.status(400).json({ ok: false, error: `Provider ${providerId} is not configured` });
      const result = await executeVersionManagerDelete({ groups: snapshot.groups, provider, providerItemId, dryRun, confirmation: req.body?.confirmation, selection });
      recordVersionManagerDeleteAudit({ provider: providerId, providerItemId, snapshotId: snapshot.snapshotId, mode, status: result.status, detail: dryRun ? "ProviderItem revalidated; provider delete was not called" : "ProviderItem deleted after final revalidation" });
      return res.json({ ok: true, policyDryRun, mode, ...result });
    } catch (error: any) {
      if (providerId && providerItemId) recordVersionManagerDeleteAudit({ provider: providerId, providerItemId, snapshotId: snapshot?.snapshotId || requestedSnapshotId || "unknown", mode, status: "FAILED", detail: error?.message || "Delete execution failed" });
      return res.status(409).json({ ok: false, policyDryRun, mode, error: error?.message || "Delete execution failed" });
    }
  });

  app.post("/api/version-manager/delete/execute-batch", async (req, res) => {
    const providerId = String(req.body?.provider || "");
    const providerItemIds = Array.isArray(req.body?.providerItemIds) ? req.body.providerItemIds.map(String) : [];
    const requestedSnapshotId = String(req.body?.snapshotId || "");
    const selection = Array.isArray(req.body?.selection)
      ? req.body.selection.map((item: any) => ({ provider: String(item?.provider || ""), providerItemId: String(item?.providerItemId || "") })).filter((item: any) => item.provider && item.providerItemId)
      : undefined;
    const snapshot = providerId ? readVersionManagerGroups(providerId) : null;
    const policyDryRun = getVersionManagerPolicy().safety?.deleteDryRun !== false;
    const dryRun = policyDryRun || req.body?.dryRun === true;
    const mode = dryRun ? "DRY_RUN" as const : "LIVE" as const;
    try {
      if (!providerId || providerItemIds.length === 0 || !requestedSnapshotId) return res.status(400).json({ ok: false, error: "provider, providerItemIds and snapshotId are required" });
      if (!snapshot) return res.status(503).json({ ok: false, error: "No valid inventory snapshot is available; start a scan" });
      if (snapshot.snapshotId !== requestedSnapshotId) return res.status(409).json({ ok: false, error: "Inventory changed; reload Delete before continuing" });
      const provider = registry.get(providerId);
      if (!provider) return res.status(400).json({ ok: false, error: `Provider ${providerId} is not configured` });
      const result = await executeVersionManagerDeleteBatch({ groups: snapshot.groups, provider, providerItemIds, dryRun, confirmation: req.body?.confirmation, selection });
      result.results.forEach((item) => recordVersionManagerDeleteAudit({ provider: providerId, providerItemId: item.providerItemId, snapshotId: snapshot.snapshotId, mode, status: item.status, detail: dryRun ? "Batch ProviderItem revalidated; provider delete was not called" : "ProviderItem deleted by confirmed batch after final revalidation" }));
      return res.json({ ok: true, policyDryRun, mode, ...result });
    } catch (error: any) {
      const batchError = error instanceof BatchDeleteExecutionError ? error : undefined;
      const inventoryDrift = error instanceof ProviderInventoryDriftError ? error : undefined;
      for (const id of batchError?.completedIds || []) recordVersionManagerDeleteAudit({ provider: providerId, providerItemId: id, snapshotId: snapshot?.snapshotId || requestedSnapshotId || "unknown", mode, status: "DELETED", detail: "ProviderItem deleted before the batch stopped" });
      if (batchError?.failedProviderItemId) recordVersionManagerDeleteAudit({ provider: providerId, providerItemId: batchError.failedProviderItemId, snapshotId: snapshot?.snapshotId || requestedSnapshotId || "unknown", mode, status: "FAILED", detail: error?.message || "Batch delete failed" });
      for (const id of inventoryDrift?.staleProviderItemIds || []) recordVersionManagerDeleteAudit({ provider: providerId, providerItemId: id, snapshotId: snapshot?.snapshotId || requestedSnapshotId || "unknown", mode, status: "FAILED", detail: "ProviderItem is already absent; inventory refresh required before continuing" });
      return res.status(409).json({
        ok: false,
        policyDryRun,
        mode,
        completedIds: batchError?.completedIds || [],
        failedProviderItemId: batchError?.failedProviderItemId,
        staleProviderItemIds: inventoryDrift?.staleProviderItemIds || [],
        refreshRequired: Boolean(inventoryDrift),
        error: error?.message || "Batch delete failed",
      });
    }
  });

  /** Read-only operator queue combining Organizer and policy/recoverability review. */
  app.get("/api/version-manager/review", async (req, res) => {
    try {
      const provider = configuredMediaManagerProvider(req.query.provider);
      if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
      const requestedStatus = String(req.query.status || "pending");
      const status = requestedStatus === "dismissed" || requestedStatus === "all" ? requestedStatus : "pending";
      const snapshot = readVersionManagerGroups(provider.id);
      if (!snapshot) return res.status(503).json({ ok: false, snapshotAvailable: false, error: "No valid inventory snapshot is available; start a scan" });
      const groups = snapshot.groups;
      const organizerStatus = status === "all" ? undefined : status;
      const providerBasenames = new Set(groups.flatMap((group: any) => group.versions || []).map((version: any) => String(version.fingerprint?.storage?.path || "").split(/[\\/]/).pop()?.toLowerCase()).filter(Boolean));
      const organizers = listOrganizerReviews(true, organizerStatus).filter((entry) => providerBasenames.has(String(entry.sourceBasename || "").toLowerCase()));
      res.json({ ok: true, provider: provider.id, readOnly: true, ...buildUnifiedReviewQueue(groups, organizers, status) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Unified review queue failed" });
    }
  });

  app.post("/api/version-manager/review/:key", (req, res) => {
    const key = String(req.params.key || "");
    if (!/^review_[a-f0-9]{64}$/.test(key)) return res.status(400).json({ ok: false, error: "Invalid review key" });
    if (req.body?.action === "dismiss") {
      setVersionManagerReviewDismissed(key, true);
      return res.json({ ok: true, decision: "dismissed" });
    }
    if (req.body?.action === "restore") {
      setVersionManagerReviewDismissed(key, false);
      return res.json({ ok: true, decision: "pending" });
    }
    return res.status(400).json({ ok: false, error: "action must be dismiss or restore" });
  });

  /**
   * GET /api/version-manager/missing — read-only missing-profile and Seerr
   * status projection. This endpoint never sends an acquisition request.
   */
  app.get("/api/version-manager/missing", async (_req, res) => {
    try {
      const provider = configuredMediaManagerProvider(_req.query.provider);
      if (!provider) return res.status(400).json({ ok: false, error: "Selected debrid provider is not configured" });
      const snapshot = readVersionManagerGroups(provider.id);
      if (!snapshot) return res.status(503).json({ ok: false, snapshotAvailable: false, error: "No valid inventory snapshot is available; start a scan" });
      const versions = snapshot.groups.flatMap((group: any) => group.versions || []);
      const probe = { source: "persisted-snapshot", evaluation: "current-policy" };
      const profiles = getVersionProfiles();
      const policy = getVersionManagerPolicy();
      const groups = evaluateVersionGroups(versions, profiles, policy);
      const needs = profiles.flatMap((profile) => deriveAcquisitionNeeds(groups, [profile], {
        adapterId: "seerr",
        acquisitionEnabled: profile.target === "DIRECT_PLAY" ? policy.acquireMissingRemote : false,
      }));
      const adapter = new SeerrAcquisitionAdapter();
      const previews = await Promise.all(needs.map(async (need) => {
        const preview = await adapter.preview(need);
        recordAcquisitionAudit({ needId: need.id, identity: need.contentIdentity, profileId: need.missingProfileId, adapterId: preview.adapterId, phase: "PREVIEW", status: preview.status, providerRequestId: preview.providerRequestId, detail: [preview.providerStatusSource, preview.mappingWarning].filter(Boolean).join("; ") });
        return preview;
      }));
      return res.json({ ok: true, provider: provider.id, readOnly: true, mode: "dry-run", snapshotId: snapshot.snapshotId, snapshotCreatedAt: snapshot.snapshotCreatedAt, inventoryCount: versions.length, groupCount: groups.length, probe, needs, previews, adapter: await adapter.capabilities() });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Missing profile preview failed" });
    }
  });

  /** Read-only provider-inventory export for backup/migration. */
  app.get("/api/version-manager/export", async (req, res) => {
    try {
      const mode = normalizeMigrationExportMode(String(req.query.mode || "FULL_LIBRARY"));
      const sourceId = typeof req.query.provider === "string" ? req.query.provider.trim().toLowerCase() : undefined;
      const source = sourceId ? registry.get(sourceId) : undefined;
      if (sourceId && !source) return res.status(400).json({ ok: false, error: "Unknown source provider" });
      if (sourceId && !source!.isConfigured()) return res.status(503).json({ ok: false, error: "Source provider is not configured" });
      const inventory = source
        ? await source.listTorrents()
        : (await Promise.all(registry.configured().map((provider) => provider.listTorrents()))).flat();
      if (source) {
        const recoverabilityCache = new Map<string, RecoverabilityEvidence>();
        for (const item of inventory) await resolveProviderItemRecoverability(item, source, recoverabilityCache);
      }
      const selectedProviderItemIds = typeof req.query.selected === "string" ? req.query.selected.split(",").map((value) => value.trim()).filter(Boolean) : undefined;
      const selectedInventory = selectedProviderItemIds ? inventory.filter((item) => selectedProviderItemIds.includes(String(item.id))) : inventory;
      const exportInventory = source?.getTorrentFileTree
        ? await Promise.all(selectedInventory.map(async (item) => ({ ...item, files: await source.getTorrentFileTree!(item.id) })))
        : selectedInventory;
      const exported = exportMigrationLibrary(exportInventory, [], { mode, selectedProviderItemIds, sourceProvider: source?.id });
      if (String(req.query.format || "preview") === "preview") {
        return res.json({ ok: true, readOnly: true, mode, providerItems: inventory.length, exportableItems: exported.manifest.exportableItemCount, magnetCount: exported.manifest.magnetCount, generatedAt: exported.manifest.generatedAt });
      }
      if (String(req.query.format) === "magnets") {
        res.type("text/plain").set("Content-Disposition", `attachment; filename=debrid-magnets.txt`).send(exported.magnetsText);
        return;
      }
      res.type("application/json").set("Content-Disposition", `attachment; filename=debrid-migration-manifest.json`).send(JSON.stringify(exported.manifest, null, 2));
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Migration export failed" });
    }
  });

  /** Read-only magnet backup snapshots. These contain provider references, never media bytes. */
  app.get("/api/version-manager/magnet-backup", (req, res) => {
    res.json({ ok: true, readOnly: true, storageDirectory: magnetBackupDirectory(), schedule: getMagnetBackupSchedule(), backups: listMagnetBackups(typeof req.query.provider === "string" ? req.query.provider : undefined) });
  });
  app.put("/api/version-manager/magnet-backup", (req, res) => {
    try { return res.json({ ok: true, schedule: saveMagnetBackupSchedule(req.body || {}) }); }
    catch (error: any) { return res.status(400).json({ ok: false, error: error?.message || "Invalid backup schedule" }); }
  });
  app.post("/api/version-manager/magnet-backup", async (req, res) => {
    try {
      const provider = typeof req.body?.provider === "string" ? req.body.provider.trim().toLowerCase() : "";
      const mode = req.body?.mode === "INCREMENTAL" ? "INCREMENTAL" : "FULL";
      if (!provider) return res.status(400).json({ ok: false, error: "A source provider is required" });
      const record = await createMagnetBackup(provider, mode);
      res.status(201).json({ ok: true, readOnly: true, record });
    } catch (error: any) { res.status(503).json({ ok: false, error: error?.message || "Magnet backup failed" }); }
  });
  app.get("/api/version-manager/magnet-backup/:id", (req, res) => {
    const document = readMagnetBackup(String(req.params.id));
    if (!document) return res.status(404).json({ ok: false, error: "Magnet backup not found" });
    return res.json({ ok: true, readOnly: true, integrity: verifyMagnetBackup(String(req.params.id)), document });
  });
  app.delete("/api/version-manager/magnet-backup/:id", (req, res) => {
    try { return res.json({ ok: true, deleted: deleteMagnetBackup(String(req.params.id)) }); }
    catch (error: any) { return res.status(error?.message === "Backup not found" ? 404 : 409).json({ ok: false, error: error?.message || "Backup could not be deleted" }); }
  });

  /**
   * Read-only effective migration state. Provider inventory alone cannot
   * remember permanent outcomes such as Real-Debrid legal rejections, so the
   * UI reconciles the current plan with the migration audit trail here.
   */
  app.get("/api/version-manager/migration/state", async (req, res) => {
    try {
      const sourceId = typeof req.query.source === "string" ? req.query.source.trim().toLowerCase() : "alldebrid";
      const targetId = typeof req.query.target === "string" ? req.query.target.trim().toLowerCase() : "realdebrid";
      const source = registry.get(sourceId);
      const target = registry.get(targetId);
      if (!source || !source.isConfigured()) return res.status(503).json({ ok: false, error: "Source provider is not configured" });
      if (!target || !target.isConfigured()) return res.status(503).json({ ok: false, error: "Target provider is not configured" });
      const routeCapabilities = migrationRouteLevel(providerMigrationCapabilities(source), providerMigrationCapabilities(target));
      if (!routeCapabilities.supported) return res.status(422).json({ ok: false, error: "Migration route is not supported by the declared provider capabilities", route: routeCapabilities });
      const [sourceInventory, targetInventory] = await Promise.all([source.listTorrents(), target.listTorrents()]);
      const exportInventory = source.getTorrentFileTree
        ? await Promise.all(sourceInventory.map(async (item) => ({ ...item, files: await source.getTorrentFileTree!(item.id) })))
        : sourceInventory;
      const exported = exportMigrationLibrary(exportInventory, [], { mode: "FULL_LIBRARY", sourceProvider: source.id });
      const rawPlan = analyzeMigrationImport({ manifest: exported.manifest }, targetInventory);
      const audit = listMigrationAudit(10000).filter((entry) => entry.sourceProvider === source.id && entry.targetProvider === target.id);
      const latest = new Map<string, typeof audit[number]>();
      for (const entry of audit) if (!latest.has(entry.infoHash)) latest.set(entry.infoHash, entry);
      const effectiveItems = rawPlan.items.map((item) => {
        const entry = item.infoHash ? latest.get(item.infoHash) : undefined;
        const effective = effectiveMigrationStatus(item.status, entry);
        return { ...item, effectiveStatus: effective.status, reason: effective.reason || item.reason, lastAttempt: effective.lastAttempt, targetProviderItemId: effective.targetProviderItemId };
      });
      const count = (status: string) => effectiveItems.filter((item) => item.effectiveStatus === status).length;
      const importedHistory = new Set(audit.filter((entry) => entry.executionStatus === "IMPORTED").map((entry) => entry.infoHash)).size;
      const alreadyPresent = count("ALREADY_PRESENT") + count("ALREADY_PRESENT_EQUIVALENT_HASH") + count("IMPORTED");
      const jobs = aggregateMigrationJobs(audit.map((entry) => ({ id: entry.id, sourceProvider: entry.sourceProvider, targetProvider: entry.targetProvider, infoHash: entry.infoHash, executionStatus: entry.executionStatus, reason: entry.reason, createdAt: entry.createdAt })));
      const effectiveByProviderItemId = Object.fromEntries(effectiveItems
        .filter((item) => item.providerItemId)
        .map((item) => [String(item.providerItemId), item.effectiveStatus]));
      res.json({
        ok: true, readOnly: true, sourceProvider: source.id, targetProvider: target.id,
        generatedAt: new Date().toISOString(), sourceItems: sourceInventory.length, targetItems: targetInventory.length,
        raw: { ...rawPlan.counts },
        effective: { alreadyPresent, importedHistory, readyToImport: count("READY_TO_IMPORT"), rejectedLegal: count("REJECTED_LEGAL"), failedPermanent: count("FAILED_PERMANENT"), retryExhausted: count("RETRY_EXHAUSTED"), residualTentableReady: count("READY_TO_IMPORT") },
        effectiveByProviderItemId,
        jobs,
        items: effectiveItems.map((item) => ({ ...item, infoHash: item.infoHash ? `${item.infoHash.slice(0, 8)}…${item.infoHash.slice(-6)}` : undefined })),
        audit: audit.slice(0, 250).map((entry) => ({ ...entry, infoHash: `${entry.infoHash.slice(0, 8)}…${entry.infoHash.slice(-6)}` })),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Migration state unavailable" });
    }
  });

  /** Declared provider migration capabilities and derived source/target routes. */
  app.get("/api/version-manager/migration/capabilities", (_req, res) => {
    const providers = registry.all().map(providerMigrationCapabilities);
    const routes = providers.flatMap((source) => providers.map((target) => {
      const route = migrationRouteLevel(source, target);
      return { sourceProvider: source.providerId, targetProvider: target.providerId, ...route };
    }));
    res.json({ ok: true, readOnly: true, providers, routes });
  });

  /** Read-only import analysis. It never calls addMagnet or any provider mutation API. */
  app.post("/api/version-manager/import/preview", async (req, res) => {
    try {
      const body = req.body || {};
      const targetId = typeof body.targetProvider === "string" ? body.targetProvider.trim().toLowerCase() : undefined;
      const target = targetId ? registry.get(targetId) : undefined;
      if (targetId && !target) return res.status(400).json({ ok: false, error: "Unknown target provider" });
      if (targetId && !target!.isConfigured()) return res.status(503).json({ ok: false, error: "Target provider is not configured" });
      if (target) {
        const targetCapabilities = providerMigrationCapabilities(target);
        const importCapability = targetCapabilities.capabilities.find((item) => item.capability === "importMagnet");
        if (!importCapability || importCapability.support === "UNSUPPORTED" || importCapability.support === "UNKNOWN") {
          return res.status(422).json({ ok: false, error: "Target provider does not declare a usable magnet import capability", capability: importCapability });
        }
      }
      const inventory = target
        ? await target.listTorrents()
        : (await Promise.all(registry.configured().map((provider) => provider.listTorrents()))).flat();
      const plan = analyzeMigrationImport({ manifest: body.manifest, magnetsText: typeof body.magnetsText === "string" ? body.magnetsText : undefined }, inventory);
      res.json({ ok: true, targetProvider: target?.id || "configured-providers", ...plan });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message || "Migration import preview failed" });
    }
  });

  /** Starts the existing migration executor as a persistent asynchronous job. */
  app.post("/api/version-manager/migration/jobs", (req, res) => {
    try {
      if (req.body?.confirm !== "START_MIGRATION") return res.status(400).json({ ok: false, error: "Explicit START_MIGRATION confirmation is required" });
      const source = String(req.body?.sourceProvider || "").trim().toLowerCase();
      const target = String(req.body?.targetProvider || "").trim().toLowerCase();
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!source || !target) return res.status(400).json({ ok: false, error: "Source and target providers are required" });
      const job = startMigrationJob(source, target, items);
      return res.status(202).json({ ok: true, readOnly: false, job, statusUrl: `/api/version-manager/migration/jobs/${encodeURIComponent(job.id)}` });
    } catch (error: any) { return res.status(503).json({ ok: false, error: error?.message || "Unable to start migration" }); }
  });
  app.get("/api/version-manager/migration/jobs", (_req, res) => res.json({ ok: true, readOnly: true, jobs: listMigrationJobs() }));
  app.get("/api/version-manager/migration/jobs/:id", (req, res) => {
    const job = getMigrationJob(String(req.params.id));
    return job ? res.json({ ok: true, readOnly: true, job }) : res.status(404).json({ ok: false, error: "Migration job not found" });
  });

  /** Explicit one-item migration execution; no bulk or UI execution path. */
  app.post("/api/version-manager/import/execute", async (req, res) => {
    try {
      if (req.body?.confirm !== "IMPORT_ONE") return res.status(400).json({ ok: false, error: "Explicit IMPORT_ONE confirmation is required" });
      const targetId = typeof req.body?.targetProvider === "string" ? req.body.targetProvider.trim().toLowerCase() : "";
      const target = registry.get(targetId);
      if (!target) return res.status(400).json({ ok: false, error: "Unknown target provider" });
      if (!target.isConfigured()) return res.status(503).json({ ok: false, error: "Target provider is not configured" });
      const sourceItem = req.body?.manifestItem;
      const recoverable = getRecoverableManifestItem(sourceItem);
      if (!recoverable) return res.status(400).json({ ok: false, error: "Manifest item is not recoverable" });
      const before = analyzeMigrationImport({ manifest: { schemaVersion: "1.0", items: [sourceItem] } }, await target.listTorrents());
      const initial = before.items[0];
      if (!initial || initial.status !== "READY_TO_IMPORT") return res.status(409).json({ ok: false, error: "Revalidation blocked the import", plan: before });
      const result = await executeMigrationImportItem(sourceItem, target);
      const after = analyzeMigrationImport({ manifest: { schemaVersion: "1.0", items: [sourceItem] } }, await target.listTorrents());
      const sourceProvider = String(sourceItem?.provider || req.body?.sourceProvider || "unknown");
      const auditOutcome = migrationAuditOutcome(after.items[0]?.status || "ALREADY_PRESENT_EQUIVALENT_HASH", result.providerItemId);
      recordMigrationAudit({ sourceProvider, targetProvider: target.id, sourceProviderItemId: String(sourceItem?.providerItemId || ""), infoHash: recoverable.infoHash, initialStatus: initial.status, revalidationStatus: auditOutcome.reconciliationStatus, executionStatus: auditOutcome.executionStatus, targetProviderItemId: auditOutcome.targetProviderItemId, importExecuted: auditOutcome.importExecuted });
      res.json({ ok: true, readOnly: false, sourceProvider, targetProvider: target.id, result, postImportPlan: after });
    } catch (err: any) {
      res.status(502).json({ ok: false, error: err?.message || "Migration execution failed" });
    }
  });

  /** Explicit full-import executor. The caller must opt into the complete current READY plan. */
  app.post("/api/version-manager/import/execute-bulk", async (req, res) => {
    try {
      if (req.body?.confirm !== "IMPORT_ALL_READY") return res.status(400).json({ ok: false, error: "Explicit IMPORT_ALL_READY confirmation is required" });
      const source = registry.get("alldebrid");
      const target = registry.get("realdebrid");
      if (!source || !source.isConfigured()) return res.status(503).json({ ok: false, error: "AllDebrid source provider is unavailable" });
      if (!target || !target.isConfigured()) return res.status(503).json({ ok: false, error: "Real-Debrid target provider is unavailable" });
      const sourceInventory = await source.listTorrents();
      const exported = exportMigrationLibrary(sourceInventory, [], { mode: "FULL_LIBRARY", sourceProvider: source.id });
      const initialTargetInventory = await target.listTorrents();
      const initialPlan = analyzeMigrationImport({ manifest: exported.manifest }, initialTargetInventory);
      const skipLegal = new Set(Array.isArray(req.body?.skipLegalInfoHashes) ? req.body.skipLegalInfoHashes.map((value: unknown) => String(value).toLowerCase()) : []);
      const knownRejectedLegal = initialPlan.items.filter((item) => item.status === "READY_TO_IMPORT" && item.infoHash && skipLegal.has(item.infoHash.toLowerCase()));
      const ready = initialPlan.items.filter((item) => item.status === "READY_TO_IMPORT" && (!item.infoHash || !skipLegal.has(item.infoHash.toLowerCase())));
      console.log(`[${new Date().toISOString()}][migration-bulk] start total=${ready.length} sourceItems=${sourceInventory.length} targetItems=${initialTargetInventory.length}`);
      const execution = await executeMigrationImportBulk(ready, target, {
        targetInventory: () => target.listTorrents(),
        onProgress: (progress) => console.log(`[${new Date().toISOString()}][migration-bulk] progress`, { ...progress, etaMs: progress.processed > 0 ? Math.round((progress.elapsedMs / progress.processed) * progress.remaining) : undefined }),
      });
      const finalTargetInventory = await target.listTorrents();
      const finalPlan = analyzeMigrationImport({ manifest: exported.manifest }, finalTargetInventory);
      for (const item of execution.results) {
        if (!item.infoHash) continue;
        recordMigrationAudit({ sourceProvider: source.id, targetProvider: target.id, infoHash: item.infoHash, initialStatus: "READY_TO_IMPORT", revalidationStatus: item.status === "SKIPPED_ALREADY_PRESENT" ? "ALREADY_PRESENT" : "READY_TO_IMPORT", executionStatus: item.status, targetProviderItemId: item.providerItemId, reason: item.reason, retryCount: item.retryCount, importExecuted: item.importExecuted });
      }
      for (const item of knownRejectedLegal) {
        recordMigrationAudit({ sourceProvider: source.id, targetProvider: target.id, infoHash: item.infoHash!, initialStatus: "READY_TO_IMPORT", revalidationStatus: "REJECTED_LEGAL", executionStatus: "REJECTED_LEGAL", reason: "LEGAL_RESTRICTION (previously recorded)", retryCount: 0, importExecuted: true });
      }
      return res.json({ ok: true, readOnly: false, sourceProvider: source.id, targetProvider: target.id, initial: { providerItems: sourceInventory.length, targetItems: initialTargetInventory.length, plan: initialPlan.counts }, knownRejectedLegal: knownRejectedLegal.length, execution, final: { targetItems: finalTargetInventory.length, plan: finalPlan.counts, residualTentableReady: Math.max(0, finalPlan.counts.READY_TO_IMPORT - knownRejectedLegal.length) } });
    } catch (err: any) {
      return res.status(502).json({ ok: false, error: err?.message || "Migration bulk execution failed" });
    }
  });

  /** Explicit single Seerr request. Bulk acquisition has no route. */
  app.post("/api/version-manager/acquisition/request", async (req, res) => {
    try {
      if (req.body?.confirm !== "REQUEST_ONE") return res.status(400).json({ ok: false, error: "Explicit REQUEST_ONE confirmation is required" });
      if (!config.acquisitionRequestsEnabled) return res.status(403).json({ ok: false, error: "Acquisition requests are disabled" });
      const need = req.body?.need;
      if (!need || typeof need !== "object") return res.status(400).json({ ok: false, error: "A single acquisition need is required" });
      const adapter = new SeerrAcquisitionAdapter();
      recordAcquisitionAudit({ needId: String(need.id || "unknown"), identity: need.contentIdentity, profileId: String(need.missingProfileId || ""), adapterId: "seerr", phase: "REVALIDATION", status: "REVALIDATED", detail: "Immediate status check performed by adapter" });
      const result = await adapter.request(need);
      recordAcquisitionAudit({ needId: String(need.id || "unknown"), identity: need.contentIdentity, profileId: String(need.missingProfileId || ""), adapterId: "seerr", phase: "REQUEST", status: result.status, providerRequestId: result.providerRequestId, detail: result.detail });
      return res.json({ ok: true, requestExecuted: true, result });
    } catch (err: any) {
      const need = req.body?.need;
      if (need && typeof need === "object") recordAcquisitionAudit({ needId: String(need.id || "unknown"), identity: need.contentIdentity, profileId: String(need.missingProfileId || ""), adapterId: "seerr", phase: "REQUEST", status: "FAILED", detail: err?.message || "Seerr request failed" });
      return res.status(502).json({ ok: false, requestExecuted: false, error: err?.message || "Seerr request failed" });
    }
  });

  app.put("/api/version-manager/profiles", (req, res) => {
    try {
      if (!Array.isArray(req.body?.profiles) || req.body.profiles.length === 0) return res.status(400).json({ ok: false, error: "profiles must be a non-empty array" });
      const profiles = req.body.profiles.map((profile: any) => ({ ...profile, hardRequirements: profile.hardRequirements ? validateRule(profile.hardRequirements) : undefined, scoringRules: profile.scoringRules ? validateScoringRules(profile.scoringRules) : undefined }));
      const policy: ReturnType<typeof getVersionManagerPolicy> = {
        acquisitionMode: req.body.policy?.acquisitionMode === "NATIVE" ? "NATIVE" : "ARR",
        enableRemote: req.body.policy?.enableRemote === true,
        acquireMissingRemote: req.body.policy?.acquireMissingRemote === true,
        preferCompletePack: req.body.policy?.preferCompletePack === true,
        useArrIdentityResolution: req.body.policy?.useArrIdentityResolution === true,
        policyVersion: typeof req.body.policy?.policyVersion === "string" ? req.body.policy.policyVersion : "1",
        safety: {
          deleteDryRun: req.body.policy?.safety?.deleteDryRun !== false,
          requireRecoverableBeforeDelete: req.body.policy?.safety?.requireRecoverableBeforeDelete !== false,
          allowDeleteWhenIdentityUncertain: req.body.policy?.safety?.allowDeleteWhenIdentityUncertain === true,
          allowDeleteWhenMetadataIncomplete: req.body.policy?.safety?.allowDeleteWhenMetadataIncomplete === true,
        },
      };
      saveVersionProfiles(profiles);
      saveVersionManagerPolicy(policy);
      res.json({ ok: true, profiles: getVersionProfiles(), policy });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message || "Invalid profiles" });
    }
  });

  // ===========================================================================
  // Infringement List (Blacklist) API
  // ===========================================================================

  /** GET /api/infringement-list — Returns all blacklisted torrent entries. */
  app.get('/api/infringement-list', (_req, res) => {
    const entries = getBlacklistEntries().map((e, i) => ({
      id: String(i),
      pattern: e.name,
      blockedBy: e.provider,
      reason: e.reason,
      matchType: 'contains',
      createdAt: e.blacklistedAt,
    }));
    res.json({ ok: true, entries });
  });

  // ===========================================================================
  // Organizer Review API
  // ===========================================================================

  /** GET /api/organizer/review — Lists pending identity decisions. */
  app.get('/api/organizer/review', (req, res) => {
    const includeResolved = String(req.query.includeResolved || '') === 'true';
    const status = req.query.status === 'pending' || req.query.status === 'accepted' || req.query.status === 'dismissed'
      ? req.query.status : undefined;
    const parserStatus = req.query.parserStatus === 'matched' || req.query.parserStatus === 'ambiguous' || req.query.parserStatus === 'unmatched'
      ? req.query.parserStatus : undefined;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const all = filterOrganizerReviewsByParserStatus(listOrganizerReviews(includeResolved, status), parserStatus);
    res.json({ ok: true, entries: all.slice(offset, offset + limit), total: all.length, limit, offset });
  });

  /** GET /api/organizer/review/:id — Returns one review entry. */
  app.get('/api/organizer/review/:id', (req, res) => {
    const entry = listOrganizerReviews(true).find((item) => item.id === String(req.params.id));
    if (!entry) return res.status(404).json({ ok: false, error: 'Review entry not found' });
    res.json({ ok: true, entry });
  });

  /** POST /api/organizer/review/:id — Records a manual review decision or safe retry. */
  app.post('/api/organizer/review/:id', (req, res) => {
    if (req.body?.action === 'clear-match') {
      const entry = clearOrganizerReviewOverride(String(req.params.id));
      if (!entry) return res.status(404).json({ ok: false, error: 'Review entry not found' });
      return res.json({ ok: true, entry });
    }
    if (req.body?.action === 'retry') {
      const entry = retryOrganizerReview(String(req.params.id));
      if (!entry) return res.status(404).json({ ok: false, error: 'Review entry not found' });
      return res.json({ ok: true, entry });
    }
    const decision = req.body?.decision;
    if (decision !== 'accepted' && decision !== 'dismissed') {
      return res.status(400).json({ ok: false, error: 'decision must be accepted or dismissed' });
    }
    let override;
    try { override = validateReviewOverride(req.body?.override); }
    catch (err: any) { return res.status(400).json({ ok: false, error: err?.message || 'Invalid override' }); }
    const entry = decideOrganizerReview(String(req.params.id), decision, override);
    if (!entry) return res.status(404).json({ ok: false, error: 'Review entry not found' });
    res.json({ ok: true, entry });
  });

  /** GET /api/organizer/review/:id/audit — Returns the decision history. */
  app.get('/api/organizer/review/:id/audit', (req, res) => {
    res.json({ ok: true, audit: listOrganizerReviewAudit(String(req.params.id)) });
  });

  // Persists a canonical manual identity for Content Detail records that do
  // not have an Organizer Review, then reevaluates the latest cached scan.
  // This is deliberately cache-only: it never starts a provider rescan.
  app.post('/api/version-manager/identity/override', (req, res) => {
    const provider = configuredMediaManagerProvider(req.body?.provider);
    if (!provider) return res.status(400).json({ ok: false, error: 'Selected debrid provider is not configured' });
    const requestedGroupId = typeof req.body?.versionGroupId === 'string' ? req.body.versionGroupId : undefined;
    const requestedVersionIds = Array.isArray(req.body?.versionIds)
      ? req.body.versionIds.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    const snapshot = requestedGroupId || requestedVersionIds.length ? readVersionManagerGroups(provider.id) : null;
    const requestedGroup = requestedGroupId ? snapshot?.groups.find((group) => group.id === requestedGroupId) : undefined;
    if (requestedGroupId && !requestedGroup) return res.status(404).json({ ok: false, error: 'Version group is no longer available; refresh Review' });
    const snapshotVersionIds = new Set((snapshot?.groups || []).flatMap((group) => group.versions.map((version: VersionRecord) => version.id)));
    if (requestedVersionIds.some((versionId: string) => !snapshotVersionIds.has(versionId))) return res.status(409).json({ ok: false, error: 'One or more review versions are no longer available; refresh Review' });
    const identity = requestedGroup?.identity || req.body?.identity;
    if (!identity || typeof identity !== 'object') return res.status(400).json({ ok: false, error: 'identity or versionGroupId is required' });
    const identityValue = {
      title: typeof identity.title === 'string' ? identity.title : undefined,
      year: typeof identity.year === 'number' ? identity.year : undefined,
      kind: identity.kind === 'episode' || identity.mediaType === 'tv' ? 'episode' : identity.kind === 'movie' || identity.mediaType === 'movie' ? 'movie' : undefined,
      season: typeof identity.season === 'number' ? identity.season : undefined,
      episode: typeof identity.episode === 'number' ? identity.episode : undefined,
      tmdbId: typeof identity.tmdbId === 'string' ? identity.tmdbId : undefined,
    } as const;
    let override: ManualIdentityOverride | undefined;
    try { override = validateReviewOverride(req.body?.override) as ManualIdentityOverride | undefined; }
    catch (err: any) { return res.status(400).json({ ok: false, error: err?.message || 'Invalid manual identity' }); }
    const targetVersionIds = requestedVersionIds.length
      ? requestedVersionIds
      : requestedGroup?.versions.map((version: VersionRecord) => version.id) || [];
    if (req.body?.action === 'clear') {
      if (targetVersionIds.length) targetVersionIds.forEach(clearManualIdentityOverrideForVersion);
      else clearManualIdentityOverride(identityValue);
    } else {
      if (!override) return res.status(400).json({ ok: false, error: 'override is required' });
      if (targetVersionIds.length) targetVersionIds.forEach((versionId: string) => saveManualIdentityOverrideForVersion(versionId, override!));
      else saveManualIdentityOverride(identityValue, override);
    }
    const records = applyManualIdentityOverrides(getLatestVersionManagerRecords(provider.id));
    const groups = evaluateVersionGroups(records, getVersionProfiles(), getVersionManagerPolicy());
    const key = identityOverrideKey(identityValue);
    const targetIds = new Set(targetVersionIds);
    const affectedGroups = groups.filter((group) =>
      targetIds.size
        ? group.versions.some((version) => targetIds.has(version.id))
        : identityOverrideKey(group.identity) === key || Boolean(override?.tmdbId && group.identity.tmdbId === override.tmdbId),
    );
    res.json({ ok: true, identity: affectedGroups[0]?.identity || identityValue, groups: affectedGroups, reevaluated: records.length > 0, readOnlyEvaluation: true });
  });

  // Read-only TMDb candidate search used by the Media Manager identity picker.
  app.get('/api/version-manager/identity/search', async (req, res) => {
    const query = String(req.query.query || '').trim();
    const mediaType = req.query.type === 'tv' ? 'tv' : req.query.type === 'movie' ? 'movie' : undefined;
    const yearValue = req.query.year === undefined || req.query.year === '' ? undefined : Number(req.query.year);
    if (!query || query.length > 200) return res.status(400).json({ ok: false, error: 'query is required and must be at most 200 characters' });
    if (!mediaType) return res.status(400).json({ ok: false, error: 'type must be movie or tv' });
    if (yearValue !== undefined && (!Number.isInteger(yearValue) || yearValue < 1800 || yearValue > 2200)) return res.status(400).json({ ok: false, error: 'year is invalid' });
    try {
      const results = await searchTmdbCandidates(query, mediaType, yearValue);
      res.json({ ok: true, query, mediaType, year: yearValue, results });
    } catch (error: any) {
      res.status(502).json({ ok: false, error: error?.message || 'TMDb search failed' });
    }
  });

  /** GET /api/infringement-list/check — Checks if a name matches the blacklist. */
  app.get('/api/infringement-list/check', (req, res) => {
    const name = String(req.query.name || '');
    if (!name) {
      return res.status(400).json({ ok: false, error: 'Missing "name" query parameter' });
    }
    res.json({ ok: true, blocked: isBlacklisted(name), name });
  });

  /** POST /api/infringement-list — Adds a new entry to the blacklist. */
  app.post('/api/infringement-list', (req, res) => {
    const { pattern, blockedBy, reason, matchType } = req.body || {};
    if (!pattern) {
      return res.status(400).json({ ok: false, error: 'Missing "pattern" field' });
    }
    addToBlacklist(pattern, reason || 'Manual addition', blockedBy || 'manual');
    const entries = getBlacklistEntries();
    const added = entries[entries.length - 1];
    const id = String(entries.length - 1);
    res.status(201).json({
      ok: true,
      entry: {
        id,
        pattern: added.name,
        blockedBy: added.provider,
        reason: added.reason,
        matchType: matchType || 'contains',
        createdAt: added.blacklistedAt,
      },
    });
  });

  /** DELETE /api/infringement-list/:id — Removes a blacklist entry by index ID. */
  app.delete('/api/infringement-list/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const entries = getBlacklistEntries();
    if (isNaN(id) || id < 0 || id >= entries.length) {
      return res.status(404).json({ ok: false, error: 'Entry not found' });
    }
    const entry = entries[id];
    const removed = removeFromBlacklist(entry.name);
    if (removed) {
      res.json({ ok: true, message: `Removed "${entry.name}" from blacklist` });
    } else {
      res.status(404).json({ ok: false, error: 'Entry not found' });
    }
  });

  // ===========================================================================
  // Rate Limit Status
  // ===========================================================================

  /** GET /api/rate-limits — Returns current rate limit state and learnt thresholds per provider. */
  app.get('/api/rate-limits', (_req, res) => {
    const current = rateLimiter.getStatus();
    // Build learnt thresholds from the rate limiter's configuration
    const learned: Record<string, { minDelayMs: number }> = {};
    for (const provider of Object.keys(current)) {
      learned[provider] = { minDelayMs: 0 }; // Actual learnt values would come from DB
    }
    res.json({ ok: true, learned, current });
  });

  /**
   * GET /api/tokens — Returns the status of all download token pools per provider.
   * Shows active/limited counts, masked token identifiers, and remaining cooldown.
   */
  app.get('/api/tokens', (_req, res) => {
    const status = tokenRotator.getAllStatus();
    // Mask token values in the response for security
    const masked: Record<string, any> = {};
    for (const [provider, summary] of Object.entries(status)) {
      masked[provider] = {
        ...summary,
        downloadTokens: summary.downloadTokens.map((t) => ({
          ...t,
          token: t.token.length > 4 ? `***${t.token.slice(-4)}` : '****',
          limitedUntil: t.isLimited ? t.limitedUntil : 0,
          remainingSeconds: t.isLimited ? Math.max(0, Math.ceil((t.limitedUntil - Date.now()) / 1000)) : 0,
        })),
      };
    }
    res.json({ ok: true, tokens: masked });
  });

  /**
   * POST /api/tokens/reset — Manually resets all download token limits.
   * Useful for forcing a reset without waiting for the daily cron.
   */
  app.post('/api/tokens/reset', (_req, res) => {
    tokenRotator.resetAllTokens();
    res.json({ ok: true, message: 'All token limits cleared' });
  });

  // ===========================================================================
  // WebDAV Bridge Management
  // ===========================================================================

  /** GET /api/webdav/status — Returns status of all active WebDAV bridge instances. */
  app.get("/api/webdav/status", (_req, res) => {
    res.json({ ok: true, bridges: getBridgeStatuses() });
  });

  /** POST /api/webdav/refresh — Forces a cache refresh on all active bridges. */
  app.post("/api/webdav/refresh", async (_req, res) => {
    try {
      await refreshBridges();
      res.json({ ok: true, message: "Cache refreshed", bridges: getBridgeStatuses() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // ===========================================================================
  // Provider Status
  // ===========================================================================

  /**
   * GET /api/providers — Returns connectivity and configuration status
   * for all active debrid providers (TorBox, Real-Debrid).
   * Attempts a live torrent list fetch to verify connectivity.
   */
  app.get("/api/providers", async (_req, res) => {
    try {
      const providers: any[] = [];

      // Check all registered providers (configured or not)
      for (const p of registry.all()) {
        if (p.isConfigured()) {
          try {
            const torrents = await p.listTorrents();
            const webdavConfig = p.getWebDAVConfig();
            providers.push({
              name: p.displayName,
              id: p.id,
              configured: true,
              connected: true,
              torrentCount: torrents.length,
              webdav: {
                configured: p.hasDirectWebDAV(),
                url: webdavConfig?.url || null,
              },
            });
          } catch (err: any) {
            const webdavConfig = p.getWebDAVConfig();
            providers.push({
              name: p.displayName,
              id: p.id,
              configured: true,
              connected: false,
              error: err.message,
              webdav: {
                configured: p.hasDirectWebDAV(),
                url: webdavConfig?.url || null,
              },
            });
          }
        } else {
          providers.push({
            name: p.displayName,
            id: p.id,
            configured: false,
            connected: false,
            webdav: { configured: false, url: null },
          });
        }
      }

      res.json({ ok: true, providers });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message, providers: [] });
    }
  });

  // ===========================================================================
  // Torrents API
  // ===========================================================================

  /**
   * GET /api/torrents — Returns a combined, sorted list of torrents from
   * all active providers. Each torrent is normalised to a consistent shape.
   */
  app.get("/api/torrents", async (_req, res) => {
    try {
      const allTorrents: any[] = [];

      for (const provider of registry.configured()) {
        try {
          const torrents = await provider.listTorrents();
          for (const t of torrents) {
            allTorrents.push({
              id: t.id,
              name: t.name,
              status: t.status || "unknown",
              progress: typeof t.progress === "number" ? t.progress : 0,
              size: t.bytes || 0,
              provider: provider.id,
              addedAt: t.addedAt || t.raw?.created_at || t.raw?.added,
              downloadSpeed: t.raw?.download_speed || t.raw?.speed || 0,
              uploadSpeed: t.raw?.upload_speed || 0,
              seeds: t.raw?.seeds || t.raw?.seeders || 0,
              peers: t.raw?.peers || 0,
            });
          }
        } catch (err: any) {
          console.error(`[api/torrents] ${provider.id} error:`, err.message);
        }
      }

      // Sort by added date descending (newest first)
      allTorrents.sort((a, b) => {
        const dateA = new Date(a.addedAt || 0).getTime();
        const dateB = new Date(b.addedAt || 0).getTime();
        return dateB - dateA;
      });

      res.json({ ok: true, torrents: allTorrents });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message, torrents: [] });
    }
  });

  // ===========================================================================
  // Downloads API
  // ===========================================================================

  /**
   * GET /api/downloads — Returns a combined, sorted list of downloads from
   * all active providers (RD downloads, TorBox web/usenet downloads).
   */
  app.get("/api/downloads", async (_req, res) => {
    try {
      // Fetch downloads from all providers in parallel for speed
      const providerResults = await Promise.allSettled(
        registry.configured().map(async (provider) => {
          const downloads: any[] = [];

          // Fetch all download types for this provider in parallel
          const [dlResult, webResult, usenetResult] = await Promise.allSettled([
            // Standard downloads (RealDebrid's unrestricted files)
            provider.listDownloads
              ? provider.listDownloads().catch((err: any) => {
                  console.error(`[api/downloads] ${provider.id} downloads error:`, err.message);
                  return [] as any[];
                })
              : Promise.resolve([] as any[]),
            // Web downloads (TorBox only)
            provider.listWebDownloads
              ? provider.listWebDownloads().catch((err: any) => {
                  console.error(`[api/downloads] ${provider.id} web downloads error:`, err.message);
                  return [] as any[];
                })
              : Promise.resolve([] as any[]),
            // Usenet downloads (TorBox only)
            provider.listUsenetDownloads
              ? provider.listUsenetDownloads().catch((err: any) => {
                  console.error(`[api/downloads] ${provider.id} usenet downloads error:`, err.message);
                  return [] as any[];
                })
              : Promise.resolve([] as any[]),
          ]);

          // Process standard downloads
          const stdDownloads = dlResult.status === 'fulfilled' ? dlResult.value : [];
          for (const d of stdDownloads) {
            downloads.push({
              id: d.id,
              name: d.name,
              type: d.type || "download",
              status: d.status || "downloaded",
              progress: typeof d.progress === "number" ? d.progress : 100,
              size: d.size || 0,
              provider: provider.id,
              addedAt: d.raw?.generated || d.raw?.created_at || d.raw?.added,
              downloadUrl: d.url || d.raw?.download,
              host: d.raw?.host,
              link: d.raw?.link,
              streamable: d.raw?.streamable,
              mimeType: d.raw?.mimeType,
            });
          }

          // Process web downloads
          const webDownloads = webResult.status === 'fulfilled' ? webResult.value : [];
          for (const d of webDownloads) {
            downloads.push({
              id: d.id,
              name: d.name,
              type: "web",
              status: d.status || "unknown",
              progress: typeof d.progress === "number" ? d.progress : 100,
              size: d.size || 0,
              provider: provider.id,
              addedAt: d.raw?.created_at || d.raw?.added,
              downloadSpeed: d.raw?.download_speed || 0,
            });
          }

          // Process usenet downloads
          const usenetDownloads = usenetResult.status === 'fulfilled' ? usenetResult.value : [];
          for (const d of usenetDownloads) {
            downloads.push({
              id: d.id,
              name: d.name,
              type: "usenet",
              status: d.status || "unknown",
              progress: typeof d.progress === "number" ? d.progress : 100,
              size: d.size || 0,
              provider: provider.id,
              addedAt: d.raw?.created_at || d.raw?.added,
              downloadSpeed: d.raw?.download_speed || 0,
            });
          }

          return downloads;
        })
      );

      // Flatten all provider results
      const allDownloads: any[] = [];
      for (const result of providerResults) {
        if (result.status === 'fulfilled') {
          allDownloads.push(...result.value);
        }
      }

      // Sort by added date descending (newest first)
      allDownloads.sort((a, b) => {
        const dateA = new Date(a.addedAt || 0).getTime();
        const dateB = new Date(b.addedAt || 0).getTime();
        return dateB - dateA;
      });

      res.json({ ok: true, downloads: allDownloads });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message, downloads: [] });
    }
  });

  // ===========================================================================
  // SSE Streaming — Torrents
  // ===========================================================================

  /**
   * GET /api/torrents/stream — Server-Sent Events endpoint that streams
   * torrent data page-by-page as it's fetched from providers.
   *
   * Uses in-flight request locking to prevent duplicate concurrent fetches.
   * If another request is already in-flight, returns cached data immediately
   * or waits for the in-flight request to complete.
   *
   * Events emitted: `status`, `torrents`, `error`, `done`.
   */
  app.get("/api/torrents/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    /** Helper to emit a named SSE event with JSON data. */
    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Acquire an exclusive lock to prevent concurrent API requests
    const lockKey = "stream:torrents";
    let gotLock = await rateLimiter.acquireLock(lockKey);
    
    if (!gotLock) {
      // Another request is already in-flight — wait for it to finish
      send("status", { message: "Waiting for data..." });
      gotLock = await rateLimiter.acquireLock(lockKey, true); // wait for lock
    }

    try {
      const configuredProviders = registry.configured();
      send("status", { message: "Fetching torrents...", providers: configuredProviders.map(p => p.id) });
      let totalCount = 0;

      for (const provider of configuredProviders) {
        send("status", { message: `Fetching ${provider.displayName} torrents...` });
        try {
          if (provider.listTorrentsStream) {
            // Stream page-by-page via async generator
            let pageNum = 0;
            for await (const page of provider.listTorrentsStream()) {
              pageNum++;
              const mapped = page.map((t: TorrentInfo) => ({
                id: t.id,
                name: t.name,
                status: t.status || "unknown",
                progress: typeof t.progress === "number" ? t.progress : 0,
                size: t.bytes || 0,
                provider: provider.id,
                addedAt: t.addedAt || t.raw?.created_at || t.raw?.added,
                downloadSpeed: t.raw?.download_speed || t.raw?.speed || 0,
                uploadSpeed: t.raw?.upload_speed || 0,
                seeds: t.raw?.seeds || t.raw?.seeders || 0,
                peers: t.raw?.peers || 0,
              }));
              totalCount += mapped.length;
              send("torrents", { provider: provider.id, torrents: mapped, count: mapped.length, total: totalCount, page: pageNum });
            }
          } else {
            // Fall back to single fetch
            const torrents = await provider.listTorrents();
            const mapped = torrents.map((t: TorrentInfo) => ({
              id: t.id,
              name: t.name,
              status: t.status || "unknown",
              progress: typeof t.progress === "number" ? t.progress : 0,
              size: t.bytes || 0,
              provider: provider.id,
              addedAt: t.addedAt || t.raw?.created_at || t.raw?.added,
              downloadSpeed: t.raw?.download_speed || t.raw?.speed || 0,
              uploadSpeed: t.raw?.upload_speed || 0,
              seeds: t.raw?.seeds || t.raw?.seeders || 0,
              peers: t.raw?.peers || 0,
            }));
            totalCount += mapped.length;
            send("torrents", { provider: provider.id, torrents: mapped, count: mapped.length, total: totalCount });
          }
        } catch (err: any) {
          send("error", { provider: provider.id, error: err.message });
        }
      }

      send("done", { message: "All providers fetched", total: totalCount });
      res.end();
    } catch (err: any) {
      send("error", { error: err.message });
      res.end();
    } finally {
      rateLimiter.releaseLock(lockKey);
    }
  });

  // ===========================================================================
  // SSE Streaming — Downloads
  // ===========================================================================

  /**
   * GET /api/downloads/stream — Server-Sent Events endpoint that streams
   * download data page-by-page as it's fetched from providers.
   *
   * Uses the same in-flight locking pattern as the torrents stream endpoint.
   *
   * Events emitted: `status`, `downloads`, `error`, `done`.
   */
  app.get("/api/downloads/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    /** Helper to emit a named SSE event with JSON data. */
    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Acquire an exclusive lock to prevent concurrent API requests
    const lockKey = "stream:downloads";
    let gotLock = await rateLimiter.acquireLock(lockKey);
    
    if (!gotLock) {
      // Another request is already in-flight — wait for it to finish
      send("status", { message: "Waiting for data..." });
      gotLock = await rateLimiter.acquireLock(lockKey, true); // wait for lock
    }

    try {
      const configuredProviders = registry.configured();
      send("status", { message: "Fetching downloads...", providers: configuredProviders.map(p => p.id) });
      let totalCount = 0;

      for (const provider of configuredProviders) {
        // Standard downloads (stream if available, else single fetch)
        if (provider.listDownloadsStream) {
          send("status", { message: `Fetching ${provider.displayName} downloads...` });
          try {
            let pageNum = 0;
            for await (const page of provider.listDownloadsStream()) {
              pageNum++;
              const mapped = page.map((d: DownloadInfo) => ({
                id: d.id,
                name: d.name,
                type: d.type || "download",
                status: d.status || "downloaded",
                progress: typeof d.progress === "number" ? d.progress : 100,
                size: d.size || 0,
                provider: provider.id,
                addedAt: d.raw?.generated || d.raw?.created_at || d.raw?.added,
                downloadUrl: d.url || d.raw?.download,
                host: d.raw?.host,
                link: d.raw?.link,
                streamable: d.raw?.streamable,
                mimeType: d.raw?.mimeType,
              }));
              totalCount += mapped.length;
              send("downloads", { provider: provider.id, type: "download", downloads: mapped, count: mapped.length, total: totalCount, page: pageNum });
            }
          } catch (err: any) {
            send("error", { provider: provider.id, error: err.message });
          }
        } else if (provider.listDownloads) {
          send("status", { message: `Fetching ${provider.displayName} downloads...` });
          try {
            const downloads = await provider.listDownloads();
            const mapped = downloads.map((d: DownloadInfo) => ({
              id: d.id,
              name: d.name,
              type: d.type || "download",
              status: d.status || "downloaded",
              progress: typeof d.progress === "number" ? d.progress : 100,
              size: d.size || 0,
              provider: provider.id,
              addedAt: d.raw?.generated || d.raw?.created_at || d.raw?.added,
              downloadUrl: d.url || d.raw?.download,
              host: d.raw?.host,
            }));
            totalCount += mapped.length;
            send("downloads", { provider: provider.id, type: "download", downloads: mapped, count: mapped.length, total: totalCount });
          } catch (err: any) {
            send("error", { provider: provider.id, error: err.message });
          }
        }

        // Web downloads
        if (provider.listWebDownloads) {
          send("status", { message: `Fetching ${provider.displayName} web downloads...` });
          try {
            const webDownloads = await provider.listWebDownloads();
            const mapped = webDownloads.map((d: DownloadInfo) => ({
              id: d.id,
              name: d.name,
              type: "web",
              status: d.status || "unknown",
              progress: typeof d.progress === "number" ? d.progress : 100,
              size: d.size || 0,
              provider: provider.id,
              addedAt: d.raw?.created_at || d.raw?.added,
              downloadSpeed: d.raw?.download_speed || 0,
            }));
            totalCount += mapped.length;
            send("downloads", { provider: provider.id, type: "web", downloads: mapped, count: mapped.length, total: totalCount });
          } catch (err: any) {
            send("error", { provider: provider.id, type: "web", error: err.message });
          }
        }

        // Usenet downloads
        if (provider.listUsenetDownloads) {
          send("status", { message: `Fetching ${provider.displayName} usenet downloads...` });
          try {
            const usenetDownloads = await provider.listUsenetDownloads();
            const mapped = usenetDownloads.map((d: DownloadInfo) => ({
              id: d.id,
              name: d.name,
              type: "usenet",
              status: d.status || "unknown",
              progress: typeof d.progress === "number" ? d.progress : 100,
              size: d.size || 0,
              provider: provider.id,
              addedAt: d.raw?.created_at || d.raw?.added,
              downloadSpeed: d.raw?.download_speed || 0,
            }));
            totalCount += mapped.length;
            send("downloads", { provider: provider.id, type: "usenet", downloads: mapped, count: mapped.length, total: totalCount });
          } catch (err: any) {
            send("error", { provider: provider.id, type: "usenet", error: err.message });
          }
        }
      }

      send("done", { message: "All providers fetched", total: totalCount });
      res.end();
    } catch (err: any) {
      send("error", { error: err.message });
      res.end();
    } finally {
      rateLimiter.releaseLock(lockKey);
    }
  });

  // ===========================================================================
  // Search API
  // ===========================================================================

  /**
   * GET /api/search — Searches configured indexers (Jackett/Prowlarr)
   * for torrents matching the given query.
   *
   * Query params:
   * - `q` (required) — The search query string.
   * - `categories` (optional) — Comma-separated category IDs.
   */
  app.get("/api/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim();
      const categories = req.query.categories ? String(req.query.categories).split(",") : undefined;

      if (!query) {
        return res.status(400).json({ ok: false, error: "Missing query parameter 'q'" });
      }

      if (!isIndexerConfigured()) {
        return res.status(503).json({ 
          ok: false, 
          error: "No indexer configured. Set Jackett or Prowlarr in settings.",
          results: [],
        });
      }

      console.log(`[${new Date().toISOString()}][api/search] searching`, { query, categories });
      const results = await searchIndexer(query, { categories });
      
      // Normalise results to a consistent shape regardless of indexer response format
      const mappedResults = results.map((r: any) => ({
        title: r.title || r.Title,
        size: r.size || r.Size || 0,
        seeders: r.seeders || r.Seeders || 0,
        leechers: r.leechers || r.Leechers || 0,
        magnetUrl: r.magnetUrl || r.MagnetUrl || r.downloadUrl || r.DownloadUrl,
        infoHash: r.infoHash || r.InfoHash,
        indexer: r.indexer || r.Indexer || "Unknown",
        publishDate: r.publishDate || r.PublishDate,
        categories: r.categories || r.Categories || [],
      }));

      res.json({ 
        ok: true, 
        results: mappedResults,
        provider: getProviderName(),
        count: mappedResults.length,
      });
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}][api/search] error`, err.message);
      res.status(500).json({ ok: false, error: err.message, results: [] });
    }
  });

  // ===========================================================================
  // Add Magnet API
  // ===========================================================================

  /**
   * POST /api/add — Adds a magnet link to the specified (or default) provider.
   *
   * Request body:
   * - `magnet` (required) — The magnet URI to add.
   * - `name` (optional) — Human-readable name for the torrent.
   * - `provider` (optional) — T    * For Real-Debrid, automatically selects all files after adding.
   */
  app.post("/api/add", async (req, res) => {
    try {
      const { magnet, name, provider: targetProvider } = req.body || {};

      if (!magnet) {
        return res.status(400).json({ ok: false, error: "Missing 'magnet' in request body" });
      }

      // If a specific provider is requested, use it; otherwise use the strategy
      if (targetProvider) {
        const provider = registry.get(targetProvider);
        if (!provider) {
          return res.status(400).json({ ok: false, error: `Unknown provider: ${targetProvider}` });
        }
        if (!provider.isConfigured()) {
          return res.status(503).json({ ok: false, error: `${provider.displayName} not configured` });
        }
        console.log(`[${new Date().toISOString()}][api/add] adding to ${provider.displayName}`, { name });
        const result = await provider.addMagnet(magnet, name);
        res.json({ ok: true, provider: provider.id, result });
      } else {
        // Use configured strategy
        const addStrategy = (config as any).addStrategy || 'all';
        console.log(`[${new Date().toISOString()}][api/add] adding with strategy '${addStrategy}'`, { name });
        const { results } = await registry.addMagnetWithStrategy(magnet, name, addStrategy);
        const anySuccess = results.some(r => r.success);
        if (!anySuccess) {
          return res.status(503).json({ ok: false, error: "Failed to add to any provider", results });
        }
        res.json({ ok: true, results });
      }
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}][api/add] error`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===========================================================================
  // Logs API
  // ===========================================================================

  /**
   * GET /api/logs — Returns recent log entries from the in-memory log buffer.
   *
   * Query params:
   * - `limit` (optional) — Number of entries to return (max 500, default 100).
   * - `level` (optional) — Filter by log level (default "all").
   */
  app.get("/api/logs", (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const level = String(req.query.level || "all");
      const logs = logBuffer.getLogs(limit, level);
      res.json({ ok: true, logs });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message, logs: [] });
    }
  });

  /**
   * GET /api/logs/stream — SSE endpoint for real-time log streaming.
   * Sends initial log batch, then streams new entries as they arrive.
   * Includes a 30-second heartbeat to keep the connection alive.
   */
  app.get("/api/logs/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    // Send initial batch of recent logs
    const initialLogs = logBuffer.getLogs(50);
    res.write(`data: ${JSON.stringify({ type: "initial", logs: initialLogs })}\n\n`);

    // Subscribe to new log entries — callback fires for each new entry
    const unsubscribe = logBuffer.subscribe((entry) => {
      res.write(`data: ${JSON.stringify({ type: "log", log: entry })}\n\n`);
    });

    // Keep connection alive with periodic heartbeat comments
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30000);

    // Cleanup on client disconnect
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /** DELETE /api/logs — Clears the in-memory log buffer. */
  app.delete("/api/logs", (_req, res) => {
    try {
      logBuffer.clear();
      res.json({ ok: true, message: "Logs cleared" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ===========================================================================
  // Overseerr Webhook
  // ===========================================================================

  if (config.runWebhook) {
    /**
     * POST /webhook/overseerr — Receives webhook payloads from Overseerr
     * when new media is requested.
     *
     * Processing flow:
     * 1. Validates indexer and API key configuration
     * 2. Checks optional authorisation header
     * 3. Extracts search query from the webhook payload
     * 4. Responds with HTTP 202 immediately (avoids Overseerr's 20s timeout)
     * 5. Processes asynchronously: searches indexer → picks best result → adds magnet
     */
    app.post("/webhook/overseerr", async (req, res) => {
      try {
        console.log(`[${new Date().toISOString()}][webhook] hit /webhook/overseerr`);
        // Check required environment variables early and return a helpful error
        if (!isIndexerConfigured()) {
          console.warn(`[${new Date().toISOString()}][webhook] no indexer configured`);
          return res.status(503).json({
            ok: false,
            error: "No indexer configured. Set JACKETT_URL/JACKETT_API_KEY or PROWLARR_URL/PROWLARR_API_KEY.",
            documentation: "See README.md for configuration instructions.",
          });
        }
        if (registry.configured().length === 0) {
          console.warn(`[${new Date().toISOString()}][webhook] no debrid providers configured`);
          return res.status(503).json({
            ok: false,
            error: "No debrid providers configured.",
            documentation: "See README.md for configuration instructions.",
          });
        }

        // Optional webhook authorisation check
        if (config.overseerrAuth && req.get("authorization") !== config.overseerrAuth) {
          console.warn(`[${new Date().toISOString()}][webhook] unauthorized request (bad auth header)`);
          return res.status(401).json({ ok: false, error: "Unauthorized" });
        }

        const payload = req.body || {};
        const built = buildQueryFromPayload(payload);

        if (!built || !built.query) {
          console.warn(`[${new Date().toISOString()}][webhook] could not derive query from payload`, { subject: payload?.subject, media: payload?.media });
          return res.status(400).json({ ok: false, error: "No query could be derived from payload." });
        }

        console.log(`[${new Date().toISOString()}][webhook] built query`, { query: built.query, categories: built.categories });
        // Respond immediately to avoid Overseerr's 20s timeout; process in background
        res.status(202).json({ ok: true, accepted: true, query: built.query, categories: built.categories });
        console.log(`[${new Date().toISOString()}][webhook] responded 202, processing async...`);

        // Background async processing — search, select best result, and add magnet
        (async () => {
          try {
            const provider = getProviderName();
            console.log(`[${new Date().toISOString()}][webhook->${provider}] searching`, { query: built.query, categories: built.categories });
            const started = Date.now();
            const results = await searchIndexer(built.query, { categories: built.categories });
            console.log(`[${new Date().toISOString()}][webhook->${provider}] results`, { count: results.length, ms: Date.now() - started });
            const best = pickBestResult(results);
            console.log(`[${new Date().toISOString()}][webhook->${provider}] chosen`, { title: best?.title, seeders: best?.seeders, size: best?.size });
            const magnet = getMagnet(best);

            if (!magnet) {
              console.warn(`[${new Date().toISOString()}][webhook] no magnet found in search results`, { query: built.query });
              return;
            }

            const teaser = typeof magnet === 'string' ? magnet.slice(0, 80) + '...' : undefined;
            console.log(`[${new Date().toISOString()}][webhook] adding magnet`, { title: best?.title, teaser });
            const { results: addResults } = await registry.addMagnetWithStrategy(magnet, best?.title, 'all');
            const anyOk = addResults.some(r => r.success);
            console.log(`[${new Date().toISOString()}][webhook] add results`, { anyOk, results: addResults.map(r => ({ provider: r.provider, success: r.success })) });
          } catch (err: any) {
            console.error(`[${new Date().toISOString()}][webhook] async processing error`, err?.message || String(err));
          }
        })();
      } catch (e: any) {
        if (!res.headersSent) {
          if (e?.code === 'ECONNABORTED' || e?.message?.includes('timeout')) {
            console.error(`[${new Date().toISOString()}][webhook] timeout while searching indexer`);
            res.status(504).json({ ok: false, error: "Request timed out while searching indexer. Try again or check your indexer configuration." });
          } else {
            console.error(`[${new Date().toISOString()}][webhook] unexpected error`, e?.message || String(e));
            res.status(500).json({ ok: false, error: e?.message || String(e) });
          }
        }
      }
    });
  }

  // ===========================================================================
  // Filesystem Browser
  // ===========================================================================

  /**
   * GET /api/files — Browses the actual mounted filesystem.
   * Returns directory listings or file metadata for the requested path.
   *
   * Query params:
   * - `path` (optional) — Relative path within the mount base (default "/").
   *
   * Includes directory traversal protection to prevent accessing files
   * outside the mount base.
   */
  app.get("/api/files", async (req, res) => {
    try {
      const mountReadiness = await getMountReadiness();
      if (!mountReadiness.ready) {
        throw new FilesystemBrowserError(503, `Mounted filesystem not ready (${mountReadiness.reason})`);
      }
      const requestedPath = String(req.query.path || "/");
      const mountBase = config.mountBase || "/mnt/schrodrive";
      const listing = await browseMountedFilesystem(mountBase, requestedPath);
      res.json({ ok: true, ...listing, mountBase });
    } catch (err: any) {
      console.error("[api/files] Error:", err.message);
      const status = err instanceof FilesystemBrowserError ? err.status : 500;
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  // ===========================================================================
  // Server Startup
  // ===========================================================================

  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
  });

  // Optional: start Overseerr API poller for periodic request checking
  if (config.runPoller) {
    startOverseerrPoller();
  }

  // Optional: start auto-updater for self-update checks
  startAutoUpdater();

  // Start the download token daily reset cron (midnight in configured timezone)
  tokenRotator.startDailyReset();
  startMagnetBackupScheduler();
}

// ===========================================================================
// Webhook Payload Parser
// ===========================================================================

/**
 * Extracts a search query and optional category filters from an Overseerr
 * webhook payload.
 *
 * Prefers the `subject` field if present. Falls back to constructing a
 * query from `media.title`/`media.name` with optional year and TMDB ID.
 *
 * Maps `media_type` to Prowlarr category IDs:
 * - "movie" → `["5000"]`
 * - "tv" → `["5000"]`
 *
 * @param payload - The raw Overseerr webhook payload.
 * @returns An object with `query` and optional `categories`, or `undefined` if no query could be derived.
 */
export function buildQueryFromPayload(payload: any): { query: string; categories?: string[] } | undefined {
  const subject: string | undefined = payload?.subject;
  const media = payload?.media || {};
  const title = media?.title || media?.name;
  const year = media?.year || media?.releaseYear;
  const mediaType = media?.media_type; // 'movie' or 'tv'
  const tmdbId = media?.tmdbId;

  let query = "";
  if (subject && subject.trim().length > 0) {
    query = subject.trim();
  } else if (title) {
    query = year ? `${title} ${year}` : title;
    // Append TMDB ID for more specific search results
    if (tmdbId && Number.isInteger(Number(tmdbId))) {
      query += ` TMDB${tmdbId}`;
    }
  }

  if (!query) return undefined;

  const result: { query: string; categories?: string[] } = { query };

  // Map media_type to Prowlarr categories if configured
  const defaultCategories = {
    movie: ["5000"], // Movies
    tv: ["5000"], // TV (adjust as needed)
  };
  if (mediaType && defaultCategories[mediaType as keyof typeof defaultCategories]) {
    result.categories = defaultCategories[mediaType as keyof typeof defaultCategories];
  }

  return result;
}
