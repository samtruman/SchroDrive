"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVersionManagerPolicy = getVersionManagerPolicy;
exports.saveVersionManagerPolicy = saveVersionManagerPolicy;
exports.getVersionManagerPolicyHash = getVersionManagerPolicyHash;
exports.saveVersionManagerPreviewAudit = saveVersionManagerPreviewAudit;
exports.getVersionProfiles = getVersionProfiles;
exports.saveVersionProfiles = saveVersionProfiles;
exports.saveVersionManagerScan = saveVersionManagerScan;
exports.getLatestVersionManagerScan = getLatestVersionManagerScan;
exports.getLatestVersionManagerRecords = getLatestVersionManagerRecords;
const db_1 = require("../core/db");
const versionManager_1 = require("./versionManager");
function normalizePolicy(policy) {
    return {
        enableRemote: policy.enableRemote === true,
        acquireMissingRemote: policy.acquireMissingRemote === true,
        safety: {
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
    const id = `scan-${Date.now()}`;
    const database = (0, db_1.getDb)();
    const now = new Date().toISOString();
    database.prepare("INSERT INTO version_manager_scans (id, group_count, version_count, profiles_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, groups.length, groups.reduce((total, group) => total + group.versions.length, 0), JSON.stringify(profiles), now);
    const insert = database.prepare("INSERT INTO version_manager_items (scan_id, group_id, item_id, decision, fingerprint_json, reasons_json) VALUES (?, ?, ?, ?, ?, ?)");
    for (const group of groups)
        for (const version of group.versions)
            insert.run(id, group.id, version.id, version.decision, JSON.stringify(version.fingerprint), JSON.stringify({ reasons: version.reasons, evaluations: version.evaluations }));
    return id;
}
function getLatestVersionManagerScan() {
    const row = (0, db_1.getDb)().prepare("SELECT id, group_count, version_count, created_at FROM version_manager_scans ORDER BY created_at DESC LIMIT 1").get();
    return row ? { id: row.id, groupCount: row.group_count, versionCount: row.version_count, createdAt: row.created_at } : undefined;
}
function getLatestVersionManagerRecords() {
    const scan = getLatestVersionManagerScan();
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
