import type { ImportPlanStatus } from "./migrationImporter";

export interface MigrationStateAuditLike {
  executionStatus: string;
  reason?: string;
  createdAt?: string;
  targetProviderItemId?: string;
}

export interface EffectiveMigrationStatus {
  status: string;
  reason?: string;
  lastAttempt?: string;
  targetProviderItemId?: string;
}

export interface MigrationJobSummary {
  jobId: string;
  sourceProvider: string;
  targetProvider: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  total: number;
  imported: number;
  skipped: number;
  rejectedLegal: number;
  failed: number;
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "INTERRUPTED";
  items: Array<{ infoHash: string; status: string; reason?: string; createdAt: string }>;
}

export function aggregateMigrationJobs(entries: Array<{
  id: number; sourceProvider: string; targetProvider: string; infoHash: string;
  executionStatus: string; reason?: string; createdAt: string;
}>): MigrationJobSummary[] {
  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    const day = entry.createdAt.slice(0, 10);
    const key = `${entry.sourceProvider}:${entry.targetProvider}:${day}`;
    const group = grouped.get(key) || [];
    group.push(entry); grouped.set(key, group);
  }
  return [...grouped.values()].map((items) => {
    const ordered = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    const imported = items.filter((item) => item.executionStatus === "IMPORTED").length;
    const skipped = items.filter((item) => item.executionStatus === "SKIPPED_ALREADY_PRESENT").length;
    const rejectedLegal = items.filter((item) => item.executionStatus === "REJECTED_LEGAL").length;
    const failed = items.filter((item) => ["FAILED_PERMANENT", "FAILED_RETRYABLE_EXHAUSTED"].includes(item.executionStatus)).length;
    const status: MigrationJobSummary["status"] = failed === items.length ? "FAILED" : (failed || rejectedLegal ? "PARTIAL" : "COMPLETED");
    return { jobId: `audit-${ordered[0].id}-${ordered[ordered.length - 1].id}`, sourceProvider: ordered[0].sourceProvider, targetProvider: ordered[0].targetProvider, createdAt: ordered[0].createdAt, startedAt: ordered[0].createdAt, completedAt: ordered[ordered.length - 1].createdAt, total: items.length, imported, skipped, rejectedLegal, failed, status, items: ordered.map((item) => ({ infoHash: item.infoHash, status: item.executionStatus, reason: item.reason, createdAt: item.createdAt })) };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Reconciles raw provider state with durable outcomes such as legal rejection. */
export function effectiveMigrationStatus(rawStatus: ImportPlanStatus, audit?: MigrationStateAuditLike): EffectiveMigrationStatus {
  if (!audit) return { status: rawStatus };
  if (audit.executionStatus === "REJECTED_LEGAL") return { status: "REJECTED_LEGAL", reason: audit.reason || "LEGAL_RESTRICTION", lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
  if (audit.executionStatus === "FAILED_PERMANENT") return { status: "FAILED_PERMANENT", reason: audit.reason || "Permanent import failure", lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
  if (audit.executionStatus === "FAILED_RETRYABLE_EXHAUSTED") return { status: "RETRY_EXHAUSTED", reason: audit.reason || "Retryable import failure exhausted", lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
  if (audit.executionStatus === "IMPORTED" && (rawStatus === "ALREADY_PRESENT" || rawStatus === "ALREADY_PRESENT_EQUIVALENT_HASH")) return { status: "IMPORTED", reason: "Imported successfully and present in target inventory", lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
  return { status: rawStatus, lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
}
