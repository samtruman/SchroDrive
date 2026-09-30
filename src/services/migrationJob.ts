import { getDb, recordMigrationAudit } from "../core/db";
import { registry } from "../providers";
import { executeMigrationImportBulk, migrationAuditOutcome, type BulkImportResult, type ImportPlanItem } from "./migrationImporter";

export type MigrationJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
export interface MigrationJob {
  id: string;
  status: MigrationJobStatus;
  sourceProvider: string;
  targetProvider: string;
  total: number;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
  result?: BulkImportResult;
}

let initialised = false;
let active = new Set<string>();

function ensureTable(): void {
  if (initialised) return;
  getDb().exec(`CREATE TABLE IF NOT EXISTS media_manager_migration_jobs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, source_provider TEXT NOT NULL,
    target_provider TEXT NOT NULL, total INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
    imported INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT, error TEXT, result_json TEXT
  )`);
  getDb().prepare("UPDATE media_manager_migration_jobs SET status='FAILED', error='Migration interrupted by process restart', updated_at=? WHERE status IN ('QUEUED','RUNNING')").run(new Date().toISOString());
  initialised = true;
}
function map(row: any): MigrationJob {
  return { id: row.id, status: row.status, sourceProvider: row.source_provider, targetProvider: row.target_provider, total: row.total, processed: row.processed, imported: row.imported, skipped: row.skipped, failed: row.failed, startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at || undefined, error: row.error || undefined, result: row.result_json ? JSON.parse(row.result_json) : undefined };
}
function save(job: MigrationJob): void {
  ensureTable();
  getDb().prepare(`UPDATE media_manager_migration_jobs SET status=?, processed=?, imported=?, skipped=?, failed=?, updated_at=?, finished_at=?, error=?, result_json=? WHERE id=?`).run(job.status, job.processed, job.imported, job.skipped, job.failed, job.updatedAt, job.finishedAt || null, job.error || null, job.result ? JSON.stringify(job.result) : null, job.id);
}
export function listMigrationJobs(limit = 50): MigrationJob[] { ensureTable(); return (getDb().prepare("SELECT * FROM media_manager_migration_jobs ORDER BY started_at DESC LIMIT ?").all(limit) as any[]).map(map); }
export function getMigrationJob(id: string): MigrationJob | undefined { ensureTable(); const row = getDb().prepare("SELECT * FROM media_manager_migration_jobs WHERE id=?").get(id) as any; return row ? map(row) : undefined; }

export function startMigrationJob(sourceProvider: string, targetProvider: string, items: ImportPlanItem[]): MigrationJob {
  ensureTable();
  const target = registry.get(targetProvider);
  if (!target || !target.isConfigured()) throw new Error("Target provider is not configured");
  if (!items.length) throw new Error("Migration preview contains no selected items");
  const existing = listMigrationJobs().find((job) => active.has(job.id) || job.status === "QUEUED" || job.status === "RUNNING");
  if (existing && existing.sourceProvider === sourceProvider && existing.targetProvider === targetProvider) return existing;
  const now = new Date().toISOString();
  const job: MigrationJob = { id: `migration-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: "QUEUED", sourceProvider, targetProvider, total: items.length, processed: 0, imported: 0, skipped: 0, failed: 0, startedAt: now, updatedAt: now };
  getDb().prepare(`INSERT INTO media_manager_migration_jobs (id,status,source_provider,target_provider,total,started_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(job.id, job.status, sourceProvider, targetProvider, job.total, now, now);
  void execute(job, items);
  return job;
}

async function execute(job: MigrationJob, items: ImportPlanItem[]): Promise<void> {
  const target = registry.get(job.targetProvider);
  if (!target) return;
  active.add(job.id);
  job.status = "RUNNING"; job.updatedAt = new Date().toISOString(); save(job);
  try {
    const result = await executeMigrationImportBulk(items, target, {
      targetInventory: () => target.listTorrents(),
      onProgress: (progress) => { job.processed = progress.processed; job.imported = progress.imported; job.skipped = progress.skipped; job.failed = progress.failed; job.updatedAt = new Date().toISOString(); save(job); },
    });
    for (const item of result.results) if (item.infoHash) {
      const outcome = migrationAuditOutcome(item.status === "SKIPPED_ALREADY_PRESENT" ? "ALREADY_PRESENT" : "READY_TO_IMPORT", item.providerItemId || "");
      recordMigrationAudit({ sourceProvider: job.sourceProvider, targetProvider: job.targetProvider, infoHash: item.infoHash, initialStatus: "READY_TO_IMPORT", revalidationStatus: outcome.reconciliationStatus, executionStatus: outcome.executionStatus, targetProviderItemId: outcome.targetProviderItemId, reason: item.reason, retryCount: item.retryCount, importExecuted: item.importExecuted });
    }
    job.result = result; job.status = result.systemicFailure || result.failed > 0 ? "PARTIAL" : "COMPLETED";
  } catch (error: any) { job.status = "FAILED"; job.error = error?.message || "Migration failed"; }
  job.finishedAt = new Date().toISOString(); job.updatedAt = job.finishedAt; save(job); active.delete(job.id);
}
