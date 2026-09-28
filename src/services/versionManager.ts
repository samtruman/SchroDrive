import type { TorrentInfo } from "../providers";
import { normalizeMediaTitle, parseMediaFilename } from "./mediaParser";

export type VersionDecision = "KEEP" | "DELETE_CANDIDATE" | "REVIEW";
export type VersionTarget = "QUALITY" | "DIRECT_PLAY" | string;
export type LanguageMode = "ANY" | "ALL";

export interface VersionManagerPolicy {
  enableRemote: boolean;
  acquireMissingRemote: boolean;
}

export interface AcquisitionIntent {
  status: "ACQUISITION_NEEDED";
  contentIdentity: MediaFingerprint["identity"];
  profileId: string;
  requirement: "1080p";
  reasonCode: "NO_ELIGIBLE_REMOTE_VERSION";
  confidence: number;
}

export interface RemoteStatus {
  status: "SATISFIED" | "REMOTE_MISSING";
  reasonCode?: "NO_ELIGIBLE_REMOTE_VERSION";
  acquisition?: AcquisitionIntent;
}

export interface LanguagePolicy {
  required: { values: string[]; mode: LanguageMode };
  preferred: string[];
  original: boolean;
}

export interface VersionProfile {
  id: string;
  name: string;
  enabled: boolean;
  target: VersionTarget;
  preferredResolution: string;
  languagePolicy: LanguagePolicy;
  sourceOrder: string[];
  codecOrder: string[];
  audioOrder: string[];
  hardRequirements?: RuleNode;
  maxBitrate?: number;
  maxSizeBytes?: number;
}

export type RuleNode =
  | { op: "AND" | "OR"; children: RuleNode[] }
  | { op: "NOT"; child: RuleNode }
  | { op: "COMPARE"; field: string; operator: CompareOperator; value: unknown }
  | { op: "IN"; field: string; values: unknown[] }
  | { op: "HAS"; field: string; value: unknown };

type CompareOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

const RULE_FIELDS = new Set(["resolution", "source", "codec", "bitrate", "size", "audioCodec", "audioLanguage", "channels", "profileEligible"]);

export function validateRule(node: unknown, depth = 0): RuleNode {
  if (depth > 8 || !node || typeof node !== "object" || Array.isArray(node)) throw new Error("Invalid version rule");
  const value = node as Record<string, unknown>;
  const op = value.op;
  if (op === "AND" || op === "OR") {
    if (!Array.isArray(value.children) || value.children.length === 0) throw new Error(`${op} requires children`);
    return { op, children: value.children.map((child) => validateRule(child, depth + 1)) };
  }
  if (op === "NOT") return { op, child: validateRule(value.child, depth + 1) };
  if (op === "COMPARE" && RULE_FIELDS.has(String(value.field)) && ["eq", "neq", "gt", "gte", "lt", "lte"].includes(String(value.operator))) {
    return { op, field: String(value.field), operator: value.operator as CompareOperator, value: value.value };
  }
  if (op === "IN" && RULE_FIELDS.has(String(value.field)) && Array.isArray(value.values)) return { op, field: String(value.field), values: value.values };
  if (op === "HAS" && RULE_FIELDS.has(String(value.field))) return { op, field: String(value.field), value: value.value };
  throw new Error("Invalid version rule field or operator");
}

function ruleField(version: VersionRecord, field: string, profileEligible = true): unknown {
  const fingerprint = version.fingerprint;
  return ({
    resolution: fingerprint.video.resolution,
    source: fingerprint.release.source,
    codec: fingerprint.video.codec,
    bitrate: fingerprint.video.bitrate,
    size: fingerprint.storage.size,
    audioCodec: fingerprint.audio[0]?.codec,
    audioLanguage: fingerprint.audio.map((stream) => stream.language),
    channels: fingerprint.audio[0]?.channels,
    profileEligible,
  } as Record<string, unknown>)[field];
}

export function evaluateRule(node: RuleNode | undefined, version: VersionRecord, profileEligible = true): boolean {
  if (!node) return true;
  if (node.op === "AND") return node.children.every((child) => evaluateRule(child, version, profileEligible));
  if (node.op === "OR") return node.children.some((child) => evaluateRule(child, version, profileEligible));
  if (node.op === "NOT") return !evaluateRule(node.child, version, profileEligible);
  if (node.op === "HAS") {
    const actual = ruleField(version, node.field, profileEligible);
    return Array.isArray(actual) ? actual.includes(node.value) : actual === node.value;
  }
  if (node.op === "IN") return node.values.includes(ruleField(version, node.field, profileEligible));
  const comparison = node as Extract<RuleNode, { op: "COMPARE" }>;
  const actual = ruleField(version, comparison.field, profileEligible);
  if (comparison.operator === "eq") return actual === comparison.value;
  if (comparison.operator === "neq") return actual !== comparison.value;
  if (comparison.operator === "gt") return Number(actual) > Number(comparison.value);
  if (comparison.operator === "gte") return Number(actual) >= Number(comparison.value);
  if (comparison.operator === "lt") return Number(actual) < Number(comparison.value);
  return Number(actual) <= Number(comparison.value);
}

export interface MediaFingerprint {
  identity: {
    tmdbId?: string;
    imdbId?: string;
    tvdbId?: string;
    title?: string;
    normalizedTitle?: string;
    year?: number;
    kind?: "movie" | "episode" | "unknown";
    season?: number;
    episode?: number;
    episodeEnd?: number;
    originalLanguage?: string;
    confidence: number;
    source: "filename" | "provider" | "unknown";
    resolutionStatus?: IdentityResolutionStatus;
    conflicts?: IdentityConflict[];
    provenance?: Record<string, Provenance>;
  };
  video: {
    resolution?: string;
    width?: number;
    height?: number;
    codec?: string;
    bitrate?: number;
    bitDepth?: number;
    hdr10?: boolean;
    hdr10Plus?: boolean;
    dolbyVision?: boolean;
    container?: string;
    hdrFormat?: string;
    provenance?: Record<string, Provenance>;
  };
  audio: Array<{ language: string; codec?: string; channels?: number; bitrate?: number; atmos?: boolean; provenance?: Record<string, Provenance> }>;
  subtitles: Array<{ language: string; codec?: string; forced?: boolean; provenance?: Record<string, Provenance> }>;
  release: { source?: string; group?: string; provenance?: Record<string, Provenance> };
  storage: { provider: string; torrentId: string; fileId?: string; path: string; size: number; addedAt?: string; provenance?: Record<string, Provenance> };
  probe: { status: "not_requested" | "complete" | "unavailable" | "error"; tool: "filename" | "provider" | "ffprobe"; version?: string; error?: string };
}

export type Provenance = "ALLDEBRID" | "FILENAME" | "FFPROBE" | "PLEX" | "JELLYFIN" | "TMDB" | "TVDB" | "IMDB" | "UNKNOWN";

export type IdentityResolutionStatus = "resolved" | "fallback" | "uncertain" | "conflict";

export interface IdentityConflict {
  code: string;
  field: string;
  values: Array<{ value: string; source: Provenance }>;
}

export interface VersionRecord {
  id: string;
  fingerprint: MediaFingerprint;
}

export interface Reason {
  code: string;
  message: string;
  facts: Record<string, unknown>;
}

export interface ProfileEvaluation {
  profileId: string;
  eligible: boolean;
  score?: number;
  breakdown: Record<string, number>;
  reasons: Reason[];
}

export interface VersionEvaluation extends VersionRecord {
  decision: VersionDecision;
  evaluations: ProfileEvaluation[];
  reasons: Reason[];
}

export interface VersionGroup {
  id: string;
  identity: MediaFingerprint["identity"];
  versions: VersionEvaluation[];
  remote?: RemoteStatus;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ita: "ita", italian: "ita", eng: "eng", english: "eng", original: "original",
  fre: "fra", french: "fra", ger: "deu", german: "deu", spa: "spa", spanish: "spa",
  jpn: "ja", japanese: "ja", ja: "ja", zho: "zh", chi: "zh", kor: "ko", rus: "ru",
};

export const MEDIA_FILE_EXTENSIONS = new Set(["mkv", "mp4", "m4v", "avi", "ts", "m2ts", "webm"]);

export function isMediaFileName(name: string): boolean {
  const basename = name.trim().split(/[\\/]/).pop() || "";
  const extension = basename.toLowerCase().split(".").pop();
  if (!extension || !MEDIA_FILE_EXTENSIONS.has(extension)) return false;
  return !/(^|[._ -])sample([._ -]|$)/i.test(basename);
}

function languagesFromName(name: string): string[] {
  const upper = name.toUpperCase();
  return Object.entries(LANGUAGE_ALIASES)
    .filter(([token]) => new RegExp(`(^|[. _-])${token.toUpperCase()}([. _-]|$)`).test(upper))
    .map(([, value]) => value)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function firstMatch(name: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return undefined;
}

function inferResolution(name: string): string | undefined {
  const value = firstMatch(name, [/(4320p|2160p|1440p|1080p|720p|576p|480p)/i]);
  return value?.toLowerCase();
}

function inferSource(name: string): string | undefined {
  return firstMatch(name, [/(remux|bdremux)/i, /(bluray|blu-ray)/i, /(web[- .]?dl|webmux)/i, /(webrip)/i, /(hdtv)/i])?.replace("BDREMUX", "REMUX").replace("BLU-RAY", "BLURAY").replace("WEBMUX", "WEB-DL");
}

function inferCodec(name: string): string | undefined {
  return firstMatch(name, [/(av1)/i, /(x265|h\.265|h265|hevc)/i, /(x264|h\.264|h264|avc)/i])?.replace("X265", "HEVC").replace("H.265", "HEVC").replace("H265", "HEVC").replace("X264", "H264").replace("H.264", "H264");
}

function inferAudio(name: string): { codec?: string; channels?: number; atmos?: boolean } {
  const upper = name.toUpperCase();
  return {
    codec: firstMatch(name, [/(TRUEHD)/i, /(DTS[- .]?HD(?:[- .]?MA)?)/i, /(DDP|EAC3)/i, /(AC3|AAC)/i]),
    channels: upper.match(/(?:DDP|DD|AAC|DTS|TRUEHD)[. _-]?(\d(?:\.\d)?)/i)?.[1] ? Number(upper.match(/(?:DDP|DD|AAC|DTS|TRUEHD)[. _-]?(\d(?:\.\d)?)/i)?.[1]) : undefined,
    atmos: /ATMOS/i.test(name),
  };
}

export function fingerprintTorrent(torrent: TorrentInfo, provider = "unknown"): VersionRecord[] {
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
    const parsed = parseMediaFilename(file.name || path, path);
    const name = (file.name || path).trim();
    const languages = languagesFromName(name);
    const audio = inferAudio(name);
    return {
      id: `${provider}:${torrent.id}:${file.id}`,
      fingerprint: {
        identity: {
          title: parsed.title,
          normalizedTitle: parsed.title ? normalizeMediaTitle(parsed.title) : undefined,
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
        storage: { provider, torrentId: torrent.id, fileId: file.id, path, size: file.size || torrent.bytes, addedAt: torrent.addedAt?.toISOString(), provenance: { provider: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", torrentId: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", path: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", size: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN" } },
        probe: { status: "not_requested", tool: "filename" },
      },
    };
  });
}

export const defaultVersionProfiles: VersionProfile[] = [
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

export const defaultVersionManagerPolicy: VersionManagerPolicy = {
  enableRemote: false,
  acquireMissingRemote: false,
};

function hasRequiredLanguages(version: VersionRecord, policy: LanguagePolicy): boolean {
  const available = new Set(version.fingerprint.audio.map((stream) => LANGUAGE_ALIASES[stream.language.toLowerCase()] || stream.language.toLowerCase()));
  const required = policy.required.values.map((value) => LANGUAGE_ALIASES[value.toLowerCase()] || value.toLowerCase());
  const original = version.fingerprint.identity.originalLanguage ? LANGUAGE_ALIASES[version.fingerprint.identity.originalLanguage.toLowerCase()] || version.fingerprint.identity.originalLanguage.toLowerCase() : undefined;
  const hasOriginal = Boolean(original && available.has(original));
  const matches = (value: string) => value === "original" ? hasOriginal : available.has(value);
  return policy.required.mode === "ANY" ? required.length === 0 || required.some(matches) : required.every(matches);
}

function rank(value: string | undefined, order: string[]): number {
  if (!value) return order.length + 1;
  const index = order.findIndex((entry) => entry.toLowerCase() === value.toLowerCase());
  return index < 0 ? order.length : index;
}

function evaluateProfile(version: VersionRecord, profile: VersionProfile): ProfileEvaluation {
  const reasons: Reason[] = [];
  const breakdown: Record<string, number> = {};
  if (!hasRequiredLanguages(version, profile.languagePolicy)) {
    reasons.push({ code: "required_language_missing", message: "Required audio language policy is not satisfied", facts: { required: profile.languagePolicy.required, available: version.fingerprint.audio.map((stream) => stream.language) } });
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
    breakdown.bandwidth = version.fingerprint.storage.size > 0 ? Math.max(0, 20 - Math.log10(version.fingerprint.storage.size / 1_000_000_000 + 1) * 8) : 0;
  }
  const eligible = reasons.length === 0;
  const score = eligible ? Math.round(Object.values(breakdown).reduce((sum, value) => sum + value, 0) * 100) / 100 : undefined;
  if (eligible) reasons.push({ code: "profile_eligible", message: `Eligible for ${profile.name}`, facts: { target: profile.target } });
  return { profileId: profile.id, eligible, score, breakdown, reasons };
}

function groupKey(version: VersionRecord): string {
  const identity = version.fingerprint.identity;
  if (!identity.normalizedTitle || identity.confidence < 0.65) return `review:${version.id}`;
  return [identity.kind, identity.normalizedTitle, identity.year || "", identity.season ?? "", identity.episode ?? ""].join(":");
}

export function evaluateVersionGroups(versions: VersionRecord[], profiles = defaultVersionProfiles, policy: VersionManagerPolicy = defaultVersionManagerPolicy): VersionGroup[] {
  const groups = new Map<string, VersionRecord[]>();
  for (const version of versions) groups.set(groupKey(version), [...(groups.get(groupKey(version)) || []), version]);
  return [...groups.entries()].map(([id, members]) => {
    const activeProfiles = profiles.filter((profile) => profile.enabled && (profile.target !== "DIRECT_PLAY" || policy.enableRemote));
    const evaluations = members.map((version): VersionEvaluation => ({ ...version, decision: "REVIEW", evaluations: activeProfiles.map((profile) => evaluateProfile(version, profile)), reasons: [] }));
    for (const profile of activeProfiles) {
      const eligible = evaluations.filter((version) => version.fingerprint.identity.confidence >= 0.65 && version.evaluations.find((evaluation) => evaluation.profileId === profile.id)?.eligible);
      const winner = [...eligible].sort((a, b) => (b.evaluations.find((e) => e.profileId === profile.id)?.score || 0) - (a.evaluations.find((e) => e.profileId === profile.id)?.score || 0))[0];
      if (winner) {
        winner.decision = "KEEP";
        winner.reasons.push({ code: "profile_winner", message: `Best eligible version for ${profile.name}`, facts: { profile: profile.id, score: winner.evaluations.find((e) => e.profileId === profile.id)?.score } });
      }
    }
    for (const version of evaluations) {
      const hasHardRequirementFailure = version.evaluations.some((evaluation) => !evaluation.eligible);
      if (version.decision === "REVIEW" && !hasHardRequirementFailure && version.fingerprint.identity.confidence >= 0.65 && evaluations.length > 1) {
        version.decision = "DELETE_CANDIDATE";
        version.reasons.push({ code: "no_profile_slot", message: "Does not win an enabled profile in this version group", facts: { groupId: id } });
      } else if (version.decision === "REVIEW") {
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
    let remote: RemoteStatus | undefined;
    if (policy.enableRemote && remoteProfile && primaryWinner) {
      if (remoteWinner) remote = { status: "SATISFIED" };
      else {
        const identity = members[0].fingerprint.identity;
        remote = { status: "REMOTE_MISSING", reasonCode: "NO_ELIGIBLE_REMOTE_VERSION" };
        if (policy.acquireMissingRemote && identity.confidence >= 0.65 && !!(identity.tmdbId || identity.imdbId || identity.tvdbId)) {
          remote.acquisition = { status: "ACQUISITION_NEEDED", contentIdentity: identity, profileId: remoteProfile.id, requirement: "1080p", reasonCode: "NO_ELIGIBLE_REMOTE_VERSION", confidence: identity.confidence };
        }
      }
    }
    return { id, identity: members[0].fingerprint.identity, versions: evaluations, remote };
  });
}
