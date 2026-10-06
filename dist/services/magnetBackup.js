"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.magnetBackupDirectory = magnetBackupDirectory;
exports.createMagnetBackup = createMagnetBackup;
exports.listMagnetBackups = listMagnetBackups;
exports.readMagnetBackup = readMagnetBackup;
exports.verifyMagnetBackup = verifyMagnetBackup;
exports.getMagnetBackupSchedule = getMagnetBackupSchedule;
exports.saveMagnetBackupSchedule = saveMagnetBackupSchedule;
exports.deleteMagnetBackup = deleteMagnetBackup;
exports.applyMagnetBackupRetention = applyMagnetBackupRetention;
exports.runMagnetBackupSchedulerTick = runMagnetBackupSchedulerTick;
exports.startMagnetBackupScheduler = startMagnetBackupScheduler;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("../core/config");
const providers_1 = require("../providers");
const migrationExporter_1 = require("./migrationExporter");
const defaultRoot = () => node_path_1.default.join(config_1.config.dataDir, "magnet-backups");
const settingsPath = () => node_path_1.default.join(config_1.config.dataDir, "magnet-backup-settings.json");
function configuredStorageDirectory() {
    try {
        const value = JSON.parse(node_fs_1.default.readFileSync(settingsPath(), "utf8"))?.storageDirectory;
        return typeof value === "string" && node_path_1.default.isAbsolute(value) ? node_path_1.default.normalize(value) : defaultRoot();
    }
    catch {
        return defaultRoot();
    }
}
function root() { return configuredStorageDirectory(); }
function magnetBackupDirectory() { return root(); }
function indexPath() { return node_path_1.default.join(root(), "index.json"); }
function legacySchedulePath() { return node_path_1.default.join(defaultRoot(), "schedule.json"); }
function readIndex() { try {
    return JSON.parse(node_fs_1.default.readFileSync(indexPath(), "utf8"));
}
catch {
    return [];
} }
function atomicWrite(file, value) { node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; node_fs_1.default.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); node_fs_1.default.renameSync(temporary, file); }
function digest(value) { return node_crypto_1.default.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function itemKey(item) { return (item.infoHash || item.providerItemId).toLowerCase(); }
async function sourceManifest(provider) { const inventory = await provider.listTorrents(); const withFiles = provider.getTorrentFileTree ? await Promise.all(inventory.map(async (item) => ({ ...item, files: await provider.getTorrentFileTree(item.id) }))) : inventory; return (0, migrationExporter_1.exportMigrationLibrary)(withFiles, [], { mode: "FULL_LIBRARY", sourceProvider: provider.id }).manifest; }
function mapItems(manifest) { return new Map(manifest.items.map((item) => [itemKey(item), item])); }
async function createMagnetBackup(providerId, mode = "FULL") {
    const provider = providers_1.registry.get(providerId);
    if (!provider || !provider.isConfigured())
        throw new Error("Source provider is not configured");
    const manifest = await sourceManifest(provider);
    const now = new Date().toISOString();
    const id = `magnet-backup-${Date.now()}`;
    const records = readIndex();
    const previous = records.filter((record) => record.provider === provider.id && record.mode === "FULL").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    let document = { schemaVersion: "1.0", kind: "MAGNET_BACKUP", mode, provider: provider.id, createdAt: now, manifest };
    let added = manifest.items.length;
    let modified = 0;
    let removed = 0;
    if (mode === "INCREMENTAL" && previous) {
        const oldDocument = readMagnetBackup(previous.id);
        const oldItems = oldDocument?.manifest ? mapItems(oldDocument.manifest) : new Map();
        const current = mapItems(manifest);
        const changes = { added: [], modified: [], removed: [] };
        for (const [key, item] of current) {
            const old = oldItems.get(key);
            if (!old)
                changes.added.push(item);
            else if (digest(old) !== digest(item))
                changes.modified.push(item);
        }
        for (const [key, item] of oldItems)
            if (!current.has(key))
                changes.removed.push(item);
        added = changes.added.length;
        modified = changes.modified.length;
        removed = changes.removed.length;
        document = { schemaVersion: "1.0", kind: "MAGNET_BACKUP", mode, provider: provider.id, createdAt: now, baseBackupId: previous.id, changes };
    }
    const file = node_path_1.default.join(root(), `${id}.json`);
    const content = JSON.stringify(document, null, 2);
    const sha256 = node_crypto_1.default.createHash("sha256").update(content).digest("hex");
    atomicWrite(file, document);
    const record = { id, mode, provider: provider.id, createdAt: now, itemCount: manifest.items.length, magnetCount: manifest.magnetCount, sha256, file, baseBackupId: document.baseBackupId, added, modified, removed, valid: true };
    atomicWrite(indexPath(), [record, ...records].slice(0, 1000));
    return record;
}
function listMagnetBackups(providerId) { return readIndex().filter((record) => !providerId || record.provider === providerId).map((record) => ({ ...record, file: node_path_1.default.basename(record.file) })); }
function readMagnetBackup(id) { const record = readIndex().find((item) => item.id === id); if (!record)
    return undefined; try {
    return JSON.parse(node_fs_1.default.readFileSync(record.file, "utf8"));
}
catch {
    return undefined;
} }
function verifyMagnetBackup(id) { const record = readIndex().find((item) => item.id === id); if (!record)
    return { valid: false, reason: "Backup not found" }; try {
    const sha256 = node_crypto_1.default.createHash("sha256").update(node_fs_1.default.readFileSync(record.file)).digest("hex");
    return sha256 === record.sha256 ? { valid: true, sha256 } : { valid: false, sha256, reason: "Manifest checksum mismatch" };
}
catch {
    return { valid: false, reason: "Manifest unavailable" };
} }
function configuredCronTime() {
    const fields = config_1.config.magnetBackupSchedule.trim().split(/\s+/);
    if (fields.length < 2 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]))
        return "03:00";
    const minute = Math.max(0, Math.min(59, Number(fields[0])));
    const hour = Math.max(0, Math.min(23, Number(fields[1])));
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
function defaultSchedule() { return { enabled: config_1.config.magnetBackupEnabled, provider: "", mode: "FULL", frequency: "DAILY", time: configuredCronTime(), weekday: 0, timezone: config_1.config.magnetBackupTimezone, keepLatest: config_1.config.magnetBackupDailyRetention, keepMonthly: config_1.config.magnetBackupMonthlyRetention, storageDirectory: defaultRoot(), updatedAt: new Date().toISOString() }; }
function normalizeSchedule(value, previous = defaultSchedule()) {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.time || "")) ? String(value.time) : previous.time;
    const timezone = String(value.timezone || previous.timezone || "Europe/Rome");
    try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    }
    catch {
        throw new Error("Invalid backup timezone");
    }
    const storageDirectory = node_path_1.default.normalize(String(value.storageDirectory || previous.storageDirectory || defaultRoot()).trim());
    if (!node_path_1.default.isAbsolute(storageDirectory))
        throw new Error("Backup folder must be an absolute server path");
    return { ...previous, enabled: value.enabled === true, provider: String(value.provider ?? previous.provider).trim().toLowerCase(), mode: value.mode === "INCREMENTAL" ? "INCREMENTAL" : "FULL", frequency: value.frequency === "WEEKLY" ? "WEEKLY" : "DAILY", time, weekday: Math.max(0, Math.min(6, Number(value.weekday ?? previous.weekday) || 0)), timezone, keepLatest: Math.max(1, Math.min(1000, Number(value.keepLatest ?? previous.keepLatest) || 1)), keepMonthly: Math.max(0, Math.min(120, Number(value.keepMonthly ?? previous.keepMonthly) || 0)), storageDirectory, updatedAt: value.updatedAt || previous.updatedAt || new Date().toISOString(), lastRunAt: Object.prototype.hasOwnProperty.call(value, "lastRunAt") ? value.lastRunAt : previous.lastRunAt, lastStatus: Object.prototype.hasOwnProperty.call(value, "lastStatus") ? value.lastStatus : previous.lastStatus, lastError: Object.prototype.hasOwnProperty.call(value, "lastError") ? value.lastError : previous.lastError };
}
function getMagnetBackupSchedule() { try {
    return normalizeSchedule(JSON.parse(node_fs_1.default.readFileSync(settingsPath(), "utf8")));
}
catch {
    try {
        return normalizeSchedule(JSON.parse(node_fs_1.default.readFileSync(legacySchedulePath(), "utf8")));
    }
    catch {
        return defaultSchedule();
    }
} }
function saveMagnetBackupSchedule(value) { const previous = getMagnetBackupSchedule(); const next = normalizeSchedule({ ...previous, ...value, updatedAt: new Date().toISOString() }, previous); if (next.enabled && !next.provider)
    throw new Error("Select a provider for scheduled backups"); node_fs_1.default.mkdirSync(next.storageDirectory, { recursive: true }); node_fs_1.default.accessSync(next.storageDirectory, node_fs_1.default.constants.R_OK | node_fs_1.default.constants.W_OK); atomicWrite(settingsPath(), next); return next; }
/** Delete one local backup document. A full baseline referenced by an incremental is protected. */
function deleteMagnetBackup(id) {
    const records = readIndex();
    const record = records.find((item) => item.id === id);
    if (!record)
        throw new Error("Backup not found");
    if (records.some((item) => item.baseBackupId === id))
        throw new Error("This full backup is still required by an incremental backup; delete the dependent incremental backup first");
    try {
        node_fs_1.default.unlinkSync(record.file);
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    atomicWrite(indexPath(), records.filter((item) => item.id !== id));
    return { ...record, file: node_path_1.default.basename(record.file) };
}
/** Remove only unreferenced local manifests; provider data is never touched. */
function applyMagnetBackupRetention(providerId) {
    const records = readIndex();
    const schedule = getMagnetBackupSchedule();
    const byProvider = new Map();
    for (const record of records)
        if (!providerId || record.provider === providerId)
            byProvider.set(record.provider, [...(byProvider.get(record.provider) || []), record]);
    const keep = new Set();
    for (const providerRecords of byProvider.values()) {
        const sorted = providerRecords.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        sorted.slice(0, schedule.keepLatest).forEach((record) => keep.add(record.id));
        const monthly = new Map();
        for (const record of sorted) {
            const month = record.createdAt.slice(0, 7);
            if (!monthly.has(month))
                monthly.set(month, record);
        }
        [...monthly.values()].slice(0, schedule.keepMonthly).forEach((record) => keep.add(record.id));
        for (const record of sorted)
            if (record.baseBackupId)
                keep.add(record.baseBackupId);
    }
    const retained = records.filter((record) => !byProvider.has(record.provider) || keep.has(record.id));
    const removable = records.filter((record) => byProvider.has(record.provider) && !keep.has(record.id));
    for (const record of removable) {
        try {
            node_fs_1.default.unlinkSync(record.file);
        }
        catch { /* index remains authoritative */ }
    }
    if (removable.length)
        atomicWrite(indexPath(), retained);
    return { removed: removable.length };
}
let scheduler;
let scheduledRun;
function localScheduleParts(now, timezone) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now); const value = (type) => parts.find((part) => part.type === type)?.value || ""; const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }; return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}`, weekday: weekdays[value("weekday")] ?? 0 }; }
async function runMagnetBackupSchedulerTick(now = new Date()) {
    const schedule = getMagnetBackupSchedule();
    if (!schedule.enabled || scheduledRun)
        return false;
    const current = localScheduleParts(now, schedule.timezone);
    const previous = schedule.lastRunAt ? localScheduleParts(new Date(schedule.lastRunAt), schedule.timezone) : undefined;
    if (current.time !== schedule.time || (schedule.frequency === "WEEKLY" && current.weekday !== schedule.weekday) || previous?.date === current.date)
        return false;
    const provider = providers_1.registry.get(schedule.provider);
    if (!provider || !provider.isConfigured()) {
        saveMagnetBackupSchedule({ lastRunAt: now.toISOString(), lastStatus: "FAILED", lastError: "Scheduled provider is not configured" });
        return false;
    }
    scheduledRun = createMagnetBackup(provider.id, schedule.mode).then(() => { applyMagnetBackupRetention(provider.id); saveMagnetBackupSchedule({ lastRunAt: now.toISOString(), lastStatus: "SUCCESS", lastError: undefined }); }).catch((error) => { saveMagnetBackupSchedule({ lastRunAt: now.toISOString(), lastStatus: "FAILED", lastError: error?.message || "Scheduled backup failed" }); }).finally(() => { scheduledRun = undefined; });
    await scheduledRun;
    return true;
}
function startMagnetBackupScheduler() { if (scheduler)
    return; scheduler = setInterval(() => { void runMagnetBackupSchedulerTick(); }, 60000); scheduler.unref?.(); }
