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
let activeJob: Promise<void> | null = null;

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
    const initialReadiness = readinessError(await getConfiguredMountReadiness());
    if (initialReadiness) throw new Error(initialReadiness);

    const versions = await loadMediaManagerInventory(undefined, stats, (progress) => {
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
    await enrichVersionMetadata(evaluatedVersions);

    updateVersionManagerScanJob(job.id, { status: "EVALUATING", phase: "policy", completed: 0, total: evaluatedVersions.length });
    const profiles = getVersionProfiles();
    const policy = getVersionManagerPolicy();
    const groups = evaluateVersionGroups(evaluatedVersions, profiles, policy);

    const finalReadiness = readinessError(await getConfiguredMountReadiness());
    if (finalReadiness) throw new Error(finalReadiness);

    updateVersionManagerScanJob(job.id, { status: "PERSISTING", phase: "persistence", completed: 0, total: groups.length });
    const policyHash = versionManagerPolicyHash(policy, profiles);
    const snapshotId = saveVersionManagerSnapshot(groups, profiles, { policyHash, status: "VALID" });
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
    const validSnapshot = Boolean(getLatestVersionManagerSnapshot());
    updateVersionManagerScanJob(job.id, { status: "FAILED", phase: "idle", finishedAt: new Date().toISOString(), lastError: error?.message || "Inventory scan failed", snapshotValid: validSnapshot });
  }
}

export function startVersionManagerScan(): VersionManagerScanJob {
  ensureRecovery();
  const existing = getActiveVersionManagerScanJob();
  if (existing) return existing;
  const job = createVersionManagerScanJob();
  activeJob = execute(job).finally(() => { activeJob = null; });
  void activeJob;
  return job;
}

export function getVersionManagerScanStatus(id?: string): VersionManagerScanJob | undefined {
  ensureRecovery();
  return id ? getVersionManagerScanJob(id) : getActiveVersionManagerScanJob();
}

export function getVersionManagerScanRuntimeStatus(): { active: boolean; job?: VersionManagerScanJob } {
  ensureRecovery();
  return { active: Boolean(activeJob), job: getActiveVersionManagerScanJob() };
}
