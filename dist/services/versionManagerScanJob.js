"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startVersionManagerScan = startVersionManagerScan;
exports.getVersionManagerScanStatus = getVersionManagerScanStatus;
exports.getVersionManagerScanRuntimeStatus = getVersionManagerScanRuntimeStatus;
const mount_1 = require("./mount");
const mediaManagerInventory_1 = require("./mediaManagerInventory");
const manualIdentity_1 = require("./manualIdentity");
const versionManagerMetadata_1 = require("./versionManagerMetadata");
const versionManagerProbe_1 = require("./versionManagerProbe");
const versionManager_1 = require("./versionManager");
const versionManagerStore_1 = require("./versionManagerStore");
let recoveryChecked = false;
let activeJob = null;
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
        const initialReadiness = readinessError(await (0, mount_1.getConfiguredMountReadiness)());
        if (initialReadiness)
            throw new Error(initialReadiness);
        const versions = await (0, mediaManagerInventory_1.loadMediaManagerInventory)(undefined, stats, (progress) => {
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
        await (0, versionManagerMetadata_1.enrichVersionMetadata)(evaluatedVersions, {
            onProgress: (progress) => (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, {
                status: "ENRICHING",
                phase: "identity",
                completed: progress.index,
                total: progress.total,
            }),
        });
        (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, { status: "EVALUATING", phase: "policy", completed: 0, total: evaluatedVersions.length });
        const profiles = (0, versionManagerStore_1.getVersionProfiles)();
        const policy = (0, versionManagerStore_1.getVersionManagerPolicy)();
        const groups = (0, versionManager_1.evaluateVersionGroups)(evaluatedVersions, profiles, policy);
        const finalReadiness = readinessError(await (0, mount_1.getConfiguredMountReadiness)());
        if (finalReadiness)
            throw new Error(finalReadiness);
        (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, { status: "PERSISTING", phase: "persistence", completed: 0, total: groups.length });
        const policyHash = (0, versionManager_1.versionManagerPolicyHash)(policy, profiles);
        const snapshotId = (0, versionManagerStore_1.saveVersionManagerSnapshot)(groups, profiles, { policyHash, status: "VALID" });
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
        const validSnapshot = Boolean((0, versionManagerStore_1.getLatestVersionManagerSnapshot)());
        (0, versionManagerStore_1.updateVersionManagerScanJob)(job.id, { status: "FAILED", phase: "idle", finishedAt: new Date().toISOString(), lastError: error?.message || "Inventory scan failed", snapshotValid: validSnapshot });
    }
}
function startVersionManagerScan() {
    ensureRecovery();
    const existing = (0, versionManagerStore_1.getActiveVersionManagerScanJob)();
    if (existing)
        return existing;
    const job = (0, versionManagerStore_1.createVersionManagerScanJob)();
    activeJob = execute(job).finally(() => { activeJob = null; });
    void activeJob;
    return job;
}
function getVersionManagerScanStatus(id) {
    ensureRecovery();
    return id ? (0, versionManagerStore_1.getVersionManagerScanJob)(id) : (0, versionManagerStore_1.getActiveVersionManagerScanJob)();
}
function getVersionManagerScanRuntimeStatus() {
    ensureRecovery();
    return { active: Boolean(activeJob), job: (0, versionManagerStore_1.getActiveVersionManagerScanJob)() };
}
