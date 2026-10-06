"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDismissedVersionManagerReviews = listDismissedVersionManagerReviews;
exports.setVersionManagerReviewDismissed = setVersionManagerReviewDismissed;
exports.buildUnifiedReviewQueue = buildUnifiedReviewQueue;
const node_crypto_1 = require("node:crypto");
const mediaParser_1 = require("./mediaParser");
const db_1 = require("../core/db");
function listDismissedVersionManagerReviews() {
    const rows = (0, db_1.getDb)().prepare("SELECT review_key FROM version_manager_review_dismissals").all();
    return new Set(rows.map((row) => row.review_key));
}
function setVersionManagerReviewDismissed(reviewKey, dismissed) {
    const database = (0, db_1.getDb)();
    if (dismissed) {
        database.prepare("INSERT OR REPLACE INTO version_manager_review_dismissals (review_key, updated_at) VALUES (?, ?)")
            .run(reviewKey, new Date().toISOString());
    }
    else {
        database.prepare("DELETE FROM version_manager_review_dismissals WHERE review_key = ?").run(reviewKey);
    }
}
function digest(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value, "utf8").digest("hex");
}
function identityKey(identity) {
    if (!identity)
        return undefined;
    if (identity.tmdbId)
        return `tmdb:${identity.kind || "unknown"}:${identity.tmdbId}`;
    if (identity.imdbId)
        return `imdb:${identity.kind || "unknown"}:${identity.imdbId}`;
    if (identity.tvdbId)
        return `tvdb:${identity.kind || "unknown"}:${identity.tvdbId}`;
    if (!identity.normalizedTitle && !identity.title)
        return undefined;
    let title = identity.normalizedTitle || identity.title || "";
    let year = identity.year;
    // Organizer's legacy parser may leave a terminal year in the title. This
    // is only a read-model key normalization; the stored parser identity is
    // never changed.
    if (year === undefined) {
        const match = title.match(/^(.*?)[\s([{]+(\d{4})[\s)\]}]*$/) || title.match(/^(.+?)(\d{4})$/);
        const candidate = match ? Number(match[2]) : 0;
        const currentYear = new Date().getFullYear();
        if (match && candidate >= 1850 && candidate <= currentYear + 1 && match[1].trim()) {
            title = match[1].trim().replace(/[([{]$/, "").trim();
            year = candidate;
        }
    }
    return [identity.kind || "unknown", title, year || "", identity.season ?? "", identity.episode ?? ""].join(":");
}
function keyForIdentity(identity, fallback) {
    return `review_${digest(identityKey(identity) || fallback)}`;
}
function recoverabilityFor(version) {
    return version.fingerprint.storage.recoverability?.status || (version.fingerprint.storage.infoHash ? "RECOVERABLE" : "UNKNOWN");
}
function mergeEntry(entries, value) {
    const current = entries.get(value.key);
    if (!current) {
        entries.set(value.key, value);
        return;
    }
    current.issueTypes = [...new Set([...current.issueTypes, ...value.issueTypes])];
    current.reasonCodes = [...new Set([...current.reasonCodes, ...value.reasonCodes])];
    current.blockers = [...new Set([...current.blockers, ...value.blockers])];
    current.versionIds = [...new Set([...current.versionIds, ...value.versionIds])];
    current.allowedActions = [...new Set([...current.allowedActions, ...value.allowedActions])];
    if (!current.organizerReview && value.organizerReview) {
        current.organizerReview = value.organizerReview;
        current.review = value.review;
        current.parsed = value.parsed;
        current.sourceBasename = value.sourceBasename;
        current.sourcePath = value.sourcePath;
        current.decision = value.decision;
    }
    if (!current.identity?.tmdbId && !current.identity?.imdbId && !current.identity?.tvdbId && (value.identity?.tmdbId || value.identity?.imdbId || value.identity?.tvdbId)) {
        current.identity = value.identity;
        current.title = value.title;
        current.year = value.year;
        current.kind = value.kind;
        current.season = value.season;
        current.episode = value.episode;
        current.identityResolutionStatus = value.identityResolutionStatus;
    }
    if (value.versionGroupId)
        current.versionGroupId || (current.versionGroupId = value.versionGroupId);
    if (value.policyDecision)
        current.policyDecision = value.policyDecision;
    if (value.recoverability) {
        const rank = { RECOVERABLE: 0, UNKNOWN: 1, NOT_RECOVERABLE: 2 };
        if (!current.recoverability || rank[value.recoverability.status] > rank[current.recoverability.status])
            current.recoverability = value.recoverability;
        current.recoverability.sources = [...new Set([...(current.recoverability?.sources || []), ...value.recoverability.sources])];
    }
}
function organizerIssue(entry) {
    const status = String(entry.parsed.status);
    return status === "ambiguous" || status === "unmatched" || status === "fallback" || status === "conflict";
}
function makeOrganizerEntry(entry) {
    const kind = entry.override?.kind || (entry.parsed.kind === "episode" ? "episode" : entry.parsed.kind === "movie" ? "movie" : "unknown");
    const identity = {
        tmdbId: entry.override?.tmdbId,
        imdbId: entry.override?.imdbId,
        tvdbId: entry.override?.tvdbId,
        title: entry.override?.title || entry.parsed.title,
        originalTitle: entry.override?.originalTitle,
        normalizedTitle: (0, mediaParser_1.normalizeMediaTitle)(entry.override?.title || entry.parsed.title || ""),
        year: entry.override?.year || entry.parsed.year,
        kind,
        season: entry.override?.season || entry.parsed.season,
        episode: entry.override?.episode || entry.parsed.episode,
        confidence: entry.override ? 1 : entry.parsed.confidence,
        source: entry.override ? "manual" : "unknown",
    };
    return {
        key: keyForIdentity(identity, `organizer:${entry.id}`), identity, title: identity.title, year: identity.year, kind: identity.kind,
        season: identity.season, episode: identity.episode, issueTypes: ["IDENTITY_ISSUE"], reasonCodes: [entry.parsed.reason || entry.parsed.status],
        blockers: [entry.parsed.reason || "Manual identity review required"], identityResolutionStatus: entry.override ? "resolved" : entry.parsed.status,
        organizerReview: entry, review: entry, parsed: entry.parsed, sourceBasename: entry.sourceBasename, sourcePath: entry.sourcePath,
        decision: entry.decision, versionIds: [], allowedActions: entry.decision === "dismissed" ? ["RESTORE_TO_REVIEW", "DETAILS"] : ["RESOLVE_IDENTITY", "ACCEPT_AS_DETECTED", "DISMISS", "RETRY", "DETAILS"],
        allowIdentityActions: true,
    };
}
function buildUnifiedReviewQueue(groups, organizerReviews = [], status = "pending") {
    const entries = new Map();
    const dismissedPolicyReviews = listDismissedVersionManagerReviews();
    const aliases = new Map();
    const canonicalByKey = new Map();
    const add = (value) => {
        const fallback = identityKey({ ...value.identity, tmdbId: undefined, imdbId: undefined, tvdbId: undefined });
        const canonical = Boolean(value.identity?.tmdbId || value.identity?.imdbId || value.identity?.tvdbId);
        const aliasedKey = fallback ? aliases.get(fallback) : undefined;
        const existingKey = entries.has(value.key) ? value.key : aliasedKey;
        const existingCanonical = existingKey ? canonicalByKey.get(existingKey) === true : false;
        if (existingKey && !(canonical && existingCanonical && existingKey !== value.key)) {
            value.key = existingKey;
            mergeEntry(entries, value);
            canonicalByKey.set(existingKey, existingCanonical || canonical);
        }
        else {
            entries.set(value.key, value);
            canonicalByKey.set(value.key, canonical);
        }
        if (fallback && (!canonical || !existingCanonical))
            aliases.set(fallback, value.key);
    };
    for (const organizer of organizerReviews) {
        if (status !== "all" && organizer.decision !== status)
            continue;
        if (!organizerIssue(organizer))
            continue;
        add(makeOrganizerEntry(organizer));
    }
    for (const group of groups) {
        const reviewVersions = group.versions.filter((version) => version.decision === "REVIEW");
        if (reviewVersions.length === 0)
            continue;
        const reasonCodes = [...new Set(reviewVersions.flatMap((version) => version.reasons.map((reason) => reason.code)))];
        const recoverabilityReasons = new Set(["recoverability_unknown", "recoverability_required"]);
        const identityReasons = new Set(["identity_uncertain", "identity_conflict"]);
        const hasRecoverability = reasonCodes.some((code) => recoverabilityReasons.has(code));
        const identityStatus = group.identity.resolutionStatus;
        // `identity_uncertain` is emitted by the frozen Policy Engine for some
        // non-identity REVIEW paths (notably recoverability). Only expose an
        // identity issue when the identity evidence itself is weak/conflicting.
        const hasIdentity = identityStatus === "uncertain" || identityStatus === "conflict" || group.identity.confidence < 0.65 || reasonCodes.some((code) => identityReasons.has(code) && group.identity.confidence < 0.65);
        const policyReasons = reasonCodes.filter((code) => !recoverabilityReasons.has(code) && !(identityReasons.has(code) && hasIdentity));
        const issueTypes = [];
        if (hasIdentity)
            issueTypes.push("IDENTITY_ISSUE");
        if (hasRecoverability)
            issueTypes.push("RECOVERABILITY_ISSUE");
        if (policyReasons.length > 0)
            issueTypes.push("POLICY_REVIEW");
        if (issueTypes.length === 0)
            issueTypes.push("POLICY_REVIEW");
        const states = reviewVersions.map(recoverabilityFor);
        const state = states.includes("NOT_RECOVERABLE") ? "NOT_RECOVERABLE" : states.includes("UNKNOWN") ? "UNKNOWN" : "RECOVERABLE";
        const sources = [...new Set(reviewVersions.map((version) => version.fingerprint.storage.recoverability?.source || (version.fingerprint.storage.infoHash ? "INFOHASH" : "UNKNOWN")))];
        const fallback = reviewVersions.map((version) => `${version.fingerprint.storage.provider}:${version.fingerprint.storage.torrentId}:${version.fingerprint.storage.fileId || ""}`).sort().join("|");
        const key = keyForIdentity(group.identity, fallback);
        const dismissed = dismissedPolicyReviews.has(key);
        if (status === "pending" && dismissed)
            continue;
        if (status === "dismissed" && !dismissed)
            continue;
        add({
            key, identity: group.identity, title: group.identity.title, year: group.identity.year, kind: group.identity.kind,
            season: group.identity.season, episode: group.identity.episode, issueTypes, reasonCodes, blockers: [...new Set(reviewVersions.flatMap((version) => version.reasons.map((reason) => reason.message)))],
            policyDecision: "REVIEW", recoverability: { status: state, sources }, identityResolutionStatus: identityStatus, versionGroupId: group.id,
            decision: dismissed ? "dismissed" : "pending", versionIds: reviewVersions.map((version) => version.id),
            allowedActions: dismissed ? ["RESTORE_TO_REVIEW", "DETAILS"] : ["DISMISS", "DETAILS"], allowIdentityActions: false,
        });
    }
    const result = [...entries.values()];
    return {
        entries: result,
        summary: {
            total: result.length,
            identityIssues: result.filter((entry) => entry.issueTypes.includes("IDENTITY_ISSUE")).length,
            policyReviews: result.filter((entry) => entry.issueTypes.includes("POLICY_REVIEW")).length,
            recoverabilityIssues: result.filter((entry) => entry.issueTypes.includes("RECOVERABILITY_ISSUE")).length,
        },
    };
}
