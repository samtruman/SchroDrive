"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDeleteImpact = buildDeleteImpact;
exports.buildSelectedDeleteImpact = buildSelectedDeleteImpact;
function logicalKey(group) {
    const identity = group.identity || {};
    if (identity.kind === "episode" || identity.season !== undefined || identity.episode !== undefined) {
        return ["episode", identity.normalizedTitle || identity.title || "", identity.year || "", identity.season ?? "", identity.episode ?? ""].join(":");
    }
    return [identity.kind || "movie", identity.normalizedTitle || identity.title || "", identity.year || ""].join(":");
}
function deleteIdentity(group) {
    const identity = group.identity || {};
    return {
        tmdbId: identity.tmdbId,
        title: identity.title,
        originalTitle: identity.originalTitle,
        year: identity.year,
        kind: identity.kind,
        season: identity.season,
        episode: identity.episode,
    };
}
function reasonMessages(version) {
    return [...new Set((version.reasons || [])
            .map((reason) => {
            if (typeof reason === "string")
                return reason;
            const facts = reason.facts || {};
            const details = [];
            if (reason.code === "profile_winner") {
                if (facts.profile)
                    details.push(`profile ${String(facts.profile)}`);
                if (typeof facts.score === "number")
                    details.push(`score ${facts.score}`);
                const evaluation = version.evaluations?.find((candidate) => candidate.profileId === String(facts.profile));
                const breakdown = Object.entries(evaluation?.breakdown || {})
                    .filter(([, value]) => Number.isFinite(Number(value)))
                    .map(([key, value]) => `${key} ${value}`)
                    .join(", ");
                if (breakdown)
                    details.push(`score breakdown: ${breakdown}`);
            }
            return details.length ? `${reason.message} (${details.join("; ")})` : reason.message;
        })
            .filter(Boolean))];
}
function itemKey(provider, providerItemId) {
    return `${provider}:${providerItemId}`;
}
function logicalKeys(item) {
    return new Set(item.versions.map((version) => version.logicalKey));
}
function isEpisodePack(item) {
    return item.versions.every((version) => version.identity.kind === "episode") && logicalKeys(item).size > 1;
}
function resolutionValue(version) {
    const resolution = String(version.fingerprint?.video?.resolution || "").toLowerCase();
    if (resolution === "4k")
        return 2160;
    const match = resolution.match(/(\d{3,4})p/);
    return match ? Number(match[1]) : 0;
}
function episodeVersionPreference(packVersion, standaloneVersion) {
    const packEvaluation = packVersion.evaluations?.find((evaluation) => evaluation.profileId === "primary")
        || packVersion.evaluations?.find((evaluation) => evaluation.eligible);
    const standaloneEvaluation = standaloneVersion.evaluations?.find((evaluation) => evaluation.profileId === "primary")
        || standaloneVersion.evaluations?.find((evaluation) => evaluation.eligible);
    if (packEvaluation?.eligible !== standaloneEvaluation?.eligible)
        return packEvaluation?.eligible ? 1 : -1;
    const packScore = Number(packEvaluation?.score ?? 0);
    const standaloneScore = Number(standaloneEvaluation?.score ?? 0);
    if (packScore !== standaloneScore)
        return packScore - standaloneScore;
    const packSize = Number(packVersion.fingerprint?.storage?.size || 0);
    const standaloneSize = Number(standaloneVersion.fingerprint?.storage?.size || 0);
    if (packSize !== standaloneSize)
        return packSize - standaloneSize;
    return resolutionValue(packVersion) - resolutionValue(standaloneVersion);
}
function sameEpisodeFamily(left, right) {
    const a = left.identity;
    const b = right.identity;
    return (a.tmdbId || a.title || "") === (b.tmdbId || b.title || "")
        && (a.year || "") === (b.year || "")
        && (a.season ?? "") === (b.season ?? "");
}
function addReason(item, reason) {
    if (!item.reasons.includes(reason))
        item.reasons.push(reason);
}
function matchesScope(item, scope) {
    const hasCandidate = item.versions.some((version) => version.decision === "DELETE_CANDIDATE");
    const hasReview = item.versions.some((version) => version.decision === "REVIEW");
    // Policy Delete exposes only physical ProviderItems that are safe to remove.
    // Blocked candidates remain available in the protected/attention views.
    if (scope === "candidates")
        return item.state === "READY" && hasCandidate;
    if (scope === "protected")
        return hasCandidate && item.state !== "READY";
    if (scope === "attention")
        return !hasCandidate && hasReview;
    return true;
}
/**
 * Projects the complete inventory into physical ProviderItems.
 *
 * The logical decision is made per content/episode first. Only then are all
 * versions sharing a ProviderItem assembled and classified. This is important
 * for season packs: episodes share a physical delete unit but never become
 * alternatives for one another.
 */
function buildDeleteImpact(groups, query = "", scope = "all") {
    const result = new Map();
    const logicalKeepers = new Map();
    const seenPhysicalFiles = new Map();
    for (const group of groups) {
        for (const version of group.versions) {
            const storage = version.fingerprint.storage;
            const key = itemKey(storage.provider, storage.torrentId);
            const item = result.get(key) || {
                providerItemId: storage.torrentId,
                provider: storage.provider,
                state: "BLOCKED",
                onlyCopy: false,
                versions: [],
                affectedGroups: [],
                reasons: [],
                alternativeVersions: [],
                physicalSize: 0,
                protectedByKeep: false,
            };
            item.versions.push({
                id: version.id,
                groupId: group.id,
                logicalKey: logicalKey(group),
                identity: deleteIdentity(group),
                title: group.identity.title,
                season: group.identity.season,
                episode: group.identity.episode,
                decision: version.decision,
                profileIds: version.satisfiesProfiles || [],
                evaluations: version.evaluations,
                reasons: reasonMessages(version),
                fingerprint: version.fingerprint,
                files: [{ path: storage.path, size: storage.size }],
            });
            if (!item.affectedGroups.includes(group.id))
                item.affectedGroups.push(group.id);
            const physicalFileKey = storage.fileId || storage.path || version.id;
            const seenFiles = seenPhysicalFiles.get(key) || new Set();
            if (!seenFiles.has(physicalFileKey)) {
                seenFiles.add(physicalFileKey);
                item.physicalSize += Number(storage.size || 0);
            }
            seenPhysicalFiles.set(key, seenFiles);
            if (version.decision === "KEEP") {
                item.protectedByKeep = true;
                logicalKeepers.set(logicalKey(group), [
                    ...(logicalKeepers.get(logicalKey(group)) || []),
                    { group, version },
                ]);
            }
            result.set(key, item);
        }
    }
    const physicalItems = [...result.values()];
    const packItems = physicalItems.filter(isEpisodePack);
    const forcedRetainedPacks = new Set();
    // Coverage is a safety rule, not a profile preference. A pack only forces
    // the overlapping singles out when the retained singles do not collectively
    // cover the whole pack; otherwise the normal profile ranking decides.
    for (const item of physicalItems) {
        for (const version of item.versions) {
            if (version.decision !== "KEEP")
                continue;
            const dominatingPack = packItems
                .filter((pack) => pack.providerItemId !== item.providerItemId)
                .map((pack) => {
                const retainedCoverage = new Set();
                for (const other of physicalItems) {
                    if (other.providerItemId === pack.providerItemId)
                        continue;
                    for (const otherVersion of other.versions) {
                        if (otherVersion.decision === "KEEP" && sameEpisodeFamily(otherVersion, version))
                            retainedCoverage.add(otherVersion.logicalKey);
                    }
                }
                return { pack, retainedCoverage, version: pack.versions.find((candidate) => candidate.logicalKey === version.logicalKey) };
            })
                .filter((candidate) => Boolean(candidate.version && sameEpisodeFamily(candidate.version, version) && candidate.retainedCoverage.size < logicalKeys(candidate.pack).size))
                .sort((left, right) => logicalKeys(right.pack).size - logicalKeys(left.pack).size)[0];
            if (!dominatingPack)
                continue;
            forcedRetainedPacks.add(dominatingPack.pack.providerItemId);
            // Coverage protects a pack that contains unique episodes, but it must
            // not make a non-compliant or lower-quality pack displace a compliant
            // standalone episode. Compare the matching episode, never the physical
            // size or resolution of the whole pack.
            if (episodeVersionPreference(dominatingPack.version, version) < 0)
                continue;
            version.decision = "DELETE_CANDIDATE";
            version.reasons = [...new Set([
                    ...(version.reasons || []),
                    "Duplicate episode covered by a larger retained pack",
                ])];
        }
    }
    // Rebuild KEEP indexes after applying the coverage rule. A version changed
    // from KEEP to DELETE_CANDIDATE must not remain an alternative elsewhere.
    logicalKeepers.clear();
    for (const item of physicalItems) {
        item.protectedByKeep = false;
        for (const version of item.versions) {
            if (version.decision !== "KEEP")
                continue;
            item.protectedByKeep = true;
            const group = groups.find((candidate) => candidate.id === version.groupId);
            if (!group)
                continue;
            logicalKeepers.set(version.logicalKey, [
                ...(logicalKeepers.get(version.logicalKey) || []),
                { group, version: version },
            ]);
        }
    }
    const packAlternatives = new Map();
    for (const pack of packItems) {
        for (const version of pack.versions) {
            const group = groups.find((candidate) => candidate.id === version.groupId);
            if (!group)
                continue;
            packAlternatives.set(version.logicalKey, [
                ...(packAlternatives.get(version.logicalKey) || []),
                { group, version: version, forcedRetained: forcedRetainedPacks.has(pack.providerItemId) },
            ]);
        }
    }
    for (const item of result.values()) {
        const candidates = item.versions.filter((version) => version.decision === "DELETE_CANDIDATE");
        const reviews = item.versions.filter((version) => version.decision === "REVIEW");
        item.alternativeVersions = candidates.flatMap((candidate) => [
            ...(logicalKeepers.get(candidate.logicalKey) || []),
            ...((packAlternatives.get(candidate.logicalKey) || []).filter(({ version }) => item.providerItemId !== version.fingerprint.storage.torrentId
                && resolutionValue(version) >= resolutionValue(candidate))),
        ]
            .filter(({ version }) => itemKey(version.fingerprint.storage.provider, version.fingerprint.storage.torrentId) !== itemKey(item.provider, item.providerItemId))
            .map(({ group, version }) => ({
            id: version.id,
            groupId: group.id,
            logicalKey: logicalKey(group),
            identity: deleteIdentity(group),
            title: group.identity.title,
            season: group.identity.season,
            episode: group.identity.episode,
            provider: version.fingerprint.storage.provider,
            providerItemId: version.fingerprint.storage.torrentId,
            decision: forcedRetainedPacks.has(version.fingerprint.storage.torrentId) ? "KEEP" : version.decision,
            profileIds: version.satisfiesProfiles || [],
            reasons: forcedRetainedPacks.has(version.fingerprint.storage.torrentId)
                ? [...reasonMessages(version), "Retained because the pack contains episodes not covered by the separate items"]
                : reasonMessages(version),
            fingerprint: version.fingerprint,
        }))).filter((version, index, all) => all.findIndex((candidate) => candidate.id === version.id) === index);
        const nonKeepWithoutAlternative = item.versions.some((version) => version.decision !== "KEEP"
            && !item.alternativeVersions.some((alternative) => alternative.logicalKey === version.logicalKey));
        // A season pack is one physical delete unit. If any non-KEEP episode in
        // that pack has no retained alternative, deleting the pack would orphan
        // that episode even when another episode has a duplicate elsewhere.
        item.onlyCopy = candidates.length > 0 && nonKeepWithoutAlternative;
        if (item.protectedByKeep) {
            item.state = "PARTIALLY_REDUNDANT";
            addReason(item, "PROTECTED — ProviderItem contains a KEEP version");
        }
        if (reviews.length > 0) {
            item.state = "BLOCKED";
            addReason(item, "Review or identity blocker requires operator decision");
        }
        if (candidates.some((candidate) => candidate.fingerprint?.storage.recoverability?.status !== "RECOVERABLE")) {
            item.state = "BLOCKED";
            addReason(item, "Provider item is not confirmed recoverable");
        }
        if (item.onlyCopy) {
            item.state = "BLOCKED";
            addReason(item, "ONLY COPY — No alternative version identified for every candidate episode");
        }
        if (candidates.length > 0 && !item.protectedByKeep && !reviews.length && !item.onlyCopy &&
            item.versions.filter((version) => version.decision === "DELETE_CANDIDATE").every((candidate) => candidate.fingerprint?.storage.recoverability?.status === "RECOVERABLE")) {
            item.state = "READY";
            if (item.alternativeVersions.length) {
                addReason(item, `Alternative KEEP versions on ${new Set(item.alternativeVersions.map((version) => version.providerItemId)).size} other ProviderItem(s)`);
            }
            else {
                addReason(item, "ProviderItem is the physical delete unit; final provider revalidation is required");
            }
        }
        else if (!candidates.length && reviews.length) {
            item.state = "BLOCKED";
        }
        item.reasons = [...new Set(item.reasons)];
    }
    const q = query.trim().toLowerCase();
    return [...result.values()]
        .filter((item) => {
        // Query is applied after full ProviderItem assembly so a matching episode
        // never hides the KEEP/blocker rows sharing its physical pack.
        if (q && !JSON.stringify(item).toLowerCase().includes(q))
            return false;
        const hasNonKeep = item.versions.some((version) => version.decision !== "KEEP");
        return hasNonKeep && matchesScope(item, scope);
    })
        .sort((a, b) => a.providerItemId.localeCompare(b.providerItemId));
}
/**
 * Reclassifies an explicit operator selection without rewriting the persisted
 * policy decision. A selected KEEP item is deletable only when every logical
 * content unit it contains has an admissible, unselected version elsewhere.
 */
function buildSelectedDeleteImpact(groups, selection) {
    const selectedKeys = new Set(selection.map((item) => itemKey(item.provider, item.providerItemId)));
    const result = new Map();
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const seenPhysicalFiles = new Map();
    for (const group of groups) {
        for (const version of group.versions) {
            const storage = version.fingerprint.storage;
            const key = itemKey(storage.provider, storage.torrentId);
            if (!selectedKeys.has(key))
                continue;
            const item = result.get(key) || {
                providerItemId: storage.torrentId,
                provider: storage.provider,
                state: "BLOCKED",
                onlyCopy: false,
                versions: [],
                affectedGroups: [],
                reasons: [],
                alternativeVersions: [],
                physicalSize: 0,
                protectedByKeep: false,
            };
            item.versions.push({
                id: version.id,
                groupId: group.id,
                logicalKey: logicalKey(group),
                identity: deleteIdentity(group),
                title: group.identity.title,
                season: group.identity.season,
                episode: group.identity.episode,
                decision: version.decision,
                profileIds: version.satisfiesProfiles || [],
                reasons: reasonMessages(version),
                fingerprint: version.fingerprint,
                files: [{ path: storage.path, size: storage.size }],
            });
            if (!item.affectedGroups.includes(group.id))
                item.affectedGroups.push(group.id);
            const physicalFileKey = storage.fileId || storage.path || version.id;
            const seenFiles = seenPhysicalFiles.get(key) || new Set();
            if (!seenFiles.has(physicalFileKey)) {
                seenFiles.add(physicalFileKey);
                item.physicalSize += Number(storage.size || 0);
            }
            seenPhysicalFiles.set(key, seenFiles);
            result.set(key, item);
        }
    }
    for (const item of result.values()) {
        let missingAlternative = false;
        for (const groupId of item.affectedGroups) {
            const group = groupsById.get(groupId);
            if (!group) {
                missingAlternative = true;
                continue;
            }
            const survivors = group.versions.filter((version) => {
                const storage = version.fingerprint.storage;
                return !selectedKeys.has(itemKey(storage.provider, storage.torrentId)) && version.decision !== "REVIEW";
            });
            if (!survivors.length)
                missingAlternative = true;
            item.alternativeVersions.push(...survivors.map((version) => ({
                id: version.id,
                groupId: group.id,
                logicalKey: logicalKey(group),
                identity: deleteIdentity(group),
                title: group.identity.title,
                season: group.identity.season,
                episode: group.identity.episode,
                provider: version.fingerprint.storage.provider,
                providerItemId: version.fingerprint.storage.torrentId,
                decision: version.decision,
                profileIds: version.satisfiesProfiles || [],
                reasons: reasonMessages(version),
                fingerprint: version.fingerprint,
            })));
        }
        item.alternativeVersions = item.alternativeVersions.filter((version, index, all) => all.findIndex((candidate) => candidate.id === version.id && candidate.provider === version.provider && candidate.providerItemId === version.providerItemId) === index);
        item.onlyCopy = missingAlternative;
        const hasReview = item.versions.some((version) => version.decision === "REVIEW");
        const recoverable = item.versions.every((version) => version.fingerprint?.storage.recoverability?.status === "RECOVERABLE");
        const overridesKeep = item.versions.some((version) => version.decision === "KEEP");
        if (missingAlternative)
            addReason(item, "ONLY COPY — At least one selected content unit has no unselected alternative");
        if (hasReview)
            addReason(item, "Review or identity blocker requires operator decision");
        if (!recoverable)
            addReason(item, "Provider item is not confirmed recoverable");
        if (overridesKeep)
            addReason(item, "Operator selection overrides the policy KEEP recommendation for this deletion");
        if (!missingAlternative && !hasReview && recoverable) {
            item.state = "READY";
            addReason(item, `Operator selection leaves admissible versions on ${new Set(item.alternativeVersions.map((version) => itemKey(version.provider, version.providerItemId))).size} other ProviderItem(s)`);
        }
        item.reasons = [...new Set(item.reasons)];
    }
    return [...result.values()].sort((a, b) => itemKey(a.provider, a.providerItemId).localeCompare(itemKey(b.provider, b.providerItemId)));
}
