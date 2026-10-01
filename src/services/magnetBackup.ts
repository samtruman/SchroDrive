import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../core/config";
import { registry, type DebridProvider } from "../providers";
import { exportMigrationLibrary, type MigrationManifest } from "./migrationExporter";

export type MagnetBackupMode = "FULL" | "INCREMENTAL";
export interface MagnetBackupRecord { id: string; mode: MagnetBackupMode; provider: string; createdAt: string; itemCount: number; magnetCount: number; sha256: string; file: string; baseBackupId?: string; added: number; modified: number; removed: number; valid: boolean; }
export interface MagnetBackupDocument { schemaVersion: "1.0"; kind: "MAGNET_BACKUP"; mode: MagnetBackupMode; provider: string; createdAt: string; baseBackupId?: string; manifest?: MigrationManifest; changes?: { added: MigrationManifest["items"]; modified: MigrationManifest["items"]; removed: MigrationManifest["items"] }; }
export interface MagnetBackupSchedule { enabled: boolean; provider: string; mode: MagnetBackupMode; frequency: "DAILY" | "WEEKLY"; time: string; weekday: number; timezone: string; keepLatest: number; keepMonthly: number; storageDirectory: string; updatedAt: string; lastRunAt?: string; lastStatus?: "SUCCESS" | "FAILED"; lastError?: string; }
const defaultRoot = () => path.join(config.dataDir, "magnet-backups");
const settingsPath = () => path.join(config.dataDir, "magnet-backup-settings.json");
function configuredStorageDirectory(): string {
  try { const value = JSON.parse(fs.readFileSync(settingsPath(), "utf8"))?.storageDirectory; return typeof value === "string" && path.isAbsolute(value) ? path.normalize(value) : defaultRoot(); }
  catch { return defaultRoot(); }
}
function root(): string { return configuredStorageDirectory(); }
export function magnetBackupDirectory(): string { return root(); }
function indexPath(): string { return path.join(root(), "index.json"); }
function legacySchedulePath(): string { return path.join(defaultRoot(), "schedule.json"); }
function readIndex(): MagnetBackupRecord[] { try { return JSON.parse(fs.readFileSync(indexPath(), "utf8")) as MagnetBackupRecord[]; } catch { return []; } }
function atomicWrite(file: string, value: unknown): void { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function itemKey(item: { infoHash?: string; providerItemId: string }): string { return (item.infoHash || item.providerItemId).toLowerCase(); }
async function sourceManifest(provider: DebridProvider): Promise<MigrationManifest> { const inventory = await provider.listTorrents(); const withFiles = provider.getTorrentFileTree ? await Promise.all(inventory.map(async (item) => ({ ...item, files: await provider.getTorrentFileTree!(item.id) }))) : inventory; return exportMigrationLibrary(withFiles, [], { mode: "FULL_LIBRARY", sourceProvider: provider.id }).manifest; }
function mapItems(manifest: MigrationManifest): Map<string, MigrationManifest["items"][number]> { return new Map(manifest.items.map((item) => [itemKey(item), item])); }

export async function createMagnetBackup(providerId: string, mode: MagnetBackupMode = "FULL"): Promise<MagnetBackupRecord> {
  const provider = registry.get(providerId); if (!provider || !provider.isConfigured()) throw new Error("Source provider is not configured");
  const manifest = await sourceManifest(provider); const now = new Date().toISOString(); const id = `magnet-backup-${Date.now()}`; const records = readIndex();
  const previous = records.filter((record) => record.provider === provider.id && record.mode === "FULL").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  let document: MagnetBackupDocument = { schemaVersion: "1.0", kind: "MAGNET_BACKUP", mode, provider: provider.id, createdAt: now, manifest }; let added = manifest.items.length; let modified = 0; let removed = 0;
  if (mode === "INCREMENTAL" && previous) { const oldDocument = readMagnetBackup(previous.id); const oldItems = oldDocument?.manifest ? mapItems(oldDocument.manifest) : new Map(); const current = mapItems(manifest); const changes = { added: [] as MigrationManifest["items"], modified: [] as MigrationManifest["items"], removed: [] as MigrationManifest["items"] }; for (const [key, item] of current) { const old = oldItems.get(key); if (!old) changes.added.push(item); else if (digest(old) !== digest(item)) changes.modified.push(item); } for (const [key, item] of oldItems) if (!current.has(key)) changes.removed.push(item); added = changes.added.length; modified = changes.modified.length; removed = changes.removed.length; document = { schemaVersion: "1.0", kind: "MAGNET_BACKUP", mode, provider: provider.id, createdAt: now, baseBackupId: previous.id, changes }; }
  const file = path.join(root(), `${id}.json`); const content = JSON.stringify(document, null, 2); const sha256 = crypto.createHash("sha256").update(content).digest("hex"); atomicWrite(file, document);
  const record: MagnetBackupRecord = { id, mode, provider: provider.id, createdAt: now, itemCount: manifest.items.length, magnetCount: manifest.magnetCount, sha256, file, baseBackupId: document.baseBackupId, added, modified, removed, valid: true }; atomicWrite(indexPath(), [record, ...records].slice(0, 1000)); return record;
}
export function listMagnetBackups(providerId?: string): MagnetBackupRecord[] { return readIndex().filter((record) => !providerId || record.provider === providerId).map((record) => ({ ...record, file: path.basename(record.file) })); }
export function readMagnetBackup(id: string): MagnetBackupDocument | undefined { const record = readIndex().find((item) => item.id === id); if (!record) return undefined; try { return JSON.parse(fs.readFileSync(record.file, "utf8")) as MagnetBackupDocument; } catch { return undefined; } }
export function verifyMagnetBackup(id: string): { valid: boolean; reason?: string; sha256?: string } { const record = readIndex().find((item) => item.id === id); if (!record) return { valid: false, reason: "Backup not found" }; try { const sha256 = crypto.createHash("sha256").update(fs.readFileSync(record.file)).digest("hex"); return sha256 === record.sha256 ? { valid: true, sha256 } : { valid: false, sha256, reason: "Manifest checksum mismatch" }; } catch { return { valid: false, reason: "Manifest unavailable" }; } }
function configuredCronTime(): string {
  const fields = config.magnetBackupSchedule.trim().split(/\s+/);
  if (fields.length < 2 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) return "03:00";
  const minute = Math.max(0, Math.min(59, Number(fields[0])));
  const hour = Math.max(0, Math.min(23, Number(fields[1])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function defaultSchedule(): MagnetBackupSchedule { return { enabled: config.magnetBackupEnabled, provider: "", mode: "FULL", frequency: "DAILY", time: configuredCronTime(), weekday: 0, timezone: config.magnetBackupTimezone, keepLatest: config.magnetBackupDailyRetention, keepMonthly: config.magnetBackupMonthlyRetention, storageDirectory: defaultRoot(), updatedAt: new Date().toISOString() }; }
function normalizeSchedule(value: Partial<MagnetBackupSchedule>, previous = defaultSchedule()): MagnetBackupSchedule {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.time || "")) ? String(value.time) : previous.time;
  const timezone = String(value.timezone || previous.timezone || "Europe/Rome");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new Error("Invalid backup timezone"); }
  const storageDirectory = path.normalize(String(value.storageDirectory || previous.storageDirectory || defaultRoot()).trim());
  if (!path.isAbsolute(storageDirectory)) throw new Error("Backup folder must be an absolute server path");
  return { ...previous, enabled: value.enabled === true, provider: String(value.provider ?? previous.provider).trim().toLowerCase(), mode: value.mode === "INCREMENTAL" ? "INCREMENTAL" : "FULL", frequency: value.frequency === "WEEKLY" ? "WEEKLY" : "DAILY", time, weekday: Math.max(0, Math.min(6, Number(value.weekday ?? previous.weekday) || 0)), timezone, keepLatest: Math.max(1, Math.min(1000, Number(value.keepLatest ?? previous.keepLatest) || 1)), keepMonthly: Math.max(0, Math.min(120, Number(value.keepMonthly ?? previous.keepMonthly) || 0)), storageDirectory, updatedAt: value.updatedAt || previous.updatedAt || new Date().toISOString(), lastRunAt: Object.prototype.hasOwnProperty.call(value, "lastRunAt") ? value.lastRunAt : previous.lastRunAt, lastStatus: Object.prototype.hasOwnProperty.call(value, "lastStatus") ? value.lastStatus : previous.lastStatus, lastError: Object.prototype.hasOwnProperty.call(value, "lastError") ? value.lastError : previous.lastError };
}
export function getMagnetBackupSchedule(): MagnetBackupSchedule { try { return normalizeSchedule(JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as MagnetBackupSchedule); } catch { try { return normalizeSchedule(JSON.parse(fs.readFileSync(legacySchedulePath(), "utf8")) as MagnetBackupSchedule); } catch { return defaultSchedule(); } } }
export function saveMagnetBackupSchedule(value: Partial<MagnetBackupSchedule>): MagnetBackupSchedule { const previous = getMagnetBackupSchedule(); const next = normalizeSchedule({ ...previous, ...value, updatedAt: new Date().toISOString() }, previous); if (next.enabled && !next.provider) throw new Error("Select a provider for scheduled backups"); fs.mkdirSync(next.storageDirectory, { recursive: true }); fs.accessSync(next.storageDirectory, fs.constants.R_OK | fs.constants.W_OK); atomicWrite(settingsPath(), next); return next; }

/** Delete one local backup document. A full baseline referenced by an incremental is protected. */
export function deleteMagnetBackup(id: string): MagnetBackupRecord {
  const records = readIndex(); const record = records.find((item) => item.id === id);
  if (!record) throw new Error("Backup not found");
  if (records.some((item) => item.baseBackupId === id)) throw new Error("This full backup is still required by an incremental backup; delete the dependent incremental backup first");
  try { fs.unlinkSync(record.file); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  atomicWrite(indexPath(), records.filter((item) => item.id !== id));
  return { ...record, file: path.basename(record.file) };
}

/** Remove only unreferenced local manifests; provider data is never touched. */
export function applyMagnetBackupRetention(providerId?: string): { removed: number } {
  const records = readIndex();
  const schedule = getMagnetBackupSchedule();
  const byProvider = new Map<string, MagnetBackupRecord[]>();
  for (const record of records) if (!providerId || record.provider === providerId) byProvider.set(record.provider, [...(byProvider.get(record.provider) || []), record]);
  const keep = new Set<string>();
  for (const providerRecords of byProvider.values()) {
    const sorted = providerRecords.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sorted.slice(0, schedule.keepLatest).forEach((record) => keep.add(record.id));
    const monthly = new Map<string, MagnetBackupRecord>();
    for (const record of sorted) {
      const month = record.createdAt.slice(0, 7);
      if (!monthly.has(month)) monthly.set(month, record);
    }
    [...monthly.values()].slice(0, schedule.keepMonthly).forEach((record) => keep.add(record.id));
    for (const record of sorted) if (record.baseBackupId) keep.add(record.baseBackupId);
  }
  const retained = records.filter((record) => !byProvider.has(record.provider) || keep.has(record.id));
  const removable = records.filter((record) => byProvider.has(record.provider) && !keep.has(record.id));
  for (const record of removable) { try { fs.unlinkSync(record.file); } catch { /* index remains authoritative */ } }
  if (removable.length) atomicWrite(indexPath(), retained);
  return { removed: removable.length };
}

let scheduler: ReturnType<typeof setInterval> | undefined; let scheduledRun: Promise<void> | undefined;
function localScheduleParts(now: Date, timezone: string): { date: string; time: string; weekday: number } { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now); const value = (type: string) => parts.find((part) => part.type === type)?.value || ""; const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }; return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}`, weekday: weekdays[value("weekday")] ?? 0 }; }
export async function runMagnetBackupSchedulerTick(now = new Date()): Promise<boolean> {
  const schedule = getMagnetBackupSchedule(); if (!schedule.enabled || scheduledRun) return false;
  const current = localScheduleParts(now, schedule.timezone); const previous = schedule.lastRunAt ? localScheduleParts(new Date(schedule.lastRunAt), schedule.timezone) : undefined;
  if (current.time !== schedule.time || (schedule.frequency === "WEEKLY" && current.weekday !== schedule.weekday) || previous?.date === current.date) return false;
  const provider = registry.get(schedule.provider); if (!provider || !provider.isConfigured()) { saveMagnetBackupSchedule({ lastRunAt: now.toISOString(), lastStatus: "FAILED", lastError: "Scheduled provider is not configured" }); return false; }
  scheduledRun = createMagnetBackup(provider.id, schedule.mode).then(() => { applyMagnetBackupRetention(provider.id); saveMagnetBackupSchedule({ lastRunAt: now.toISOString(), lastStatus: "SUCCESS", lastError: undefined }); }).catch((error: any) => { saveMagnetBackupSchedule({ lastRunAt: now.toISOString(), lastStatus: "FAILED", lastError: error?.message || "Scheduled backup failed" }); }).finally(() => { scheduledRun = undefined; });
  await scheduledRun; return true;
}
export function startMagnetBackupScheduler(): void { if (scheduler) return; scheduler = setInterval(() => { void runMagnetBackupSchedulerTick(); }, 60_000); scheduler.unref?.(); }
