"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVersionManagerPolicy = getVersionManagerPolicy;
exports.saveVersionManagerPolicy = saveVersionManagerPolicy;
exports.getVersionManagerPolicyHash = getVersionManagerPolicyHash;
exports.listVersionManagerMissingDismissals = listVersionManagerMissingDismissals;
exports.setVersionManagerMissingDismissed = setVersionManagerMissingDismissed;
exports.saveVersionManagerPreviewAudit = saveVersionManagerPreviewAudit;
exports.getVersionProfiles = getVersionProfiles;
exports.saveVersionProfiles = saveVersionProfiles;
exports.saveVersionManagerScan = saveVersionManagerScan;
exports.saveVersionManagerSnapshot = saveVersionManagerSnapshot;
exports.getLatestVersionManagerScan = getLatestVersionManagerScan;
exports.getLatestVersionManagerSnapshot = getLatestVersionManagerSnapshot;
exports.getLatestVersionManagerRecords = getLatestVersionManagerRecords;
exports.recoverInterruptedVersionManagerScanJobs = recoverInterruptedVersionManagerScanJobs;
exports.createVersionManagerScanJob = createVersionManagerScanJob;
exports.updateVersionManagerScanJob = updateVersionManagerScanJob;
exports.getVersionManagerScanJob = getVersionManagerScanJob;
exports.getActiveVersionManagerScanJob = getActiveVersionManagerScanJob;
const db_1 = require("../core/db");
const versionManager_1 = require("./versionManager");
function normalizePolicy(policy) {
    return {
        enableRemote: policy.enableRemote === true,
        acquireMissingRemote: policy.acquireMissingRemote === true,
        acquisitionMode: policy.acquisitionMode === "NATIVE" ? "NATIVE" : "ARR",
        preferCompletePack: policy.preferCompletePack === true,
        useArrIdentityResolution: policy.useArrIdentityResolution === true,
        safety: {
            deleteDryRun: policy.safety?.deleteDryRun !== false,
            requireRecoverableBeforeDelete: policy.safety?.requireRecoverableBeforeDelete ?? versionManager_1.defaultVersionManagerPolicy.safety.requireRecoverableBeforeDelete,
            allowDeleteWhenIdentityUncertain: policy.safety?.allowDeleteWhenIdentityUncertain ?? versionManager_1.defaultVersionManagerPolicy.safety.allowDeleteWhenIdentityUncertain,
            allowDeleteWhenMetadataIncomplete: policy.safety?.allowDeleteWhenMetadataIncomplete ?? versionManager_1.defaultVersionManagerPolicy.safety.allowDeleteWhenMetadataIncomplete,
        },
        policyVersion: policy.policyVersion || versionManager_1.defaultVersionManagerPolicy.policyVersion,
    };
}
function getVersionManagerPolicy() {
    const row = (0, db_1.getDb)().prepare("SELECT policy_json FROM version_manager_policy WHERE id = 'default'").get();
    if (!row)
        return { ...versionManager_1.defaultVersionManagerPolicy };
    try {
        const policy = JSON.parse(row.policy_json);
        return normalizePolicy(policy);
    }
    catch {
        return { ...versionManager_1.defaultVersionManagerPolicy };
    }
}
function saveVersionManagerPolicy(policy) {
    (0, db_1.getDb)().prepare("INSERT OR REPLACE INTO version_manager_policy (id, policy_json, updated_at) VALUES ('default', ?, ?)").run(JSON.stringify(normalizePolicy(policy)), new Date().toISOString());
}
function getVersionManagerPolicyHash() {
    return (0, versionManager_1.versionManagerPolicyHash)(getVersionManagerPolicy(), getVersionProfiles());
}
function listVersionManagerMissingDismissals(providerId) {
    const rows = (0, db_1.getDb)().prepare("SELECT dismissal_key FROM version_manager_missing_dismissals WHERE provider_id = ?").all(providerId);
    return new Set(rows.map((row) => row.dismissal_key));
}
function setVersionManagerMissingDismissed(providerId, dismissalKey, dismissed) {
    const database = (0, db_1.getDb)();
    if (dismissed) {
        database.prepare("INSERT OR REPLACE INTO version_manager_missing_dismissals (dismissal_key, provider_id, updated_at) VALUES (?, ?, ?)")
            .run(dismissalKey, providerId, new Date().toISOString());
    }
    else {
        database.prepare("DELETE FROM version_manager_missing_dismissals WHERE provider_id = ? AND dismissal_key = ?")
            .run(providerId, dismissalKey);
    }
}
function saveVersionManagerPreviewAudit(audit) {
    (0, db_1.getDb)().prepare(`INSERT INTO version_manager_preview_audit
    (policy_hash, evaluated_at, content_count, version_group_count, version_count, keep_count, delete_candidate_count, review_count, primary_missing, remote_missing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(audit.policyHash, audit.evaluatedAt, audit.contentCount, audit.versionGroupCount, audit.versionCount, audit.keepCount, audit.deleteCandidateCount, audit.reviewCount, audit.primaryMissing, audit.remoteMissing);
}
function getVersionProfiles() {
    const rows = (0, db_1.getDb)().prepare("SELECT profile_json FROM version_manager_profiles ORDER BY profile_id").all();
    if (rows.length === 0)
        return versionManager_1.defaultVersionProfiles;
    return rows.flatMap((row) => {
        try {
            const profile = JSON.parse(row.profile_json);
            if (profile.hardRequirements)
                profile.hardRequirements = (0, versionManager_1.validateRule)(profile.hardRequirements);
            if (profile.scoringRules)
                profile.scoringRules = (0, versionManager_1.validateScoringRules)(profile.scoringRules);
            return [profile];
        }
        catch {
            return [];
        }
    });
}
function saveVersionProfiles(profiles) {
    const database = (0, db_1.getDb)();
    const transaction = database.transaction(() => {
        database.exec("DELETE FROM version_manager_profiles");
        const insert = database.prepare("INSERT INTO version_manager_profiles (profile_id, profile_json, updated_at) VALUES (?, ?, ?)");
        for (const profile of profiles)
            insert.run(profile.id, JSON.stringify({ ...profile, hardRequirements: profile.hardRequirements ? (0, versionManager_1.validateRule)(profile.hardRequirements) : undefined, scoringRules: profile.scoringRules ? (0, versionManager_1.validateScoringRules)(profile.scoringRules) : undefined }), new Date().toISOString());
    });
    transaction();
}
function saveVersionManagerScan(groups, profiles) {
    return saveVersionManagerSnapshot(groups, profiles);
}
function saveVersionManagerSnapshot(groups, profiles, options = {}) {
    const providerId = options.providerId || "legacy";
    const id = `scan-${providerId}-${Date.now()}`;
    const database = (0, db_1.getDb)();
    const now = new Date().toISOString();
    const transaction = database.transaction(() => {
        database.prepare("INSERT INTO version_manager_scans (id, provider_id, group_count, version_count, profiles_json, groups_json, policy_hash, snapshot_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, providerId, groups.length, groups.reduce((total, group) => total + group.versions.length, 0), JSON.stringify(profiles), JSON.stringify(groups), options.policyHash ?? null, options.status ?? "VALID", now);
        const insert = database.prepare("INSERT INTO version_manager_items (scan_id, group_id, item_id, decision, fingerprint_json, reasons_json) VALUES (?, ?, ?, ?, ?, ?)");
        for (const group of groups)
            for (const version of group.versions)
                insert.run(id, group.id, version.id, version.decision, JSON.stringify(version.fingerprint), JSON.stringify({ reasons: version.reasons, evaluations: version.evaluations }));
    });
    transaction();
    return id;
}
function getLatestVersionManagerScan(providerId) {
    const row = providerId
        ? (0, db_1.getDb)().prepare("SELECT id, provider_id, group_count, version_count, created_at FROM version_manager_scans WHERE snapshot_status = 'VALID' AND provider_id = ? ORDER BY created_at DESC LIMIT 1").get(providerId)
        : (0, db_1.getDb)().prepare("SELECT id, provider_id, group_count, version_count, created_at FROM version_manager_scans WHERE snapshot_status = 'VALID' ORDER BY created_at DESC LIMIT 1").get();
    if (!row)
        return undefined;
    const audit = (0, db_1.getDb)().prepare("SELECT review_count, delete_candidate_count, primary_missing, remote_missing FROM version_manager_preview_audit ORDER BY id DESC LIMIT 1").get();
    return { id: row.id, providerId: row.provider_id || "legacy", groupCount: row.group_count, versionCount: row.version_count, createdAt: row.created_at, reviewCount: audit?.review_count, deleteCandidateCount: audit?.delete_candidate_count, primaryMissing: audit?.primary_missing, remoteMissing: audit?.remote_missing };
}
function getLatestVersionManagerSnapshot(providerId) {
    const row = providerId
        ? (0, db_1.getDb)().prepare("SELECT id, provider_id, groups_json, profiles_json, policy_hash, snapshot_status, created_at FROM version_manager_scans WHERE snapshot_status = 'VALID' AND provider_id = ? ORDER BY created_at DESC LIMIT 1").get(providerId)
        : (0, db_1.getDb)().prepare("SELECT id, provider_id, groups_json, profiles_json, policy_hash, snapshot_status, created_at FROM version_manager_scans WHERE snapshot_status = 'VALID' ORDER BY created_at DESC LIMIT 1").get();
    if (!row)
        return undefined;
    try {
        return {
            id: row.id,
            providerId: row.provider_id || "legacy",
            groups: row.groups_json ? JSON.parse(row.groups_json) : [],
            profiles: JSON.parse(row.profiles_json),
            policyHash: row.policy_hash || undefined,
            status: row.snapshot_status,
            createdAt: row.created_at,
        };
    }
    catch {
        return undefined;
    }
}
function getLatestVersionManagerRecords(providerId) {
    const scan = getLatestVersionManagerScan(providerId);
    if (!scan)
        return [];
    return (0, db_1.getDb)().prepare("SELECT item_id, fingerprint_json FROM version_manager_items WHERE scan_id = ?").all(scan.id).flatMap((row) => {
        try {
            return [{ id: row.item_id, fingerprint: JSON.parse(row.fingerprint_json) }];
        }
        catch {
            return [];
        }
    });
}
function mapJob(row) {
    return {
        id: row.id, providerId: row.provider_id || "legacy", status: row.status, phase: row.phase,
        completed: Number(row.completed || 0), total: row.total === null || row.total === undefined ? undefined : Number(row.total),
        startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at || undefined,
        lastError: row.last_error || undefined, snapshotId: row.snapshot_id || undefined, snapshotValid: Boolean(row.snapshot_valid),
    };
}
function recoverInterruptedVersionManagerScanJobs() {
    const now = new Date().toISOString();
    (0, db_1.getDb)().prepare("UPDATE version_manager_scan_jobs SET status = 'FAILED', phase = 'idle', last_error = 'Scan interrupted by process restart', finished_at = ?, updated_at = ? WHERE status IN ('SCANNING', 'ENRICHING', 'EVALUATING', 'PERSISTING')").run(now, now);
}
function createVersionManagerScanJob(providerId = "legacy") {
    const id = `scan-job-${providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    (0, db_1.getDb)().prepare("INSERT INTO version_manager_scan_jobs (id, provider_id, status, phase, started_at, updated_at) VALUES (?, ?, 'SCANNING', 'provider_listing', ?, ?)").run(id, providerId, now, now);
    return getVersionManagerScanJob(id);
}
function updateVersionManagerScanJob(id, update) {
    const current = getVersionManagerScanJob(id);
    if (!current)
        return;
    const merged = { ...current, ...update, updatedAt: new Date().toISOString() };
    (0, db_1.getDb)().prepare("UPDATE version_manager_scan_jobs SET status = ?, phase = ?, completed = ?, total = ?, updated_at = ?, finished_at = ?, last_error = ?, snapshot_id = ?, snapshot_valid = ? WHERE id = ?")
        .run(merged.status, merged.phase, merged.completed, merged.total ?? null, merged.updatedAt, merged.finishedAt ?? null, merged.lastError ?? null, merged.snapshotId ?? null, merged.snapshotValid ? 1 : 0, id);
}
function getVersionManagerScanJob(id) {
    const row = (0, db_1.getDb)().prepare("SELECT * FROM version_manager_scan_jobs WHERE id = ?").get(id);
    return row ? mapJob(row) : undefined;
}
function getActiveVersionManagerScanJob(providerId) {
    const row = providerId
        ? (0, db_1.getDb)().prepare("SELECT * FROM version_manager_scan_jobs WHERE provider_id = ? AND status IN ('SCANNING', 'ENRICHING', 'EVALUATING', 'PERSISTING') ORDER BY started_at DESC LIMIT 1").get(providerId)
        : (0, db_1.getDb)().prepare("SELECT * FROM version_manager_scan_jobs WHERE status IN ('SCANNING', 'ENRICHING', 'EVALUATING', 'PERSISTING') ORDER BY started_at DESC LIMIT 1").get();
    return row ? mapJob(row) : undefined;
}
