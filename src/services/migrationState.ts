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

/** Reconciles raw provider state with durable outcomes such as legal rejection. */
export function effectiveMigrationStatus(rawStatus: ImportPlanStatus, audit?: MigrationStateAuditLike): EffectiveMigrationStatus {
  if (!audit) return { status: rawStatus };
  if (audit.executionStatus === "REJECTED_LEGAL") return { status: "REJECTED_LEGAL", reason: audit.reason || "LEGAL_RESTRICTION", lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
  if (audit.executionStatus === "FAILED_PERMANENT") return { status: "FAILED_PERMANENT", reason: audit.reason || "Permanent import failure", lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
  if (audit.executionStatus === "FAILED_RETRYABLE_EXHAUSTED") return { status: "RETRY_EXHAUSTED", reason: audit.reason || "Retryable import failure exhausted", lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
  if (audit.executionStatus === "IMPORTED" && (rawStatus === "ALREADY_PRESENT" || rawStatus === "ALREADY_PRESENT_EQUIVALENT_HASH")) return { status: "IMPORTED", reason: "Imported successfully and present in target inventory", lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
  return { status: rawStatus, lastAttempt: audit.createdAt, targetProviderItemId: audit.targetProviderItemId };
}
