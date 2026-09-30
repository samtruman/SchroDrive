"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadMediaManagerInventory = loadMediaManagerInventory;
const providers_1 = require("../providers");
const migrationExporter_1 = require("./migrationExporter");
const versionManager_1 = require("./versionManager");
function fileKey(file) {
    return `${String(file.path || file.name).trim().toLowerCase()}\u0000${file.size || 0}`;
}
function dedupeFiles(files) {
    const seen = new Set();
    return files.filter((file) => {
        const key = fileKey(file);
        if (!key || seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function normalizeDirectoryFiles(directory) {
    if (!directory?.files?.length)
        return [];
    return dedupeFiles(directory.files.map((file) => ({
        id: String(file.id || file.name),
        name: file.name,
        path: file.name,
        size: file.size,
        selected: true,
    })));
}
function providerItemWithFiles(item, files, source) {
    return {
        ...item,
        files,
        raw: item.raw && typeof item.raw === "object"
            ? { ...item.raw, mediaManagerFileTreeSource: source }
            : { mediaManagerFileTreeSource: source },
    };
}
/**
 * Builds the Media Manager inventory from ProviderItems and their actual media
 * files. File-tree resolution is performed once per provider per scan and the
 * result is reused for every derived fingerprint/version.
 */
async function loadMediaManagerInventory(providers = providers_1.registry.configured(), stats, onProgress) {
    const startedAt = Date.now();
    const metrics = stats?.recoverability || { requested: 0, cacheHits: 0, providerLookups: 0, resolved: 0, unknown: 0 };
    if (stats) {
        stats.providers = providers.length;
        stats.recoverability = metrics;
    }
    const resolved = [];
    const recoverabilityCache = new Map();
    for (const provider of providers) {
        onProgress?.({ phase: "provider_listing", completed: 0 });
        if (stats)
            stats.providerListCalls++;
        const items = await provider.listTorrents();
        if (stats)
            stats.providerItems += items.length;
        onProgress?.({ phase: "provider_listing", completed: items.length, total: items.length });
        if (stats)
            stats.fileTreeFetches++;
        onProgress?.({ phase: "file_tree", completed: 0, total: items.length });
        const directories = await provider.fetchDirectories();
        const directoriesByItem = new Map();
        for (const directory of directories) {
            const key = String(directory.id);
            if (!directoriesByItem.has(key))
                directoriesByItem.set(key, directory);
        }
        for (const [index, item] of items.entries()) {
            await (0, migrationExporter_1.resolveProviderItemRecoverability)(item, provider, recoverabilityCache, metrics);
            onProgress?.({ phase: "identity", completed: index + 1, total: items.length });
            const treeFiles = normalizeDirectoryFiles(directoriesByItem.get(String(item.id)));
            if (treeFiles.length > 0) {
                onProgress?.({ phase: "fingerprint", completed: index + 1, total: items.length });
                if (stats) {
                    stats.fileTreeItems++;
                    stats.mediaFiles += treeFiles.length;
                }
                resolved.push(...(0, versionManager_1.fingerprintTorrent)(providerItemWithFiles(item, treeFiles, "PROVIDER_FILE_TREE"), provider.id));
                continue;
            }
            const inlineFiles = dedupeFiles(Array.isArray(item.files) ? item.files : []);
            if (inlineFiles.length > 0) {
                onProgress?.({ phase: "fingerprint", completed: index + 1, total: items.length });
                if (stats) {
                    stats.inlineFileItems++;
                    stats.mediaFiles += inlineFiles.length;
                }
                resolved.push(...(0, versionManager_1.fingerprintTorrent)(providerItemWithFiles(item, inlineFiles, "INLINE_PROVIDER_FILES"), provider.id));
                continue;
            }
            if (stats)
                stats.nameFallbackItems++;
            onProgress?.({ phase: "fingerprint", completed: index + 1, total: items.length });
            resolved.push(...(0, versionManager_1.fingerprintTorrent)(providerItemWithFiles(item, [], "ITEM_NAME_FALLBACK"), provider.id));
        }
    }
    if (stats) {
        stats.versions = resolved.length;
        stats.durationMs = Date.now() - startedAt;
    }
    return resolved;
}
