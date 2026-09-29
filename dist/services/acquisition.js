"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquisitionIdentityKey = acquisitionIdentityKey;
exports.createAcquisitionNeed = createAcquisitionNeed;
exports.deriveAcquisitionNeeds = deriveAcquisitionNeeds;
exports.deduplicateAcquisitionNeeds = deduplicateAcquisitionNeeds;
exports.revalidateAcquisitionNeed = revalidateAcquisitionNeed;
exports.profileStatus = profileStatus;
function canonicalId(identity) {
    return identity.tmdbId || identity.tvdbId || identity.imdbId;
}
function acquisitionIdentityKey(identity, mediaType, season, episode) {
    return [mediaType, canonicalId(identity) || identity.normalizedTitle || identity.title || "unknown", season ?? "", episode ?? ""].join(":");
}
function eligibility(identity, mediaType, season, episode) {
    if (identity.conflicts?.length || identity.resolutionStatus === "conflict")
        return { eligible: false, reason: "IDENTITY_CONFLICT" };
    if (identity.resolutionStatus !== "resolved")
        return { eligible: false, reason: "IDENTITY_NOT_RESOLVED" };
    if (!canonicalId(identity))
        return { eligible: false, reason: "MISSING_CANONICAL_ID" };
    if (mediaType === "tv" && (season === undefined || episode === undefined))
        return { eligible: false, reason: "SEASON_EPISODE_REQUIRED" };
    return { eligible: true };
}
function createAcquisitionNeed(group, profile, options = {}) {
    const profileStatus = group.profileStatuses?.find((item) => item.profileId === profile.id);
    if (!profile.enabled || profileStatus?.satisfied !== false)
        return undefined;
    const identity = group.identity;
    const mediaType = identity.kind === "movie" ? "movie" : identity.kind === "episode" ? "tv" : undefined;
    const evaluatedAt = (options.now || new Date()).toISOString();
    if (!mediaType)
        return undefined;
    const eligible = eligibility(identity, mediaType, identity.season, identity.episode);
    const acquisitionEnabled = options.acquisitionEnabled !== false;
    const status = !acquisitionEnabled ? "PROFILE_MISSING" : eligible.eligible ? "ACQUISITION_ELIGIBLE" : "ACQUISITION_BLOCKED";
    const id = `need:${acquisitionIdentityKey(identity, mediaType, identity.season, identity.episode)}:${profile.id}`;
    return {
        id,
        contentIdentity: identity,
        mediaType,
        season: identity.season,
        episode: identity.episode,
        missingProfileId: profile.id,
        missingProfileName: profile.name,
        reason: `No version satisfies ${profile.name}`,
        reasonCode: "NO_ELIGIBLE_VERSION_FOR_PROFILE",
        status,
        confidence: identity.confidence,
        createdAt: evaluatedAt,
        evaluatedAt,
        existingVersions: group.versions.filter((version) => version.evaluations.some((evaluation) => evaluation.profileId === profile.id && evaluation.eligible)),
        rejectedVersions: group.versions.filter((version) => !version.evaluations.some((evaluation) => evaluation.profileId === profile.id && evaluation.eligible)),
        acquisitionEligibility: { ...eligible, eligible: acquisitionEnabled && eligible.eligible, adapterId: options.adapterId },
    };
}
function deriveAcquisitionNeeds(groups, profiles, options = {}) {
    return groups.flatMap((group) => profiles.flatMap((profile) => createAcquisitionNeed(group, profile, options) || []));
}
/** Stable local idempotency boundary before an adapter is ever called. */
function deduplicateAcquisitionNeeds(needs) {
    const seen = new Set();
    return needs.filter((need) => {
        const key = `${acquisitionIdentityKey(need.contentIdentity, need.mediaType, need.season, need.episode)}:${need.missingProfileId}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function revalidateAcquisitionNeed(need, groups, profiles, options = {}) {
    const group = groups.find((candidate) => candidate.identity.tmdbId === need.contentIdentity.tmdbId && candidate.identity.kind === need.contentIdentity.kind && candidate.identity.season === need.season && candidate.identity.episode === need.episode);
    const profile = profiles.find((candidate) => candidate.id === need.missingProfileId);
    if (!group || !profile)
        return { ...need, status: "ACQUISITION_BLOCKED", acquisitionEligibility: { eligible: false, reason: "STALE_NEED" }, evaluatedAt: (options.now || new Date()).toISOString() };
    const refreshed = createAcquisitionNeed(group, profile, options);
    if (!refreshed)
        return { ...need, status: "PROFILE_SATISFIED", acquisitionEligibility: { eligible: false, reason: "PROFILE_SATISFIED" }, evaluatedAt: (options.now || new Date()).toISOString() };
    return { ...refreshed, id: need.id, createdAt: need.createdAt };
}
function profileStatus(profileId, satisfied) {
    return { profileId, satisfied };
}
