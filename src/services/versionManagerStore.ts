import { getDb } from "../core/db";
import { defaultVersionManagerPolicy, defaultVersionProfiles, validateRule, type VersionGroup, type VersionManagerPolicy, type VersionProfile } from "./versionManager";

export function getVersionManagerPolicy(): VersionManagerPolicy {
  const row = getDb().prepare("SELECT policy_json FROM version_manager_policy WHERE id = 'default'").get() as { policy_json: string } | undefined;
  if (!row) return { ...defaultVersionManagerPolicy };
  try {
    const policy = JSON.parse(row.policy_json) as Partial<VersionManagerPolicy>;
    return { enableRemote: policy.enableRemote === true, acquireMissingRemote: policy.acquireMissingRemote === true };
  } catch { return { ...defaultVersionManagerPolicy }; }
}

export function saveVersionManagerPolicy(policy: VersionManagerPolicy): void {
  getDb().prepare("INSERT OR REPLACE INTO version_manager_policy (id, policy_json, updated_at) VALUES ('default', ?, ?)").run(JSON.stringify({ enableRemote: policy.enableRemote === true, acquireMissingRemote: policy.acquireMissingRemote === true }), new Date().toISOString());
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
