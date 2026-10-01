import { getDb } from "../core/db";
import { defaultVersionManagerPolicy, defaultVersionProfiles, validateRule, validateScoringRules, versionManagerPolicyHash, type VersionGroup, type VersionManagerPolicy, type VersionProfile, type VersionRecord } from "./versionManager";

function normalizePolicy(policy: Partial<VersionManagerPolicy>): VersionManagerPolicy {
  return {
    enableRemote: policy.enableRemote === true,
    acquireMissingRemote: policy.acquireMissingRemote === true,
    acquisitionMode: policy.acquisitionMode === "NATIVE" ? "NATIVE" : "ARR",
    preferCompletePack: policy.preferCompletePack === true,
    safety: {
      deleteDryRun: policy.safety?.deleteDryRun !== false,
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
  return versionManagerPolicyHash(getVersionManagerPolicy(), getVersionProfiles());
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
      if (profile.scoringRules) profile.scoringRules = validateScoringRules(profile.scoringRules);
      return [profile];
    } catch { return []; }
  });
}

export function saveVersionProfiles(profiles: VersionProfile[]): void {
  const database = getDb();
  const transaction = database.transaction(() => {
    database.exec("DELETE FROM version_manager_profiles");
    const insert = database.prepare("INSERT INTO version_manager_profiles (profile_id, profile_json, updated_at) VALUES (?, ?, ?)");
    for (const profile of profiles) insert.run(profile.id, JSON.stringify({ ...profile, hardRequirements: profile.hardRequirements ? validateRule(profile.hardRequirements) : undefined, scoringRules: profile.scoringRules ? validateScoringRules(profile.scoringRules) : undefined }), new Date().toISOString());
  });
  transaction();
}

export function saveVersionManagerScan(groups: VersionGroup[], profiles: VersionProfile[]): string {
  return saveVersionManagerSnapshot(groups, profiles);
}

export type VersionManagerSnapshotStatus = "VALID" | "PARTIAL" | "INVALID" | "UNKNOWN";

export interface VersionManagerSnapshot {
  id: string;
  providerId: string;
  groups: VersionGroup[];
  profiles: VersionProfile[];
  policyHash?: string;
  status: VersionManagerSnapshotStatus;
  createdAt: string;
}

export function saveVersionManagerSnapshot(
  groups: VersionGroup[],
  profiles: VersionProfile[],
  options: { policyHash?: string; status?: VersionManagerSnapshotStatus; providerId?: string } = {},
): string {
  const providerId = options.providerId || "legacy";
  const id = `scan-${providerId}-${Date.now()}`;
  const database = getDb();
  const now = new Date().toISOString();
  const transaction = database.transaction(() => {
    database.prepare("INSERT INTO version_manager_scans (id, provider_id, group_count, version_count, profiles_json, groups_json, policy_hash, snapshot_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, providerId, groups.length, groups.reduce((total, group) => total + group.versions.length, 0), JSON.stringify(profiles), JSON.stringify(groups), options.policyHash ?? null, options.status ?? "VALID", now);
    const insert = database.prepare("INSERT INTO version_manager_items (scan_id, group_id, item_id, decision, fingerprint_json, reasons_json) VALUES (?, ?, ?, ?, ?, ?)");
    for (const group of groups) for (const version of group.versions) insert.run(id, group.id, version.id, version.decision, JSON.stringify(version.fingerprint), JSON.stringify({ reasons: version.reasons, evaluations: version.evaluations }));
  });
  transaction();
  return id;
}

export function getLatestVersionManagerScan(providerId?: string): { id: string; providerId: string; groupCount: number; versionCount: number; createdAt: string; reviewCount?: number; deleteCandidateCount?: number; primaryMissing?: number; remoteMissing?: number } | undefined {
  const row = providerId
    ? getDb().prepare("SELECT id, provider_id, group_count, version_count, created_at FROM version_manager_scans WHERE snapshot_status = 'VALID' AND provider_id = ? ORDER BY created_at DESC LIMIT 1").get(providerId) as any
    : getDb().prepare("SELECT id, provider_id, group_count, version_count, created_at FROM version_manager_scans WHERE snapshot_status = 'VALID' ORDER BY created_at DESC LIMIT 1").get() as any;
  if (!row) return undefined;
  const audit = getDb().prepare("SELECT review_count, delete_candidate_count, primary_missing, remote_missing FROM version_manager_preview_audit ORDER BY id DESC LIMIT 1").get() as any;
  return { id: row.id, providerId: row.provider_id || "legacy", groupCount: row.group_count, versionCount: row.version_count, createdAt: row.created_at, reviewCount: audit?.review_count, deleteCandidateCount: audit?.delete_candidate_count, primaryMissing: audit?.primary_missing, remoteMissing: audit?.remote_missing };
}

export function getLatestVersionManagerSnapshot(providerId?: string): VersionManagerSnapshot | undefined {
  const row = providerId
    ? getDb().prepare("SELECT id, provider_id, groups_json, profiles_json, policy_hash, snapshot_status, created_at FROM version_manager_scans WHERE snapshot_status = 'VALID' AND provider_id = ? ORDER BY created_at DESC LIMIT 1").get(providerId) as any
    : getDb().prepare("SELECT id, provider_id, groups_json, profiles_json, policy_hash, snapshot_status, created_at FROM version_manager_scans WHERE snapshot_status = 'VALID' ORDER BY created_at DESC LIMIT 1").get() as any;
  if (!row) return undefined;
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
  } catch { return undefined; }
}

export function getLatestVersionManagerRecords(providerId?: string): VersionRecord[] {
  const scan = getLatestVersionManagerScan(providerId);
  if (!scan) return [];
  return (getDb().prepare("SELECT item_id, fingerprint_json FROM version_manager_items WHERE scan_id = ?").all(scan.id) as any[]).flatMap((row) => {
    try { return [{ id: row.item_id, fingerprint: JSON.parse(row.fingerprint_json) } as VersionRecord]; } catch { return []; }
  });
}

export type VersionManagerScanStatus = "IDLE" | "SCANNING" | "ENRICHING" | "EVALUATING" | "PERSISTING" | "COMPLETED" | "PARTIAL" | "FAILED";
export type VersionManagerScanPhase = "idle" | "provider_listing" | "file_tree" | "fingerprint" | "identity" | "policy" | "persistence";

export interface VersionManagerScanJob {
  id: string;
  providerId: string;
  status: VersionManagerScanStatus;
  phase: VersionManagerScanPhase;
  completed: number;
  total?: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  lastError?: string;
  snapshotId?: string;
  snapshotValid: boolean;
}

function mapJob(row: any): VersionManagerScanJob {
  return {
    id: row.id, providerId: row.provider_id || "legacy", status: row.status, phase: row.phase,
    completed: Number(row.completed || 0), total: row.total === null || row.total === undefined ? undefined : Number(row.total),
    startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at || undefined,
    lastError: row.last_error || undefined, snapshotId: row.snapshot_id || undefined, snapshotValid: Boolean(row.snapshot_valid),
  };
}

export function recoverInterruptedVersionManagerScanJobs(): void {
  const now = new Date().toISOString();
  getDb().prepare("UPDATE version_manager_scan_jobs SET status = 'FAILED', phase = 'idle', last_error = 'Scan interrupted by process restart', finished_at = ?, updated_at = ? WHERE status IN ('SCANNING', 'ENRICHING', 'EVALUATING', 'PERSISTING')").run(now, now);
}

export function createVersionManagerScanJob(providerId = "legacy"): VersionManagerScanJob {
  const id = `scan-job-${providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO version_manager_scan_jobs (id, provider_id, status, phase, started_at, updated_at) VALUES (?, ?, 'SCANNING', 'provider_listing', ?, ?)").run(id, providerId, now, now);
  return getVersionManagerScanJob(id)!;
}

export function updateVersionManagerScanJob(id: string, update: Partial<Omit<VersionManagerScanJob, "id">>): void {
  const current = getVersionManagerScanJob(id);
  if (!current) return;
  const merged = { ...current, ...update, updatedAt: new Date().toISOString() };
  getDb().prepare("UPDATE version_manager_scan_jobs SET status = ?, phase = ?, completed = ?, total = ?, updated_at = ?, finished_at = ?, last_error = ?, snapshot_id = ?, snapshot_valid = ? WHERE id = ?")
    .run(merged.status, merged.phase, merged.completed, merged.total ?? null, merged.updatedAt, merged.finishedAt ?? null, merged.lastError ?? null, merged.snapshotId ?? null, merged.snapshotValid ? 1 : 0, id);
}

export function getVersionManagerScanJob(id: string): VersionManagerScanJob | undefined {
  const row = getDb().prepare("SELECT * FROM version_manager_scan_jobs WHERE id = ?").get(id) as any;
  return row ? mapJob(row) : undefined;
}

export function getActiveVersionManagerScanJob(providerId?: string): VersionManagerScanJob | undefined {
  const row = providerId
    ? getDb().prepare("SELECT * FROM version_manager_scan_jobs WHERE provider_id = ? AND status IN ('SCANNING', 'ENRICHING', 'EVALUATING', 'PERSISTING') ORDER BY started_at DESC LIMIT 1").get(providerId) as any
    : getDb().prepare("SELECT * FROM version_manager_scan_jobs WHERE status IN ('SCANNING', 'ENRICHING', 'EVALUATING', 'PERSISTING') ORDER BY started_at DESC LIMIT 1").get() as any;
  return row ? mapJob(row) : undefined;
}
