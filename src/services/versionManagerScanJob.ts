import { registry } from "../providers";
import { getConfiguredMountReadiness } from "./mount";
import { loadMediaManagerInventory, type MediaManagerInventoryStats } from "./mediaManagerInventory";
import { applyManualIdentityOverrides } from "./manualIdentity";
import { enrichVersionMetadata } from "./versionManagerMetadata";
import { probeVersionRecords } from "./versionManagerProbe";
import { evaluateVersionGroups, versionManagerPolicyHash } from "./versionManager";
import {
  createVersionManagerScanJob,
  getActiveVersionManagerScanJob,
  getVersionManagerScanJob,
  getLatestVersionManagerSnapshot,
  recoverInterruptedVersionManagerScanJobs,
  saveVersionManagerPreviewAudit,
  saveVersionManagerSnapshot,
  updateVersionManagerScanJob,
  getVersionManagerPolicy,
  getVersionProfiles,
  type VersionManagerScanJob,
} from "./versionManagerStore";

let recoveryChecked = false;
const activeJobs = new Map<string, Promise<void>>();

function ensureRecovery(): void {
  if (recoveryChecked) return;
  recoverInterruptedVersionManagerScanJobs();
  recoveryChecked = true;
}

function readinessError(statuses: Awaited<ReturnType<typeof getConfiguredMountReadiness>>): string | undefined {
  const unavailable = statuses.find((status) => !status.ready);
  return unavailable ? `Provider mount is not ready (${unavailable.reason})` : undefined;
}

async function execute(job: VersionManagerScanJob): Promise<void> {
  const stats: MediaManagerInventoryStats = {
    durationMs: 0, providers: 0, providerListCalls: 0, fileTreeFetches: 0,
    providerItems: 0, fileTreeItems: 0, inlineFileItems: 0, nameFallbackItems: 0,
    mediaFiles: 0, versions: 0,
    recoverability: { requested: 0, cacheHits: 0, providerLookups: 0, resolved: 0, unknown: 0 },
  };
  try {
    const provider = registry.get(job.providerId);
    if (!provider || !provider.isConfigured()) throw new Error(`Provider ${job.providerId} is not configured`);
    const initialReadiness = readinessError(await getConfiguredMountReadiness([job.providerId]));
    if (initialReadiness) throw new Error(initialReadiness);

    const versions = await loadMediaManagerInventory([provider], stats, (progress) => {
      updateVersionManagerScanJob(job.id, {
        status: progress.phase === "identity" ? "ENRICHING" : "SCANNING",
        phase: progress.phase,
        completed: progress.completed,
        total: progress.total,
      });
    });
    const evaluatedVersions = applyManualIdentityOverrides(versions);

    updateVersionManagerScanJob(job.id, { status: "ENRICHING", phase: "identity", completed: 0, total: evaluatedVersions.length });
    await probeVersionRecords(evaluatedVersions);
    await enrichVersionMetadata(evaluatedVersions, {
      onProgress: (progress) => updateVersionManagerScanJob(job.id, {
        status: "ENRICHING",
        phase: "identity",
        completed: progress.index,
        total: progress.total,
      }),
    });

    updateVersionManagerScanJob(job.id, { status: "EVALUATING", phase: "policy", completed: 0, total: evaluatedVersions.length });
    const profiles = getVersionProfiles();
    const policy = getVersionManagerPolicy();
    const groups = evaluateVersionGroups(evaluatedVersions, profiles, policy);

    const finalReadiness = readinessError(await getConfiguredMountReadiness([job.providerId]));
    if (finalReadiness) throw new Error(finalReadiness);

    updateVersionManagerScanJob(job.id, { status: "PERSISTING", phase: "persistence", completed: 0, total: groups.length });
    const policyHash = versionManagerPolicyHash(policy, profiles);
    const snapshotId = saveVersionManagerSnapshot(groups, profiles, { policyHash, status: "VALID", providerId: job.providerId });
    const versionsFlat = groups.flatMap((group) => group.versions);
    saveVersionManagerPreviewAudit({
      policyHash, evaluatedAt: new Date().toISOString(), contentCount: groups.length,
      versionGroupCount: groups.length, versionCount: versionsFlat.length,
      keepCount: versionsFlat.filter((version) => version.decision === "KEEP").length,
      deleteCandidateCount: versionsFlat.filter((version) => version.decision === "DELETE_CANDIDATE").length,
      reviewCount: versionsFlat.filter((version) => version.decision === "REVIEW").length,
      primaryMissing: groups.filter((group) => group.profileStatuses?.some((status) => status.profileId === "primary" && !status.satisfied)).length,
      remoteMissing: policy.enableRemote ? groups.filter((group) => group.remote?.status === "REMOTE_MISSING").length : 0,
    });
    updateVersionManagerScanJob(job.id, { status: "COMPLETED", phase: "idle", completed: groups.length, total: groups.length, finishedAt: new Date().toISOString(), snapshotId, snapshotValid: true });
  } catch (error: any) {
    const validSnapshot = Boolean(getLatestVersionManagerSnapshot(job.providerId));
    updateVersionManagerScanJob(job.id, { status: "FAILED", phase: "idle", finishedAt: new Date().toISOString(), lastError: error?.message || "Inventory scan failed", snapshotValid: validSnapshot });
  }
}

export function startVersionManagerScan(providerId: string): VersionManagerScanJob {
  ensureRecovery();
  const existing = getActiveVersionManagerScanJob(providerId);
  if (existing) return existing;
  const job = createVersionManagerScanJob(providerId);
  const work = execute(job).finally(() => { activeJobs.delete(providerId); });
  activeJobs.set(providerId, work);
  void work;
  return job;
}

export function getVersionManagerScanStatus(id?: string, providerId?: string): VersionManagerScanJob | undefined {
  ensureRecovery();
  return id ? getVersionManagerScanJob(id) : getActiveVersionManagerScanJob(providerId);
}

export function getVersionManagerScanRuntimeStatus(providerId?: string): { active: boolean; job?: VersionManagerScanJob } {
  ensureRecovery();
  return { active: providerId ? activeJobs.has(providerId) : activeJobs.size > 0, job: getActiveVersionManagerScanJob(providerId) };
}
