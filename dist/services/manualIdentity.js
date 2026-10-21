"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.identityOverrideKey = identityOverrideKey;
exports.sourceOverrideKey = sourceOverrideKey;
exports.saveManualIdentityOverrideForSource = saveManualIdentityOverrideForSource;
exports.clearManualIdentityOverrideForSource = clearManualIdentityOverrideForSource;
exports.saveManualIdentityOverride = saveManualIdentityOverride;
exports.saveManualIdentityOverrideForVersion = saveManualIdentityOverrideForVersion;
exports.clearManualIdentityOverrideForVersion = clearManualIdentityOverrideForVersion;
exports.clearManualIdentityOverride = clearManualIdentityOverride;
exports.getManualIdentityOverride = getManualIdentityOverride;
exports.getManualIdentityOverrideForProviderSource = getManualIdentityOverrideForProviderSource;
exports.applyManualIdentityOverride = applyManualIdentityOverride;
exports.applyManualIdentityOverrides = applyManualIdentityOverrides;
exports.manualOverrideFromReview = manualOverrideFromReview;
const db_1 = require("../core/db");
const mediaParser_1 = require("./mediaParser");
function identityOverrideKey(identity) {
    const kind = identity.kind === "anime-episode" ? "episode" : identity.kind || "unknown";
    return [kind, (0, mediaParser_1.normalizeMediaTitle)(identity.title || ""), identity.year || "", identity.season ?? "", identity.episode ?? ""].join(":");
}
function readOverride(row) {
    try {
        return row ? JSON.parse(row.override_json) : undefined;
    }
    catch {
        return undefined;
    }
}
function versionOverrideKey(versionId) {
    return `version:${versionId}`;
}
/** Source key uses the full provider-relative path, never a basename or inferred title. */
function sourceOverrideKey(provider, sourcePath) {
    if (!provider || !sourcePath)
        return undefined;
    const normalized = sourcePath.replace(/\\/g, "/");
    const marker = `/${provider.toLowerCase()}/`;
    const markerIndex = normalized.toLowerCase().indexOf(marker);
    let relative = markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
    if (markerIndex >= 0)
        relative = relative.replace(/^(?:__all__|shows|movies)\//i, "");
    else if (relative.startsWith("/"))
        return undefined;
    if (!relative || relative.split("/").some((part) => part === ".."))
        return undefined;
    return `source:${provider.toLowerCase()}:${relative}`;
}
function saveManualIdentityOverrideForSource(provider, sourcePath, override) {
    const key = sourceOverrideKey(provider, sourcePath);
    if (!key)
        throw new Error("Provider source path cannot be identified safely");
    return saveOverrideByKey(key, override);
}
function clearManualIdentityOverrideForSource(provider, sourcePath) {
    const key = sourceOverrideKey(provider, sourcePath);
    if (key)
        (0, db_1.getDb)().prepare("DELETE FROM version_manager_identity_overrides WHERE identity_key = ?").run(key);
}
function saveOverrideByKey(key, override) {
    (0, db_1.getDb)().prepare("INSERT OR REPLACE INTO version_manager_identity_overrides (identity_key, override_json, updated_at) VALUES (?, ?, ?)")
        .run(key, JSON.stringify(override), new Date().toISOString());
    return key;
}
function saveManualIdentityOverride(identity, override) {
    return saveOverrideByKey(identityOverrideKey(identity), override);
}
function saveManualIdentityOverrideForVersion(versionId, override) {
    return saveOverrideByKey(versionOverrideKey(versionId), override);
}
function clearManualIdentityOverrideForVersion(versionId) {
    (0, db_1.getDb)().prepare("DELETE FROM version_manager_identity_overrides WHERE identity_key = ?").run(versionOverrideKey(versionId));
}
function clearManualIdentityOverride(identity) {
    const database = (0, db_1.getDb)();
    const directKey = identityOverrideKey(identity);
    database.prepare("DELETE FROM version_manager_identity_overrides WHERE identity_key = ?").run(directKey);
    const rows = database.prepare("SELECT identity_key, override_json FROM version_manager_identity_overrides").all();
    for (const row of rows) {
        const override = readOverride(row);
        if (identity.tmdbId && override?.tmdbId === identity.tmdbId)
            database.prepare("DELETE FROM version_manager_identity_overrides WHERE identity_key = ?").run(row.identity_key);
    }
}
function getManualIdentityOverride(identity) {
    return readOverride((0, db_1.getDb)().prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key = ?").get(identityOverrideKey(identity)));
}
/**
 * Resolves a manual identity for provider reconciliation. Source overrides are
 * authoritative; the unique title-compatible override is only a fallback for
 * release files whose embedded year/title differs from the resolved identity.
 */
function getManualIdentityOverrideForProviderSource(provider, sourcePath, identity) {
    const database = (0, db_1.getDb)();
    const sourceKey = sourceOverrideKey(provider, sourcePath);
    if (sourceKey) {
        const sourceOverride = readOverride(database.prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key = ?").get(sourceKey));
        if (sourceOverride)
            return sourceOverride;
    }
    const direct = getManualIdentityOverride(identity);
    if (direct)
        return direct;
    const title = (0, mediaParser_1.normalizeMediaTitle)(identity.title || "");
    if (!title || identity.kind !== "movie")
        return undefined;
    const candidates = database.prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key NOT LIKE 'version:%' AND identity_key NOT LIKE 'source:%'").all()
        .map((row) => readOverride(row))
        .filter((override) => Boolean(override?.tmdbId && (override.kind || "movie") === "movie"))
        .filter((override) => {
        const candidateTitles = [override.title, override.originalTitle].filter(Boolean).map((value) => (0, mediaParser_1.normalizeMediaTitle)(String(value)));
        return candidateTitles.some((candidate) => candidate && (title.includes(candidate) || candidate.includes(title)));
    });
    return candidates.length === 1 ? candidates[0] : undefined;
}
function applyManualIdentityOverride(identity, override) {
    const title = override.title || identity.title;
    return {
        ...identity,
        ...(override.tmdbId ? { tmdbId: override.tmdbId } : {}),
        ...(override.imdbId ? { imdbId: override.imdbId } : {}),
        ...(override.tvdbId ? { tvdbId: override.tvdbId } : {}),
        ...(title ? { title, normalizedTitle: (0, mediaParser_1.normalizeMediaTitle)(title) } : {}),
        ...(override.originalTitle ? { originalTitle: override.originalTitle } : {}),
        ...(override.year !== undefined ? { year: override.year } : {}),
        ...(override.kind ? { kind: override.kind } : {}),
        ...(override.season !== undefined ? { season: override.season } : {}),
        ...(override.episode !== undefined ? { episode: override.episode } : {}),
        ...(override.originalLanguage ? { originalLanguage: override.originalLanguage } : {}),
        confidence: 1,
        source: "manual",
        resolutionStatus: "resolved",
        provenance: {
            ...(identity.provenance || {}),
            ...(override.tmdbId ? { tmdbId: "MANUAL" } : {}),
            ...(override.title ? { title: "MANUAL", normalizedTitle: "MANUAL" } : {}),
            ...(override.year !== undefined ? { year: "MANUAL" } : {}),
            ...(override.originalLanguage ? { originalLanguage: "MANUAL" } : {}),
        },
    };
}
function applyManualIdentityOverrides(versions) {
    const database = (0, db_1.getDb)();
    return versions.map((version) => {
        const versionOverride = readOverride(database.prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key = ?").get(versionOverrideKey(version.id)));
        const storage = version.fingerprint.storage;
        const sourceKey = sourceOverrideKey(storage.provider, storage.path);
        const sourceOverride = sourceKey ? readOverride(database.prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key = ?").get(sourceKey)) : undefined;
        const override = versionOverride || sourceOverride || getManualIdentityOverride(version.fingerprint.identity);
        return override ? { ...version, fingerprint: { ...version.fingerprint, identity: applyManualIdentityOverride(version.fingerprint.identity, override) } } : version;
    });
}
function manualOverrideFromReview(value) {
    return { ...value };
}
