"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRecoverableManifestItem = getRecoverableManifestItem;
exports.executeMigrationImportItem = executeMigrationImportItem;
exports.migrationAuditOutcome = migrationAuditOutcome;
exports.executeMigrationImportBulk = executeMigrationImportBulk;
exports.analyzeMigrationImport = analyzeMigrationImport;
const migrationExporter_1 = require("./migrationExporter");
const utils_1 = require("../core/utils");
function emptyCounts() {
    return {
        ALREADY_PRESENT: 0, ALREADY_PRESENT_EQUIVALENT_HASH: 0, READY_TO_IMPORT: 0,
        INVALID_MAGNET: 0, MISSING_HASH: 0, UNSUPPORTED: 0, CONFLICT: 0, REVIEW: 0,
    };
}
function hashFromMagnet(value) {
    if (typeof value !== "string" || !value.trim().toLowerCase().startsWith("magnet:?"))
        return undefined;
    const match = value.match(/[?&]xt=urn:btih:([^&]+)/i);
    if (!match)
        return undefined;
    const raw = match[1];
    const hex = (0, migrationExporter_1.canonicalInfoHash)(raw);
    if (hex)
        return hex;
    if (!/^[a-z2-7]{32}$/i.test(raw))
        return undefined;
    return (0, migrationExporter_1.canonicalInfoHash)((0, utils_1.base32ToHex)(raw) || undefined);
}
function manifestHash(item) {
    const explicit = item?.canonicalInfohash ?? item?.infoHash;
    if (explicit !== undefined)
        return { hash: (0, migrationExporter_1.canonicalInfoHash)(String(explicit)), invalid: true };
    const magnet = item?.canonicalMagnet ?? item?.magnetUri;
    if (magnet === undefined)
        return { invalid: false };
    return { hash: hashFromMagnet(magnet), invalid: true };
}
function getRecoverableManifestItem(item) {
    const extracted = manifestHash(item);
    if (!extracted.hash)
        return undefined;
    return { infoHash: extracted.hash, magnetUri: `magnet:?xt=urn:btih:${extracted.hash}` };
}
async function executeMigrationImportItem(item, provider) {
    const recoverable = getRecoverableManifestItem(item);
    if (!recoverable)
        throw new Error("Migration item is not recoverable");
    const result = await provider.addMagnet(recoverable.magnetUri, typeof item?.originalName === "string" ? item.originalName : undefined);
    return { providerItemId: String(result.id || ""), ...recoverable };
}
function migrationAuditOutcome(reconciliationStatus, targetProviderItemId) {
    return { executionStatus: "IMPORTED", importExecuted: true, reconciliationStatus, targetProviderItemId };
}
function retryableImportError(error) {
    const status = Number(error?.response?.status ?? error?.status);
    if ([400, 401, 403, 451].includes(status))
        return false;
    const message = String(error?.message || error || "").toLowerCase();
    return status === 408 || status === 429 || status >= 500 || /timeout|timed out|network|econn|temporar|rate limit|rate limited|too many requests|retry in \d/.test(message);
}
function importErrorStatus(error) {
    const status = Number(error?.response?.status ?? error?.status);
    return Number.isFinite(status) && status > 0 ? status : undefined;
}
function systemicImportError(error, status) {
    if (status === 401 || status === 403 || (status !== undefined && status >= 500))
        return true;
    const message = String(error?.message || error || "").toLowerCase();
    return /econnrefused|enotfound|econnreset|network unavailable/.test(message);
}
function retryDelayMs(error, attempt) {
    const message = String(error?.message || error || "");
    const seconds = message.match(/retry in\s+(\d+(?:\.\d+)?)s/i)?.[1];
    if (seconds)
        return Math.min(60000, Math.max(1000, Math.ceil(Number(seconds) * 1000)));
    return Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1));
}
/**
 * Executes only the READY items supplied by the current ImportPlan. The
 * target inventory is refreshed immediately before every item, so rerunning
 * after interruption is naturally idempotent and resumable.
 */
async function executeMigrationImportBulk(items, provider, options) {
    const started = Date.now();
    const ready = items.filter((item) => item.status === "READY_TO_IMPORT");
    const result = { total: ready.length, imported: 0, skipped: 0, failed: 0, rejectedLegal: 0, failedPermanent: 0, retryExhausted: 0, results: [] };
    let processed = 0;
    let retrying = 0;
    const emit = (currentInfoHash) => options.onProgress?.({ total: result.total, processed, imported: result.imported, skipped: result.skipped, failed: result.failed, rejectedLegal: result.rejectedLegal, failedPermanent: result.failedPermanent, retryExhausted: result.retryExhausted, retrying, remaining: result.total - processed, elapsedMs: Date.now() - started, currentInfoHash });
    for (const item of ready) {
        const currentInfoHash = item.infoHash;
        emit(currentInfoHash);
        if (!provider.isConfigured())
            throw new Error("Target provider became unavailable during bulk import");
        const currentPlan = analyzeMigrationImport({ manifest: { schemaVersion: "1.0", items: [item] } }, await options.targetInventory());
        const current = currentPlan.items[0];
        if (!current || current.status !== "READY_TO_IMPORT") {
            result.skipped++;
            result.results.push({ infoHash: currentInfoHash, status: current?.status === "ALREADY_PRESENT" || current?.status === "ALREADY_PRESENT_EQUIVALENT_HASH" ? "SKIPPED_ALREADY_PRESENT" : "SKIPPED_NOT_READY", reason: current?.reason || "Item is no longer READY_TO_IMPORT" });
            processed++;
            emit(currentInfoHash);
            continue;
        }
        const maxAttempts = options.maxAttempts ?? 3;
        let succeeded = false;
        let lastError = "";
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const added = await executeMigrationImportItem(item, provider);
                result.imported++;
                result.results.push({ infoHash: added.infoHash, status: "IMPORTED", providerItemId: added.providerItemId, attempts: attempt });
                succeeded = true;
                break;
            }
            catch (error) {
                lastError = error?.message || String(error);
                const status = importErrorStatus(error);
                if (status === 451) {
                    result.failed++;
                    result.rejectedLegal++;
                    result.results.push({ infoHash: currentInfoHash, status: "REJECTED_LEGAL", reason: "LEGAL_RESTRICTION", attempts: attempt, retryCount: 0, importExecuted: true });
                    succeeded = true;
                    break;
                }
                if (!retryableImportError(error) || attempt >= maxAttempts) {
                    if (systemicImportError(error, status)) {
                        result.systemicFailure = { status, reason: lastError };
                        break;
                    }
                    result.failed++;
                    result.failedPermanent++;
                    result.results.push({ infoHash: currentInfoHash, status: "FAILED_PERMANENT", reason: lastError, attempts: attempt, retryCount: Math.max(0, attempt - 1), importExecuted: true });
                    succeeded = true;
                    break;
                }
                retrying++;
                emit(currentInfoHash);
                await (options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(retryDelayMs(error, attempt));
                retrying--;
            }
        }
        if (result.systemicFailure)
            break;
        if (!succeeded) {
            result.failed++;
            result.retryExhausted++;
            result.results.push({ infoHash: currentInfoHash, status: "FAILED_RETRYABLE_EXHAUSTED", reason: lastError, attempts: maxAttempts, retryCount: Math.max(0, maxAttempts - 1), importExecuted: true });
        }
        processed++;
        emit(currentInfoHash);
    }
    return result;
}
function inventoryHashes(inventory) {
    const result = new Map();
    for (const item of inventory) {
        const hash = torrentInfoHash(item);
        if (!hash)
            continue;
        const entries = result.get(hash) || [];
        entries.push(item);
        result.set(hash, entries);
    }
    return result;
}
function torrentInfoHash(item) {
    const direct = (0, migrationExporter_1.canonicalInfoHash)(item.infoHash) || hashFromMagnet(item.magnetUri);
    if (direct)
        return direct;
    const find = (value) => {
        if (!value || typeof value !== "object")
            return undefined;
        for (const [key, nested] of Object.entries(value)) {
            if (/^(infohash|info_hash|hash|hashString)$/i.test(key) && typeof nested === "string") {
                const hash = (0, migrationExporter_1.canonicalInfoHash)(nested) || hashFromMagnet(nested);
                if (hash)
                    return hash;
            }
            const child = find(nested);
            if (child)
                return child;
        }
        return undefined;
    };
    return find(item.raw);
}
function classify(source, index, hash, providerItemId, originalName, inventoryByHash) {
    if (!hash)
        return { source, index, status: "MISSING_HASH", providerItemId, originalName, reason: "No canonical infohash is available" };
    const matches = inventoryByHash.get(hash) || [];
    if (providerItemId && matches.some((item) => String(item.id) === providerItemId))
        return { source, index, status: "ALREADY_PRESENT", providerItemId, infoHash: hash, originalName, reason: "Provider item and infohash already exist" };
    if (matches.length)
        return { source, index, status: "ALREADY_PRESENT_EQUIVALENT_HASH", providerItemId, infoHash: hash, originalName, reason: "An existing provider item has the same infohash" };
    return { source, index, status: "READY_TO_IMPORT", providerItemId, infoHash: hash, originalName, reason: "No matching infohash exists in the current inventory" };
}
function analyzeMigrationImport(input, inventory = []) {
    const hasManifest = input.manifest !== undefined;
    const hasMagnets = typeof input.magnetsText === "string";
    const sourceFormat = hasManifest && hasMagnets ? "MANIFEST_AND_MAGNETS" : hasManifest ? "MANIFEST" : "MAGNETS";
    const plan = { readOnly: true, sourceFormat, items: [], counts: emptyCounts(), errors: [] };
    const byHash = inventoryHashes(inventory);
    const manifestHashes = new Set();
    if (hasManifest) {
        const manifest = input.manifest;
        plan.schemaVersion = typeof manifest?.schemaVersion === "string" ? manifest.schemaVersion : undefined;
        if (!manifest || !Array.isArray(manifest.items))
            plan.errors.push("Manifest must contain an items array");
        else if (manifest.schemaVersion !== "1.0")
            plan.errors.push("Unsupported manifest schema version");
        else
            manifest.items.forEach((item, index) => {
                const extracted = manifestHash(item);
                const row = extracted.invalid && !extracted.hash
                    ? { source: "MANIFEST", index, status: "INVALID_MAGNET", providerItemId: typeof item?.providerItemId === "string" ? item.providerItemId : undefined, originalName: typeof item?.originalName === "string" ? item.originalName : undefined, reason: "Manifest magnet or infohash is invalid" }
                    : classify("MANIFEST", index, extracted.hash, typeof item?.providerItemId === "string" ? item.providerItemId : undefined, typeof item?.originalName === "string" ? item.originalName : undefined, byHash);
                plan.items.push(row);
                if (extracted.hash)
                    manifestHashes.add(extracted.hash);
            });
    }
    if (hasMagnets) {
        const seen = new Set();
        for (const [index, line] of input.magnetsText.split(/\r?\n/).map((value, i) => [i, value.trim()])) {
            if (!line)
                continue;
            const hash = hashFromMagnet(line);
            // When both formats are supplied, manifest records are authoritative
            // item records and magnets.txt is only their portable fallback. Do not
            // count the same ProviderItem/hash twice.
            if (hash && manifestHashes.has(hash))
                continue;
            if (hash && seen.has(hash))
                continue;
            if (hash)
                seen.add(hash);
            plan.items.push(hash ? classify("MAGNETS", index, hash, undefined, undefined, byHash) : { source: "MAGNETS", index, status: "INVALID_MAGNET", reason: "Line is not a valid magnet with a supported btih" });
        }
    }
    for (const item of plan.items)
        plan.counts[item.status]++;
    return plan;
}
