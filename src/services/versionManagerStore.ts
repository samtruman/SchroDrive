import { getDb } from "../core/db";
import { defaultVersionManagerPolicy, defaultVersionProfiles, validateRule, versionManagerPolicyHash, type VersionGroup, type VersionManagerPolicy, type VersionProfile, type VersionRecord } from "./versionManager";

function normalizePolicy(policy: Partial<VersionManagerPolicy>): VersionManagerPolicy {
  return {
    enableRemote: policy.enableRemote === true,
    acquireMissingRemote: policy.acquireMissingRemote === true,
    safety: {
      requireRecoverableBeforeDelete: policy.safety?.requireRecoverableBeforeDelete ?? defaultVersionManagerPolicy.safety!.requireRecoverableBeforeDelete,
      allowDeleteWhenIdentityUncertain: policy.safety?.allowDeleteWhenIdentityUncertain ?? defaultVersionManagerPolicy.safety!.allowDeleteWhenIdentityUncertain,
      allowDeleteWhenMetadataIncomplete: policy.safety?.allowDeleteWhenMetadataIncomplete ?? defaultVersionManagerPolicy.safety!.allowDeleteWhenMetadataIncomplete,
    },
    policyVersion: policy.policyVersion || defaultVersionManagerPolicy.policyVersion,
  };
}

export function getVersionManagerPolicy(): VersionManagerPolicy {
  const row = getDb().prepare("SELECT policy_json FROM version_manager_policy WHERE id = 'default'").get() as { policy_json: string } | undefined;
  if (!row) return { ...defaultVersionManagerPolicy };
  try {
    const policy = JSON.parse(row.policy_json) as Partial<VersionManagerPolicy>;
    return normalizePolicy(policy);
  } catch { return { ...defaultVersionManagerPolicy }; }
}

export function saveVersionManagerPolicy(policy: VersionManagerPolicy): void {
  getDb().prepare("INSERT OR REPLACE INTO version_manager_policy (id, policy_json, updated_at) VALUES ('default', ?, ?)").run(JSON.stringify(normalizePolicy(policy)), new Date().toISOString());
}

export function getVersionManagerPolicyHash(): string {
  return versionManagerPolicyHash(getVersionManagerPolicy());
}

export interface VersionManagerPreviewAudit {
  policyHash: string;
  evaluatedAt: string;
  contentCount: number;
  versionGroupCount: number;
  versionCount: number;
  keepCount: number;
  deleteCandidateCount: number;
  reviewCount: number;
  primaryMissing: number;
  remoteMissing: number;
}

export function saveVersionManagerPreviewAudit(audit: VersionManagerPreviewAudit): void {
  getDb().prepare(`INSERT INTO version_manager_preview_audit
    (policy_hash, evaluated_at, content_count, version_group_count, version_count, keep_count, delete_candidate_count, review_count, primary_missing, remote_missing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(audit.policyHash, audit.evaluatedAt, audit.contentCount, audit.versionGroupCount, audit.versionCount, audit.keepCount, audit.deleteCandidateCount, audit.reviewCount, audit.primaryMissing, audit.remoteMissing);
}

export function getVersionProfiles(): VersionProfile[] {
  const rows = getDb().prepare("SELECT profile_json FROM version_manager_profiles ORDER BY profile_id").all() as Array<{ profile_json: string }>;
  if (rows.length === 0) return defaultVersionProfiles;
  return rows.flatMap((row) => {
    try {
      const profile = JSON.parse(row.profile_json) as VersionProfile;
      if (profile.hardRequirements) profile.hardRequirements = validateRule(profile.hardRequirements);
      return [profile];
    } catch { return []; }
  });
}

export function saveVersionProfiles(profiles: VersionProfile[]): void {
  const database = getDb();
  const transaction = database.transaction(() => {
    database.exec("DELETE FROM version_manager_profiles");
    const insert = database.prepare("INSERT INTO version_manager_profiles (profile_id, profile_json, updated_at) VALUES (?, ?, ?)");
    for (const profile of profiles) insert.run(profile.id, JSON.stringify({ ...profile, hardRequirements: profile.hardRequirements ? validateRule(profile.hardRequirements) : undefined }), new Date().toISOString());
  });
  transaction();
}

export function saveVersionManagerScan(groups: VersionGroup[], profiles: VersionProfile[]): string {
  const id = `scan-${Date.now()}`;
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare("INSERT INTO version_manager_scans (id, group_count, version_count, profiles_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, groups.length, groups.reduce((total, group) => total + group.versions.length, 0), JSON.stringify(profiles), now);
  const insert = database.prepare("INSERT INTO version_manager_items (scan_id, group_id, item_id, decision, fingerprint_json, reasons_json) VALUES (?, ?, ?, ?, ?, ?)");
  for (const group of groups) for (const version of group.versions) insert.run(id, group.id, version.id, version.decision, JSON.stringify(version.fingerprint), JSON.stringify({ reasons: version.reasons, evaluations: version.evaluations }));
  return id;
}

export function getLatestVersionManagerScan(): { id: string; groupCount: number; versionCount: number; createdAt: string } | undefined {
  const row = getDb().prepare("SELECT id, group_count, version_count, created_at FROM version_manager_scans ORDER BY created_at DESC LIMIT 1").get() as any;
  return row ? { id: row.id, groupCount: row.group_count, versionCount: row.version_count, createdAt: row.created_at } : undefined;
}

export function getLatestVersionManagerRecords(): VersionRecord[] {
  const scan = getLatestVersionManagerScan();
  if (!scan) return [];
  return (getDb().prepare("SELECT item_id, fingerprint_json FROM version_manager_items WHERE scan_id = ?").all(scan.id) as any[]).flatMap((row) => {
    try { return [{ id: row.item_id, fingerprint: JSON.parse(row.fingerprint_json) } as VersionRecord]; } catch { return []; }
  });
}
