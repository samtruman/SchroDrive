"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultVersionManagerPolicy = exports.defaultVersionProfiles = exports.MEDIA_FILE_EXTENSIONS = void 0;
exports.validateRule = validateRule;
exports.validateScoringRule = validateScoringRule;
exports.validateScoringRules = validateScoringRules;
exports.evaluateRule = evaluateRule;
exports.isMediaFileName = isMediaFileName;
exports.fingerprintTorrent = fingerprintTorrent;
exports.evaluateVersionGroups = evaluateVersionGroups;
exports.versionManagerPolicyHash = versionManagerPolicyHash;
const mediaParser_1 = require("./mediaParser");
const migrationExporter_1 = require("./migrationExporter");
const node_crypto_1 = require("node:crypto");
const RULE_FIELDS = new Set(["resolution", "source", "codec", "bitrate", "size", "fileSize", "audioCodec", "audioLanguage", "subtitleLanguage", "channels", "atmos", "hdr", "dolbyVision", "container", "originalLanguage", "identityConfidence", "mediaType", "profileEligible"]);
const NUMERIC_RULE_FIELDS = new Set(["bitrate", "size", "fileSize", "channels", "identityConfidence"]);
const BOOLEAN_RULE_FIELDS = new Set(["atmos", "hdr", "dolbyVision", "profileEligible"]);
function validateRuleValue(field, value) {
    if (value === undefined || value === null || value === "")
        throw new Error("Rule value is required for this operator");
    if (NUMERIC_RULE_FIELDS.has(field) && (typeof value !== "number" || !Number.isFinite(value)))
        throw new Error(`Rule value for ${field} must be numeric`);
    if (BOOLEAN_RULE_FIELDS.has(field) && typeof value !== "boolean")
        throw new Error(`Rule value for ${field} must be boolean`);
}
function validateRule(node, depth = 0) {
    if (depth > 8 || !node || typeof node !== "object" || Array.isArray(node))
        throw new Error("Invalid version rule");
    const value = node;
    const op = value.op;
    if (op === "AND" || op === "OR") {
        if (!Array.isArray(value.children) || (op === "OR" && value.children.length === 0))
            throw new Error(`${op} requires children`);
        return { op, children: value.children.map((child) => validateRule(child, depth + 1)) };
    }
    if (op === "NOT")
        return { op, child: validateRule(value.child, depth + 1) };
    if (op === "COMPARE" && RULE_FIELDS.has(String(value.field)) && ["eq", "neq", "gt", "gte", "lt", "lte", "equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "contains", "not_contains", "exists", "not_exists"].includes(String(value.operator))) {
        if (!(["exists", "not_exists"].includes(String(value.operator))))
            validateRuleValue(String(value.field), value.value);
        return { op, field: String(value.field), operator: value.operator, value: value.value };
    }
    if (op === "IN" && RULE_FIELDS.has(String(value.field)) && Array.isArray(value.values) && value.values.length > 0) {
        value.values.forEach((item) => validateRuleValue(String(value.field), item));
        return { op, field: String(value.field), values: value.values };
    }
    if (op === "HAS" && RULE_FIELDS.has(String(value.field))) {
        validateRuleValue(String(value.field), value.value);
        return { op, field: String(value.field), value: value.value };
    }
    throw new Error("Invalid version rule field or operator");
}
function validateScoringRule(rule) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule))
        throw new Error("Invalid scoring rule");
    const value = rule;
    const weight = Number(value.weight);
    if (!Number.isFinite(weight))
        throw new Error("Scoring rule weight must be finite");
    const op = value.op || "COMPARE";
    if (op === "COMPARE") {
        const validated = validateRule({ op, field: value.field, operator: value.operator, value: value.value });
        if (validated.op !== "COMPARE")
            throw new Error("Invalid scoring comparison");
        return { ...validated, weight };
    }
    if (op === "IN") {
        const validated = validateRule({ op, field: value.field, values: value.values });
        if (validated.op !== "IN")
            throw new Error("Invalid scoring IN rule");
        return { ...validated, weight };
    }
    if (op === "HAS") {
        const validated = validateRule({ op, field: value.field, value: value.value });
        if (validated.op !== "HAS")
            throw new Error("Invalid scoring HAS rule");
        return { ...validated, weight };
    }
    throw new Error("Invalid scoring rule operator");
}
function validateScoringRules(rules) {
    if (rules === undefined)
        return [];
    if (!Array.isArray(rules))
        throw new Error("scoringRules must be an array");
    return rules.map(validateScoringRule);
}
function ruleField(version, field, profileEligible = true) {
    const fingerprint = version.fingerprint;
    return {
        resolution: fingerprint.video.resolution,
        source: fingerprint.release.source,
        codec: fingerprint.video.codec,
        bitrate: fingerprint.video.bitrate,
        size: fingerprint.storage.size,
        audioCodec: fingerprint.audio[0]?.codec,
        audioLanguage: fingerprint.audio.map((stream) => stream.language),
        subtitleLanguage: fingerprint.subtitles.map((stream) => stream.language),
        channels: fingerprint.audio[0]?.channels,
        atmos: fingerprint.audio.some((stream) => stream.atmos),
        hdr: Boolean(fingerprint.video.hdr10 || fingerprint.video.hdr10Plus || fingerprint.video.dolbyVision),
        dolbyVision: fingerprint.video.dolbyVision,
        container: fingerprint.video.container,
        fileSize: fingerprint.storage.size,
        originalLanguage: fingerprint.identity.originalLanguage,
        identityConfidence: fingerprint.identity.confidence,
        mediaType: fingerprint.identity.kind,
        profileEligible,
    }[field];
}
function evaluateRule(node, version, profileEligible = true) {
    if (!node)
        return true;
    if (node.op === "AND")
        return node.children.every((child) => evaluateRule(child, version, profileEligible));
    if (node.op === "OR")
        return node.children.some((child) => evaluateRule(child, version, profileEligible));
    if (node.op === "NOT")
        return !evaluateRule(node.child, version, profileEligible);
    if (node.op === "HAS") {
        const actual = ruleField(version, node.field, profileEligible);
        return Array.isArray(actual) ? actual.includes(node.value) : actual === node.value;
    }
    if (node.op === "IN")
        return node.values.includes(ruleField(version, node.field, profileEligible));
    const comparison = node;
    const actual = ruleField(version, comparison.field, profileEligible);
    const operator = comparison.operator;
    if (operator === "exists" || operator === "not_exists")
        return operator === "exists" ? actual !== undefined && actual !== null && actual !== "" : actual === undefined || actual === null || actual === "";
    if (operator === "eq" || operator === "equals")
        return actual === comparison.value;
    if (operator === "neq" || operator === "not_equals")
        return actual !== comparison.value;
    if (operator === "contains" || operator === "not_contains") {
        const result = Array.isArray(actual) ? actual.includes(comparison.value) : String(actual ?? "").toLowerCase().includes(String(comparison.value).toLowerCase());
        return operator === "contains" ? result : !result;
    }
    if (operator === "gt" || operator === "greater_than")
        return Number(actual) > Number(comparison.value);
    if (operator === "gte" || operator === "greater_or_equal")
        return Number(actual) >= Number(comparison.value);
    if (operator === "lt" || operator === "less_than")
        return Number(actual) < Number(comparison.value);
    return Number(actual) <= Number(comparison.value);
}
const LANGUAGE_ALIASES = {
    ita: "ita", italian: "ita", eng: "eng", english: "eng", original: "original",
    fre: "fra", french: "fra", ger: "deu", german: "deu", spa: "spa", spanish: "spa",
    jpn: "ja", japanese: "ja", ja: "ja", zho: "zh", chi: "zh", kor: "ko", rus: "ru",
};
exports.MEDIA_FILE_EXTENSIONS = new Set(["mkv", "mp4", "m4v", "avi", "ts", "m2ts", "webm"]);
function isMediaFileName(name) {
    const basename = name.trim().split(/[\\/]/).pop() || "";
    const extension = basename.toLowerCase().split(".").pop();
    if (!extension || !exports.MEDIA_FILE_EXTENSIONS.has(extension))
        return false;
    return !/(^|[._ -])sample([._ -]|$)/i.test(basename);
}
function languagesFromName(name) {
    const upper = name.toUpperCase();
    return Object.entries(LANGUAGE_ALIASES)
        .filter(([token]) => new RegExp(`(^|[. _-])${token.toUpperCase()}([. _-]|$)`).test(upper))
        .map(([, value]) => value)
        .filter((value, index, values) => values.indexOf(value) === index);
}
function firstMatch(name, patterns) {
    for (const pattern of patterns) {
        const match = name.match(pattern);
        if (match?.[1])
            return match[1].toUpperCase();
    }
    return undefined;
}
function inferResolution(name) {
    const value = firstMatch(name, [/(4320p|2160p|1440p|1080p|720p|576p|480p)/i]);
    return value?.toLowerCase();
}
function inferSource(name) {
    return firstMatch(name, [/(remux|bdremux)/i, /(bluray|blu-ray)/i, /(web[- .]?dl|webmux)/i, /(webrip)/i, /(hdtv)/i])?.replace("BDREMUX", "REMUX").replace("BLU-RAY", "BLURAY").replace("WEBMUX", "WEB-DL");
}
function inferCodec(name) {
    return firstMatch(name, [/(av1)/i, /(x265|h\.265|h265|hevc)/i, /(x264|h\.264|h264|avc)/i])?.replace("X265", "HEVC").replace("H.265", "HEVC").replace("H265", "HEVC").replace("X264", "H264").replace("H.264", "H264");
}
function inferAudio(name) {
    const upper = name.toUpperCase();
    return {
        codec: firstMatch(name, [/(TRUEHD)/i, /(DTS[- .]?HD(?:[- .]?MA)?)/i, /(DDP|EAC3)/i, /(AC3|AAC)/i]),
        channels: upper.match(/(?:DDP|DD|AAC|DTS|TRUEHD)[. _-]?(\d(?:\.\d)?)/i)?.[1] ? Number(upper.match(/(?:DDP|DD|AAC|DTS|TRUEHD)[. _-]?(\d(?:\.\d)?)/i)?.[1]) : undefined,
        atmos: /ATMOS/i.test(name),
    };
}
function fingerprintTorrent(torrent, provider = "unknown") {
    // Provider items are not necessarily media files themselves. Prefer the
    // provider's file tree and only use the item name as a fallback when it is
    // itself an actual media filename. This keeps folders/season packs useful
    // while preventing artwork, samples, subtitles, and extensionless release
    // names from becoming fake fingerprints.
    const providerFiles = Array.isArray(torrent.files) ? torrent.files : [];
    const files = providerFiles.length > 0
        ? providerFiles
        : isMediaFileName(torrent.filename || torrent.name)
            ? [{ id: "torrent", name: torrent.filename || torrent.name, path: torrent.filename || torrent.name, size: torrent.bytes, selected: true }]
            : [];
    return files.filter((file) => isMediaFileName(file.name || file.path)).map((file) => {
        const path = (file.path || file.name || torrent.name).trim();
        const parsed = (0, mediaParser_1.parseMediaFilename)(file.name || path, path);
        const name = (file.name || path).trim();
        const languages = languagesFromName(name);
        const audio = inferAudio(name);
        const recoverability = (0, migrationExporter_1.evaluateRecoverability)(torrent);
        return {
            id: `${provider}:${torrent.id}:${file.id}`,
            fingerprint: {
                identity: {
                    title: parsed.title,
                    normalizedTitle: parsed.title ? (0, mediaParser_1.normalizeMediaTitle)(parsed.title) : undefined,
                    year: parsed.year,
                    kind: parsed.kind === "movie" ? "movie" : parsed.kind === "episode" || parsed.kind === "anime-episode" ? "episode" : "unknown",
                    season: parsed.season,
                    episode: parsed.episode,
                    episodeEnd: parsed.episodeEnd,
                    confidence: parsed.confidence,
                    source: parsed.status === "matched" ? "filename" : "unknown",
                    provenance: { title: "FILENAME", normalizedTitle: "FILENAME", kind: "FILENAME", season: "FILENAME", episode: "FILENAME", year: "FILENAME" },
                },
                video: {
                    resolution: inferResolution(name), codec: inferCodec(name),
                    hdr10: /HDR10?(?:\b|\+|\.)/i.test(name), hdr10Plus: /HDR10\+/i.test(name),
                    dolbyVision: /(?:\bDV\b|DOLBY[ ._-]?VISION)/i.test(name),
                    provenance: { resolution: "FILENAME", codec: "FILENAME", hdr10: "FILENAME", hdr10Plus: "FILENAME", dolbyVision: "FILENAME" },
                },
                audio: (languages.length > 0 ? languages : ["eng"]).map((language) => ({ language, ...audio, provenance: { language: "FILENAME", codec: "FILENAME", channels: "FILENAME", atmos: "FILENAME" } })),
                subtitles: [], release: { source: inferSource(name), group: name.match(/-([A-Za-z0-9]+)(?:\.[^.]+)?$/)?.[1], provenance: { source: "FILENAME", group: "FILENAME" } },
                storage: { provider, torrentId: torrent.id, fileId: file.id, path, size: file.size || torrent.bytes, infoHash: torrent.infoHash || torrent.raw?.infoHash || torrent.raw?.infohash || torrent.raw?.hash || torrent.raw?.hashString, recoverability, addedAt: torrent.addedAt?.toISOString(), provenance: { provider: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", torrentId: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", path: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", size: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", infoHash: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN" } },
                probe: { status: "not_requested", tool: "filename" },
            },
        };
    });
}
exports.defaultVersionProfiles = [
    {
        id: "primary", name: "PRIMARY / QUALITY", enabled: true, target: "QUALITY", preferredResolution: "2160p",
        languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: true },
        hardRequirements: { op: "AND", children: [] },
        sourceOrder: ["REMUX", "BLURAY", "WEB-DL", "WEBRIP", "HDTV"], codecOrder: ["HEVC", "AV1", "H264"], audioOrder: ["TRUEHD", "DTS-HD MA", "DTS-HD", "DDP", "EAC3", "AAC"],
    },
    {
        id: "remote", name: "REMOTE / DIRECT PLAY", enabled: false, target: "DIRECT_PLAY", preferredResolution: "1080p",
        languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false },
        hardRequirements: { op: "AND", children: [] },
        sourceOrder: ["WEB-DL", "WEBRIP", "BLURAY", "REMUX"], codecOrder: ["H264", "HEVC", "AV1"], audioOrder: ["AAC", "EAC3", "DDP", "DTS-HD", "TRUEHD"],
    },
];
exports.defaultVersionManagerPolicy = {
    enableRemote: false,
    acquireMissingRemote: false,
    preferCompletePack: false,
    safety: { requireRecoverableBeforeDelete: true, allowDeleteWhenIdentityUncertain: false, allowDeleteWhenMetadataIncomplete: false },
    policyVersion: "1",
};
function hasRequiredLanguages(version, policy) {
    const scope = policy.scope || "AUDIO";
    const audio = new Set(version.fingerprint.audio.map((stream) => LANGUAGE_ALIASES[stream.language.toLowerCase()] || stream.language.toLowerCase()));
    const subtitles = new Set(version.fingerprint.subtitles.map((stream) => LANGUAGE_ALIASES[stream.language.toLowerCase()] || stream.language.toLowerCase()));
    const required = policy.required.values.map((value) => LANGUAGE_ALIASES[value.toLowerCase()] || value.toLowerCase());
    const original = version.fingerprint.identity.originalLanguage ? LANGUAGE_ALIASES[version.fingerprint.identity.originalLanguage.toLowerCase()] || version.fingerprint.identity.originalLanguage.toLowerCase() : undefined;
    const matches = (value) => {
        const resolved = value === "original" ? original : value;
        if (!resolved)
            return false;
        const inAudio = audio.has(resolved);
        const inSubtitles = subtitles.has(resolved);
        return scope === "SUBTITLE" ? inSubtitles : scope === "AUDIO_OR_SUBTITLE" ? inAudio || inSubtitles : inAudio;
    };
    return policy.required.mode === "ANY" ? required.length === 0 || required.some(matches) : required.every(matches);
}
function rank(value, order) {
    if (!value)
        return order.length + 1;
    const index = order.findIndex((entry) => entry.toLowerCase() === value.toLowerCase());
    return index < 0 ? order.length : index;
}
function evaluateProfile(version, profile) {
    const reasons = [];
    const breakdown = {};
    if (!hasRequiredLanguages(version, profile.languagePolicy)) {
        reasons.push({ code: "required_language_missing", message: `Required ${profile.languagePolicy.scope || "AUDIO"} language policy is not satisfied`, facts: { required: profile.languagePolicy.required, availableAudio: version.fingerprint.audio.map((stream) => stream.language), availableSubtitles: version.fingerprint.subtitles.map((stream) => stream.language) } });
    }
    if (!evaluateRule(profile.hardRequirements, version)) {
        reasons.push({ code: "hard_rule_failed", message: "Configured hard requirement rule is not satisfied", facts: { rule: profile.hardRequirements } });
    }
    if (profile.target === "DIRECT_PLAY" && version.fingerprint.video.resolution !== "1080p") {
        reasons.push({ code: "remote_requires_1080p", message: "REMOTE / DIRECT PLAY requires a verified 1080p version", facts: { actualResolution: version.fingerprint.video.resolution, requiredResolution: "1080p" } });
    }
    const resolutionRank = rank(version.fingerprint.video.resolution, [profile.preferredResolution, "1080p", "720p"]);
    breakdown.resolution = Math.max(0, 40 - resolutionRank * 12);
    breakdown.source = Math.max(0, 20 - rank(version.fingerprint.release.source, profile.sourceOrder) * 4);
    breakdown.codec = Math.max(0, 15 - rank(version.fingerprint.video.codec, profile.codecOrder) * 3);
    breakdown.audio = Math.max(0, 15 - rank(version.fingerprint.audio[0]?.codec, profile.audioOrder) * 3) + (version.fingerprint.audio[0]?.atmos ? 3 : 0);
    if (profile.target === "DIRECT_PLAY") {
        breakdown.bandwidth = version.fingerprint.storage.size > 0 ? Math.max(0, 20 - Math.log10(version.fingerprint.storage.size / 1000000000 + 1) * 8) : 0;
    }
    for (const [criterion, weight] of Object.entries(profile.scoring || {})) {
        const current = breakdown[criterion] || 0;
        breakdown[criterion] = current + Number(weight || 0);
    }
    for (const [index, rule] of (profile.scoringRules || []).entries()) {
        const matches = evaluateRule(rule.op === "IN" ? { op: "IN", field: rule.field, values: rule.values || [] } : rule.op === "HAS" ? { op: "HAS", field: rule.field, value: rule.value } : { op: "COMPARE", field: rule.field, operator: rule.operator || "equals", value: rule.value }, version);
        if (matches)
            breakdown[`rule:${index}`] = Number(rule.weight || 0);
    }
    const eligible = reasons.length === 0;
    const score = eligible ? Math.round(Object.values(breakdown).reduce((sum, value) => sum + value, 0) * 100) / 100 : undefined;
    if (eligible)
        reasons.push({ code: "profile_eligible", message: `Eligible for ${profile.name}`, facts: { target: profile.target } });
    return { profileId: profile.id, eligible, score, breakdown, reasons };
}
function groupKey(version) {
    const identity = version.fingerprint.identity;
    if (!identity.normalizedTitle || identity.confidence < 0.65)
        return `review:${version.id}`;
    return [identity.kind, identity.normalizedTitle, identity.year || "", identity.season ?? "", identity.episode ?? ""].join(":");
}
function evaluateVersionGroups(versions, profiles = exports.defaultVersionProfiles, policy = exports.defaultVersionManagerPolicy) {
    const groups = new Map();
    for (const version of versions)
        groups.set(groupKey(version), [...(groups.get(groupKey(version)) || []), version]);
    return [...groups.entries()].map(([id, members]) => {
        const activeProfiles = profiles.filter((profile) => profile.enabled && (profile.target !== "DIRECT_PLAY" || policy.enableRemote));
        const evaluations = members.map((version) => ({ ...version, decision: "REVIEW", evaluations: activeProfiles.map((profile) => evaluateProfile(version, profile)), reasons: [] }));
        for (const profile of activeProfiles) {
            const eligible = evaluations.filter((version) => version.fingerprint.identity.confidence >= 0.65 && version.evaluations.find((evaluation) => evaluation.profileId === profile.id)?.eligible);
            const winner = [...eligible].sort((a, b) => (b.evaluations.find((e) => e.profileId === profile.id)?.score || 0) - (a.evaluations.find((e) => e.profileId === profile.id)?.score || 0))[0];
            if (winner) {
                winner.decision = "KEEP";
                winner.satisfiesProfiles = [...new Set([...(winner.satisfiesProfiles || []), profile.id])];
                winner.reasons.push({ code: "profile_winner", message: `Best eligible version for ${profile.name}`, facts: { profile: profile.id, score: winner.evaluations.find((e) => e.profileId === profile.id)?.score } });
            }
        }
        for (const version of evaluations) {
            const hasHardRequirementFailure = version.evaluations.some((evaluation) => !evaluation.eligible);
            const recoverability = version.fingerprint.storage.recoverability?.status || (version.fingerprint.storage.infoHash ? "RECOVERABLE" : "UNKNOWN");
            const recoverable = recoverability === "RECOVERABLE";
            const safeForDelete = (policy.safety?.requireRecoverableBeforeDelete ?? true) ? recoverable : true;
            const hasSurvivingKeep = evaluations.some((candidate) => candidate.decision === "KEEP");
            if (version.decision === "REVIEW" && !hasHardRequirementFailure && version.fingerprint.identity.confidence >= 0.65 && evaluations.length > 1 && hasSurvivingKeep && safeForDelete) {
                version.decision = "DELETE_CANDIDATE";
                version.reasons.push({ code: "no_profile_slot", message: "Does not win an enabled profile in this version group", facts: { groupId: id } });
            }
            else if (version.decision === "REVIEW") {
                if (!safeForDelete && version.fingerprint.identity.confidence >= 0.65 && !hasHardRequirementFailure)
                    version.reasons.push({ code: recoverability === "NOT_RECOVERABLE" ? "recoverability_required" : "recoverability_unknown", message: recoverability === "NOT_RECOVERABLE" ? "Delete preview requires a recoverable provider item" : "Recoverability could not be established for this provider item", facts: { recoverabilityStatus: recoverability, infoHashAvailable: recoverable } });
                version.reasons.push({
                    code: hasHardRequirementFailure ? "hard_requirement_failed" : "identity_uncertain",
                    message: hasHardRequirementFailure ? "A profile hard requirement failed; operator review is required" : "Identity confidence is insufficient for an automatic candidate decision",
                    facts: { confidence: version.fingerprint.identity.confidence },
                });
            }
        }
        const primaryProfiles = activeProfiles.filter((profile) => profile.target === "QUALITY");
        const primaryWinner = primaryProfiles.some((profile) => evaluations.some((version) => version.evaluations.some((evaluation) => evaluation.profileId === profile.id && evaluation.eligible && version.decision === "KEEP")));
        const remoteProfile = activeProfiles.find((profile) => profile.target === "DIRECT_PLAY");
        const remoteWinner = remoteProfile && evaluations.some((version) => version.evaluations.some((evaluation) => evaluation.profileId === remoteProfile.id && evaluation.eligible && version.decision === "KEEP"));
        let remote;
        if (policy.enableRemote && remoteProfile && primaryWinner) {
            if (remoteWinner)
                remote = { status: "SATISFIED" };
            else {
                const identity = members[0].fingerprint.identity;
                remote = { status: "REMOTE_MISSING", reasonCode: "NO_ELIGIBLE_REMOTE_VERSION" };
                if (policy.acquireMissingRemote && identity.confidence >= 0.65 && !!(identity.tmdbId || identity.imdbId || identity.tvdbId)) {
                    remote.acquisition = { status: "ACQUISITION_NEEDED", contentIdentity: identity, profileId: remoteProfile.id, requirement: "1080p", reasonCode: "NO_ELIGIBLE_REMOTE_VERSION", confidence: identity.confidence };
                }
            }
        }
        const profileStatuses = activeProfiles.map((profile) => ({
            profileId: profile.id,
            satisfied: evaluations.some((version) => version.fingerprint.identity.confidence >= 0.65 && version.evaluations.some((evaluation) => evaluation.profileId === profile.id && evaluation.eligible && version.decision === "KEEP")),
        }));
        return { id, identity: members[0].fingerprint.identity, versions: evaluations, remote, profileStatuses };
    });
}
const OPERATOR_ALIASES = {
    eq: "equals",
    neq: "not_equals",
    gt: "greater_than",
    gte: "greater_or_equal",
    lt: "less_than",
    lte: "less_or_equal",
};
function canonicalCompare(left, right) {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
}
function canonicalValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalValue);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalValue(item)]));
}
function canonicalRule(node) {
    if (!node)
        return null;
    if (node.op === "AND" || node.op === "OR") {
        const children = node.children.map(canonicalRule).sort(canonicalCompare);
        return { op: node.op, children };
    }
    if (node.op === "NOT")
        return { op: "NOT", child: canonicalRule(node.child) };
    if (node.op === "IN") {
        const values = node.values.map(canonicalValue).sort(canonicalCompare);
        return { op: "IN", field: node.field, values };
    }
    const leaf = node;
    const operator = "operator" in leaf && leaf.operator ? OPERATOR_ALIASES[leaf.operator] || leaf.operator : undefined;
    return { op: leaf.op, field: leaf.field, ...(operator ? { operator } : {}), ...("value" in leaf ? { value: canonicalValue(leaf.value) } : {}) };
}
function canonicalScoringRule(rule) {
    const op = rule.op || "COMPARE";
    const operator = rule.operator ? OPERATOR_ALIASES[rule.operator] || rule.operator : undefined;
    if (op === "IN") {
        const values = (rule.values || []).map(canonicalValue).sort(canonicalCompare);
        return { op, field: rule.field, values, weight: rule.weight };
    }
    return { op, field: rule.field, ...(operator ? { operator } : {}), ...("value" in rule ? { value: canonicalValue(rule.value) } : {}), weight: rule.weight };
}
function canonicalLanguagePolicy(policy) {
    return {
        required: {
            mode: policy.required.mode,
            values: [...policy.required.values].map((value) => value.trim().toLowerCase()).sort(),
        },
        preferred: [...policy.preferred].map((value) => value.trim().toLowerCase()),
        original: policy.original === true,
        scope: policy.scope || "AUDIO",
    };
}
function canonicalProfile(profile) {
    return {
        id: profile.id,
        enabled: profile.enabled === true,
        priority: profile.priority ?? null,
        target: profile.target,
        preferredResolution: profile.preferredResolution,
        languagePolicy: canonicalLanguagePolicy(profile.languagePolicy),
        sourceOrder: [...profile.sourceOrder],
        codecOrder: [...profile.codecOrder],
        audioOrder: [...profile.audioOrder],
        hardRequirements: canonicalRule(profile.hardRequirements),
        maxBitrate: profile.maxBitrate ?? null,
        maxSizeBytes: profile.maxSizeBytes ?? null,
        scoring: Object.fromEntries(Object.entries(profile.scoring || {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
        scoringRules: (profile.scoringRules || []).map(canonicalScoringRule).sort(canonicalCompare),
        arrProfiles: profile.arrProfiles ? {
            movie: profile.arrProfiles.movie ? { serverId: profile.arrProfiles.movie.serverId, qualityProfileId: profile.arrProfiles.movie.qualityProfileId } : null,
            tv: profile.arrProfiles.tv ? { serverId: profile.arrProfiles.tv.serverId, qualityProfileId: profile.arrProfiles.tv.qualityProfileId } : null,
        } : null,
    };
}
/** Hashes the complete decision configuration; policyVersion is revision metadata, not content identity. */
function versionManagerPolicyHash(policy, profiles = exports.defaultVersionProfiles) {
    const normalized = {
        policy: {
            enableRemote: policy.enableRemote === true,
            acquireMissingRemote: policy.acquireMissingRemote === true,
            preferCompletePack: policy.preferCompletePack === true,
            safety: { ...exports.defaultVersionManagerPolicy.safety, ...(policy.safety || {}) },
        },
        profiles: profiles.map(canonicalProfile),
    };
    return (0, node_crypto_1.createHash)("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}
