"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startVersionManagerScan = startVersionManagerScan;
exports.getVersionManagerScanStatus = getVersionManagerScanStatus;
exports.getVersionManagerScanRuntimeStatus = getVersionManagerScanRuntimeStatus;
const providers_1 = require("../providers");
const mount_1 = require("./mount");
const mediaManagerInventory_1 = require("./mediaManagerInventory");
const manualIdentity_1 = require("./manualIdentity");
const versionManagerMetadata_1 = require("./versionManagerMetadata");
const versionManagerProbe_1 = require("./versionManagerProbe");
const versionManager_1 = require("./versionManager");
const versionManagerStore_1 = require("./versionManagerStore");
let recoveryChecked = false;
const activeJobs = new Map();
function ensureRecovery() {
    if (recoveryChecked)
        return;
    (0, versionManagerStore_1.recoverInterruptedVersionManagerScanJobs)();
    recoveryChecked = true;
}
function readinessError(statuses) {
    const unavailable = statuses.find((status) => !status.ready);
    return unavailable ? `Provider mount is not ready (${unavailable.reason})` : undefined;
}
async function execute(job) {
    const stats = {
        durationMs: 0, providers: 0, providerListCalls: 0, fileTreeFetches: 0,
        providerItems: 0, fileTreeItems: 0, inlineFileItems: 0, nameFallbackItems: 0,
        mediaFiles: 0, versions: 0,
        recoverability: { requested: 0, cacheHits: 0, providerLookups: 0, resolved: 0, unknown: 0 },
    };
    try {
        const provider = providers_1.registry.get(job.providerId);
        if (!provider || !provider.isConfigured())
            throw new Error(`Provider ${job.providerId} is not configured`);
        const initialReadiness = readinessError(await (0, mount_1.getConfiguredMountReadiness)([job.providerId]));
        if (initialReadiness)
            throw new Error(initialReadiness);
        const versions = await (0, mediaManagerInventory_1.loadMediaManagerInventory)([provider], stats, (progress) => {
            (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, {
                status: progress.phase === "identity" ? "ENRICHING" : "SCANNING",
                phase: progress.phase,
                completed: progress.completed,
                total: progress.total,
            });
        });
        const evaluatedVersions = (0, manualIdentity_1.applyManualIdentityOverrides)(versions);
        (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, { status: "ENRICHING", phase: "identity", completed: 0, total: evaluatedVersions.length });
        await (0, versionManagerProbe_1.probeVersionRecords)(evaluatedVersions);
        const policy = (0, versionManagerStore_1.getVersionManagerPolicy)();
        await (0, versionManagerMetadata_1.enrichVersionMetadata)(evaluatedVersions, {
            useArrIdentityResolution: policy.useArrIdentityResolution === true,
            onProgress: (progress) => (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, {
                status: "ENRICHING",
                phase: "identity",
                completed: progress.index,
                total: progress.total,
            }),
        });
        (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, { status: "EVALUATING", phase: "policy", completed: 0, total: evaluatedVersions.length });
        const profiles = (0, versionManagerStore_1.getVersionProfiles)();
        const groups = (0, versionManager_1.evaluateVersionGroups)(evaluatedVersions, profiles, policy);
        const finalReadiness = readinessError(await (0, mount_1.getConfiguredMountReadiness)([job.providerId]));
        if (finalReadiness)
            throw new Error(finalReadiness);
        (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, { status: "PERSISTING", phase: "persistence", completed: 0, total: groups.length });
        const policyHash = (0, versionManager_1.versionManagerPolicyHash)(policy, profiles);
        const snapshotId = (0, versionManagerStore_1.saveVersionManagerSnapshot)(groups, profiles, { policyHash, status: "VALID", providerId: job.providerId });
        const versionsFlat = groups.flatMap((group) => group.versions);
        (0, versionManagerStore_1.saveVersionManagerPreviewAudit)({
            policyHash, evaluatedAt: new Date().toISOString(), contentCount: groups.length,
            versionGroupCount: groups.length, versionCount: versionsFlat.length,
            keepCount: versionsFlat.filter((version) => version.decision === "KEEP").length,
            deleteCandidateCount: versionsFlat.filter((version) => version.decision === "DELETE_CANDIDATE").length,
            reviewCount: versionsFlat.filter((version) => version.decision === "REVIEW").length,
            primaryMissing: groups.filter((group) => group.profileStatuses?.some((status) => status.profileId === "primary" && !status.satisfied)).length,
            remoteMissing: policy.enableRemote ? groups.filter((group) => group.remote?.status === "REMOTE_MISSING").length : 0,
        });
        (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, { status: "COMPLETED", phase: "idle", completed: groups.length, total: groups.length, finishedAt: new Date().toISOString(), snapshotId, snapshotValid: true });
    }
    catch (error) {
        const validSnapshot = Boolean((0, versionManagerStore_1.getLatestVersionManagerSnapshot)(job.providerId));
        (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, { status: "FAILED", phase: "idle", finishedAt: new Date().toISOString(), lastError: error?.message || "Inventory scan failed", snapshotValid: validSnapshot });
    }
}
function startVersionManagerScan(providerId) {
    ensureRecovery();
    const existing = (0, versionManagerStore_1.getActiveVersionManagerScanJob)(providerId);
    if (existing)
        return existing;
    const job = (0, versionManagerStore_1.createVersionManagerScanJob)(providerId);
    const work = execute(job).finally(() => { activeJobs.delete(providerId); });
    activeJobs.set(providerId, work);
    void work;
    return job;
}
function getVersionManagerScanStatus(id, providerId) {
    ensureRecovery();
    return id ? (0, versionManagerStore_1.getVersionManagerScanJob)(id) : (0, versionManagerStore_1.getActiveVersionManagerScanJob)(providerId);
}
function getVersionManagerScanRuntimeStatus(providerId) {
    ensureRecovery();
    return { active: providerId ? activeJobs.has(providerId) : activeJobs.size > 0, job: (0, versionManagerStore_1.getActiveVersionManagerScanJob)(providerId) };
}
