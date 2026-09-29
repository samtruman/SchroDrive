"use strict";
/** Persistent review queue for Organizer identity decisions. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateReviewOverride = validateReviewOverride;
exports.getOrganizerReview = getOrganizerReview;
exports.recordOrganizerReview = recordOrganizerReview;
exports.listOrganizerReviews = listOrganizerReviews;
exports.filterOrganizerReviewsByParserStatus = filterOrganizerReviewsByParserStatus;
exports.decideOrganizerReview = decideOrganizerReview;
exports.retryOrganizerReview = retryOrganizerReview;
exports.clearOrganizerReviewOverride = clearOrganizerReviewOverride;
exports.clearOrganizerReviews = clearOrganizerReviews;
exports.listOrganizerReviewAudit = listOrganizerReviewAudit;
const db_1 = require("../core/db");
const node_crypto_1 = require("node:crypto");
const manualIdentity_1 = require("./manualIdentity");
function validateReviewOverride(value) {
    if (value == null)
        return undefined;
    if (typeof value !== "object" || Array.isArray(value))
        throw new Error("override must be an object");
    const input = value;
    const result = {};
    if (input.title !== undefined) {
        if (typeof input.title !== "string" || input.title.trim().length < 1 || input.title.length > 300) {
            throw new Error("override.title must be a non-empty string of at most 300 characters");
        }
        result.title = input.title.trim();
    }
    for (const key of ["originalTitle", "tmdbId", "imdbId", "tvdbId", "originalLanguage"]) {
        if (input[key] !== undefined) {
            if (typeof input[key] !== "string" || input[key].trim().length < 1 || input[key].length > 300) {
                throw new Error(`override.${key} must be a non-empty string of at most 300 characters`);
            }
            result[key] = input[key].trim();
        }
    }
    for (const [key, min, max] of [["year", 1800, 2200], ["season", 0, 99], ["episode", 0, 9999]]) {
        if (input[key] !== undefined) {
            if (typeof input[key] !== "number" || !Number.isInteger(input[key]) || input[key] < min || input[key] > max) {
                throw new Error(`override.${key} is outside the supported range`);
            }
            result[key] = input[key];
        }
    }
    if (input.kind !== undefined) {
        if (input.kind !== "movie" && input.kind !== "episode")
            throw new Error("override.kind is invalid");
        result.kind = input.kind;
    }
    if (Object.keys(result).length === 0)
        throw new Error("override must contain a supported field");
    return result;
}
function keyFor(sourcePath) {
    return `review_${(0, node_crypto_1.createHash)("sha256").update(sourcePath, "utf8").digest("hex")}`;
}
/** Returns the persisted review decision for one source path, if present. */
function getOrganizerReview(sourcePath) {
    return listOrganizerReviews(true).find((entry) => entry.id === keyFor(sourcePath));
}
function parseStoredJson(value) {
    if (!value)
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function recordOrganizerReview(sourcePath, parsed) {
    const id = keyFor(sourcePath);
    const now = new Date().toISOString();
    const database = (0, db_1.getDb)();
    const old = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id);
    const oldOverride = parseStoredJson(old?.override_json);
    const entry = old
        ? { id, sourcePath: old.source_path, sourceBasename: old.source_basename, parsed, decision: old.decision, createdAt: old.created_at, updatedAt: now, ...(oldOverride ? { override: oldOverride } : {}) }
        : { id, sourcePath, sourceBasename: parsed.sourceBasename, parsed, decision: "pending", createdAt: now, updatedAt: now };
    database.prepare(`INSERT INTO organizer_reviews
    (id, source_path, source_basename, parsed_json, decision, override_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET parsed_json=excluded.parsed_json, updated_at=excluded.updated_at`).run(entry.id, entry.sourcePath, entry.sourceBasename, JSON.stringify(entry.parsed), entry.decision, entry.override ? JSON.stringify(entry.override) : null, entry.createdAt, entry.updatedAt);
    database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run(id, "recorded", JSON.stringify(parsed), now);
    return entry;
}
function listOrganizerReviews(includeResolved = false, status) {
    const decision = status || (includeResolved ? undefined : "pending");
    const query = decision
        ? "SELECT * FROM organizer_reviews WHERE decision = ? ORDER BY updated_at DESC"
        : "SELECT * FROM organizer_reviews ORDER BY updated_at DESC";
    const rows = (decision ? (0, db_1.getDb)().prepare(query).all(decision) : (0, db_1.getDb)().prepare(query).all());
    return rows.flatMap((row) => {
        const parsed = parseStoredJson(row.parsed_json);
        if (!parsed)
            return [];
        const override = parseStoredJson(row.override_json);
        return [{
                id: row.id, sourcePath: row.source_path, sourceBasename: row.source_basename,
                parsed, decision: row.decision,
                createdAt: row.created_at, updatedAt: row.updated_at,
                ...(override ? { override } : {}),
            }];
    });
}
function filterOrganizerReviewsByParserStatus(entries, status) {
    return status ? entries.filter((entry) => entry.parsed.status === status) : entries;
}
function decideOrganizerReview(id, decision, override) {
    const database = (0, db_1.getDb)();
    const row = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id);
    if (!row)
        return undefined;
    const updatedAt = new Date().toISOString();
    const effectiveOverride = override || parseStoredJson(row.override_json);
    database.prepare("UPDATE organizer_reviews SET decision = ?, override_json = ?, updated_at = ? WHERE id = ?")
        .run(decision, effectiveOverride ? JSON.stringify(effectiveOverride) : null, updatedAt, id);
    if (decision === "accepted" && effectiveOverride) {
        const parsed = parseStoredJson(row.parsed_json);
        if (parsed)
            (0, manualIdentity_1.saveManualIdentityOverride)(parsed, (0, manualIdentity_1.manualOverrideFromReview)(effectiveOverride));
    }
    database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run(id, decision, effectiveOverride ? JSON.stringify(effectiveOverride) : null, updatedAt);
    const updated = {
        id, sourcePath: row.source_path, sourceBasename: row.source_basename,
        parsed: parseStoredJson(row.parsed_json) || { status: "unmatched", extension: "", sourceBasename: row.source_basename, confidence: 0, reason: "stored review record was malformed" }, decision, createdAt: row.created_at, updatedAt,
        ...(effectiveOverride ? { override: effectiveOverride } : {}),
    };
    return updated;
}
/** Re-queues an item for another organizer pass without changing provider files. */
function retryOrganizerReview(id) {
    const database = (0, db_1.getDb)();
    const row = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id);
    if (!row)
        return undefined;
    const now = new Date().toISOString();
    database.prepare("UPDATE organizer_reviews SET decision = 'pending', updated_at = ? WHERE id = ?").run(now, id);
    database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run(id, "retry", JSON.stringify({ previousDecision: row.decision }), now);
    const parsed = parseStoredJson(row.parsed_json);
    if (!parsed)
        return undefined;
    const override = parseStoredJson(row.override_json);
    return { id, sourcePath: row.source_path, sourceBasename: row.source_basename, parsed, decision: "pending", createdAt: row.created_at, updatedAt: now, ...(override ? { override } : {}) };
}
/** Clears a manual identity match and returns the item to automatic review. */
function clearOrganizerReviewOverride(id) {
    const database = (0, db_1.getDb)();
    const row = database.prepare("SELECT * FROM organizer_reviews WHERE id = ?").get(id);
    if (!row)
        return undefined;
    const now = new Date().toISOString();
    database.prepare("UPDATE organizer_reviews SET decision = 'pending', override_json = NULL, updated_at = ? WHERE id = ?").run(now, id);
    const parsed = parseStoredJson(row.parsed_json);
    if (parsed)
        (0, manualIdentity_1.clearManualIdentityOverride)(parsed);
    database.prepare("INSERT INTO organizer_review_audit (review_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)").run(id, "cleared_override", null, now);
    if (!parsed)
        return undefined;
    return { id, sourcePath: row.source_path, sourceBasename: row.source_basename, parsed, decision: "pending", createdAt: row.created_at, updatedAt: now };
}
function clearOrganizerReviews() {
    const database = (0, db_1.getDb)();
    database.exec("DELETE FROM organizer_review_audit; DELETE FROM organizer_reviews;");
}
function listOrganizerReviewAudit(reviewId) {
    const rows = (0, db_1.getDb)().prepare("SELECT action, payload_json, created_at FROM organizer_review_audit WHERE review_id = ? ORDER BY id ASC").all(reviewId);
    return rows.map((row) => ({
        action: row.action,
        ...(parseStoredJson(row.payload_json) !== undefined ? { payload: parseStoredJson(row.payload_json) } : {}),
        createdAt: row.created_at,
    }));
}
