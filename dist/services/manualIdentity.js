"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.identityOverrideKey = identityOverrideKey;
exports.saveManualIdentityOverride = saveManualIdentityOverride;
exports.clearManualIdentityOverride = clearManualIdentityOverride;
exports.getManualIdentityOverride = getManualIdentityOverride;
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
function saveManualIdentityOverride(identity, override) {
    const key = identityOverrideKey(identity);
    (0, db_1.getDb)().prepare("INSERT OR REPLACE INTO version_manager_identity_overrides (identity_key, override_json, updated_at) VALUES (?, ?, ?)")
        .run(key, JSON.stringify(override), new Date().toISOString());
    return key;
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
    return versions.map((version) => {
        const override = getManualIdentityOverride(version.fingerprint.identity);
        return override ? { ...version, fingerprint: { ...version.fingerprint, identity: applyManualIdentityOverride(version.fingerprint.identity, override) } } : version;
    });
}
function manualOverrideFromReview(value) {
    return { ...value };
}
