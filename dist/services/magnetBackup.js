"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMagnetBackup = createMagnetBackup;
exports.listMagnetBackups = listMagnetBackups;
exports.readMagnetBackup = readMagnetBackup;
exports.verifyMagnetBackup = verifyMagnetBackup;
exports.applyMagnetBackupRetention = applyMagnetBackupRetention;
exports.startMagnetBackupScheduler = startMagnetBackupScheduler;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("../core/config");
const providers_1 = require("../providers");
const migrationExporter_1 = require("./migrationExporter");
function root() { return node_path_1.default.join(config_1.config.dataDir, "magnet-backups"); }
function indexPath() { return node_path_1.default.join(root(), "index.json"); }
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
function cronTime() {
    const fields = config_1.config.magnetBackupSchedule.trim().split(/\s+/);
    if (fields.length < 2 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]))
        return "03:00";
    const minute = Math.max(0, Math.min(59, Number(fields[0])));
    const hour = Math.max(0, Math.min(23, Number(fields[1])));
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
/** Remove only unreferenced local manifests; provider data is never touched. */
function applyMagnetBackupRetention(providerId) {
    const records = readIndex();
    const byProvider = new Map();
    for (const record of records)
        if (!providerId || record.provider === providerId)
            byProvider.set(record.provider, [...(byProvider.get(record.provider) || []), record]);
    const keep = new Set();
    for (const providerRecords of byProvider.values()) {
        const sorted = providerRecords.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        sorted.slice(0, Math.max(0, config_1.config.magnetBackupDailyRetention)).forEach((record) => keep.add(record.id));
        const monthly = new Map();
        for (const record of sorted) {
            const month = record.createdAt.slice(0, 7);
            if (!monthly.has(month))
                monthly.set(month, record);
        }
        [...monthly.values()].slice(0, Math.max(0, config_1.config.magnetBackupMonthlyRetention)).forEach((record) => keep.add(record.id));
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
let lastScheduledKey = "";
let scheduledRun;
function startMagnetBackupScheduler() { if (!config_1.config.magnetBackupEnabled || scheduler)
    return; scheduler = setInterval(async () => { const now = new Date(); const parts = new Intl.DateTimeFormat("en-CA", { timeZone: config_1.config.magnetBackupTimezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now); const time = `${parts.find((part) => part.type === "hour")?.value}:${parts.find((part) => part.type === "minute")?.value}`; const key = now.toISOString().slice(0, 10); if (time !== cronTime() || key === lastScheduledKey || scheduledRun)
    return; lastScheduledKey = key; const provider = providers_1.registry.configured()[0]; if (!provider)
    return; scheduledRun = createMagnetBackup(provider.id, "FULL").then(() => { applyMagnetBackupRetention(provider.id); }).catch(() => { }).finally(() => { scheduledRun = undefined; }); await scheduledRun; }, 60000); }
