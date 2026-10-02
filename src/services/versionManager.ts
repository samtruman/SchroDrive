import type { RecoverabilityEvidence, TorrentInfo } from "../providers";
import { normalizeMediaTitle, parseMediaFilename } from "./mediaParser";
import { evaluateRecoverability } from "./migrationExporter";
import { createHash } from "node:crypto";

export type VersionDecision = "KEEP" | "DELETE_CANDIDATE" | "REVIEW";
export type VersionTarget = "QUALITY" | "DIRECT_PLAY" | string;
export type LanguageMode = "ANY" | "ALL";

export interface VersionManagerPolicy {
  enableRemote: boolean;
  acquireMissingRemote: boolean;
  acquisitionMode?: "ARR" | "NATIVE";
  /** Prefer complete season packs when physical delete impact is evaluated. */
  preferCompletePack?: boolean;
  safety?: SafetyPolicy;
  policyVersion?: string;
}

export interface SafetyPolicy {
  /** When true, delete actions validate the current provider item but never call the provider delete API. */
  deleteDryRun: boolean;
  requireRecoverableBeforeDelete: boolean;
  allowDeleteWhenIdentityUncertain: boolean;
  allowDeleteWhenMetadataIncomplete: boolean;
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
  /** Legacy combined language policy, retained for stored configuration compatibility. */
  required: { values: string[]; mode: LanguageMode };
  preferred: string[];
  original: boolean;
  scope?: "AUDIO" | "SUBTITLE" | "AUDIO_OR_SUBTITLE";
  /** What to do with a non-compliant version when a compliant replacement exists. */
  missingRequiredAction?: "REVIEW" | "DELETE_IF_REPLACED";
  audio?: {
    required: { values: string[]; mode: LanguageMode };
    preferred: string[];
    original: boolean;
    missingRequiredAction?: "REVIEW" | "DELETE_IF_REPLACED";
  };
  subtitles?: {
    required: { values: string[]; mode: LanguageMode };
    preferred: string[];
    missingRequiredAction?: "REVIEW" | "DELETE_IF_REPLACED";
  };
}

export interface VersionProfile {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
  priority?: number;
  target: VersionTarget;
  preferredResolution: string;
  languagePolicy: LanguagePolicy;
  sourceOrder: string[];
  codecOrder: string[];
  audioOrder: string[];
  hardRequirements?: RuleNode;
  maxBitrate?: number;
  maxSizeBytes?: number;
  scoring?: Record<string, number>;
  /** Structured scoring rules; `scoring` remains for backwards compatibility. */
  scoringRules?: ScoringRule[];
  /** Final tie-breaker between otherwise equally ranked versions at the same resolution. */
  sizePreference?: "LARGER" | "SMALLER" | "IGNORE";
  /** Ignore insignificant size differences when applying the size tie-breaker. */
  minimumSizeDifferencePercent?: number;
  /** Prefer one release group consistently when comparing episodes in a season. */
  releaseGroupConsistency?: "DISABLED" | "SEASON";
  acquisitionBehavior?: "AUTOMATIC" | "APPROVAL_REQUIRED" | "DISABLED";
  /** Read-only acquisition mapping discovered from Seerr's ARR settings. */
  arrProfiles?: {
    movie?: { provider?: "radarr"; serverId: string; qualityProfileId: string; qualityProfileName?: string };
    tv?: { provider?: "sonarr"; serverId: string; qualityProfileId: string; qualityProfileName?: string };
  };
}

export type RuleNode =
  | { op: "AND" | "OR"; children: RuleNode[] }
  | { op: "NOT"; child: RuleNode }
  | { op: "COMPARE"; field: string; operator: CompareOperator; value: unknown }
  | { op: "IN"; field: string; values: unknown[] }
  | { op: "HAS"; field: string; value: unknown };

export type CompareOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "equals" | "not_equals" | "greater_than" | "greater_or_equal" | "less_than" | "less_or_equal" | "contains" | "not_contains" | "exists" | "not_exists";

const RULE_FIELDS = new Set(["resolution", "source", "codec", "bitrate", "size", "fileSize", "audioCodec", "audioLanguage", "subtitleLanguage", "channels", "atmos", "hdr", "dolbyVision", "container", "originalLanguage", "identityConfidence", "mediaType", "profileEligible"]);
const NUMERIC_RULE_FIELDS = new Set(["bitrate", "size", "fileSize", "channels", "identityConfidence"]);
const BOOLEAN_RULE_FIELDS = new Set(["atmos", "hdr", "dolbyVision", "profileEligible"]);

function validateRuleValue(field: string, value: unknown): void {
  if (value === undefined || value === null || value === "") throw new Error("Rule value is required for this operator");
  if (NUMERIC_RULE_FIELDS.has(field) && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Rule value for ${field} must be numeric`);
  if (BOOLEAN_RULE_FIELDS.has(field) && typeof value !== "boolean") throw new Error(`Rule value for ${field} must be boolean`);
}

export function validateRule(node: unknown, depth = 0): RuleNode {
  if (depth > 8 || !node || typeof node !== "object" || Array.isArray(node)) throw new Error("Invalid version rule");
  const value = node as Record<string, unknown>;
  const op = value.op;
  if (op === "AND" || op === "OR") {
    if (!Array.isArray(value.children) || (op === "OR" && value.children.length === 0)) throw new Error(`${op} requires children`);
    return { op, children: value.children.map((child) => validateRule(child, depth + 1)) };
  }
  if (op === "NOT") return { op, child: validateRule(value.child, depth + 1) };
  if (op === "COMPARE" && RULE_FIELDS.has(String(value.field)) && ["eq", "neq", "gt", "gte", "lt", "lte", "equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "contains", "not_contains", "exists", "not_exists"].includes(String(value.operator))) {
    if (!(["exists", "not_exists"].includes(String(value.operator)))) validateRuleValue(String(value.field), value.value);
    return { op, field: String(value.field), operator: value.operator as CompareOperator, value: value.value };
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

export interface ScoringRule {
  op?: "COMPARE" | "IN" | "HAS";
  field: string;
  operator?: CompareOperator;
  value?: unknown;
  values?: unknown[];
  weight: number;
}

export function validateScoringRule(rule: unknown): ScoringRule {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("Invalid scoring rule");
  const value = rule as Record<string, unknown>;
  const weight = Number(value.weight);
  if (!Number.isFinite(weight)) throw new Error("Scoring rule weight must be finite");
  const op = value.op || "COMPARE";
  if (op === "COMPARE") {
    const validated = validateRule({ op, field: value.field, operator: value.operator, value: value.value });
    if (validated.op !== "COMPARE") throw new Error("Invalid scoring comparison");
    return { ...validated, weight };
  }
  if (op === "IN") {
    const validated = validateRule({ op, field: value.field, values: value.values });
    if (validated.op !== "IN") throw new Error("Invalid scoring IN rule");
    return { ...validated, weight };
  }
  if (op === "HAS") {
    const validated = validateRule({ op, field: value.field, value: value.value });
    if (validated.op !== "HAS") throw new Error("Invalid scoring HAS rule");
    return { ...validated, weight };
  }
  throw new Error("Invalid scoring rule operator");
}

export function validateScoringRules(rules: unknown): ScoringRule[] {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) throw new Error("scoringRules must be an array");
  return rules.map(validateScoringRule);
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
  const operator = comparison.operator;
  if (operator === "exists" || operator === "not_exists") return operator === "exists" ? actual !== undefined && actual !== null && actual !== "" : actual === undefined || actual === null || actual === "";
  if (operator === "eq" || operator === "equals") return actual === comparison.value;
  if (operator === "neq" || operator === "not_equals") return actual !== comparison.value;
  if (operator === "contains" || operator === "not_contains") {
    const result = Array.isArray(actual) ? actual.includes(comparison.value) : String(actual ?? "").toLowerCase().includes(String(comparison.value).toLowerCase());
    return operator === "contains" ? result : !result;
  }
  if (operator === "gt" || operator === "greater_than") return Number(actual) > Number(comparison.value);
  if (operator === "gte" || operator === "greater_or_equal") return Number(actual) >= Number(comparison.value);
  if (operator === "lt" || operator === "less_than") return Number(actual) < Number(comparison.value);
  return Number(actual) <= Number(comparison.value);
}

export interface MediaFingerprint {
  identity: {
    tmdbId?: string;
    imdbId?: string;
    tvdbId?: string;
    title?: string;
    originalTitle?: string;
    normalizedTitle?: string;
    year?: number;
    kind?: "movie" | "episode" | "unknown";
    season?: number;
    episode?: number;
    episodeEnd?: number;
    originalLanguage?: string;
    confidence: number;
    source: "filename" | "provider" | "manual" | "unknown";
    resolutionStatus?: IdentityResolutionStatus;
    conflicts?: IdentityConflict[];
    descriptiveDisagreements?: IdentityConflict[];
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
  storage: { provider: string; torrentId: string; fileId?: string; path: string; size: number; infoHash?: string; addedAt?: string; recoverability?: RecoverabilityEvidence; provenance?: Record<string, Provenance> };
  probe: { status: "not_requested" | "complete" | "unavailable" | "error"; tool: "filename" | "provider" | "ffprobe"; version?: string; error?: string };
}

export type ContentIdentity = MediaFingerprint["identity"];

export type Provenance = "ALLDEBRID" | "FILENAME" | "FFPROBE" | "PLEX" | "JELLYFIN" | "TMDB" | "TVDB" | "IMDB" | "MANUAL" | "UNKNOWN";

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

export interface ProfileStatus {
  profileId: string;
  satisfied: boolean;
}

export interface VersionEvaluation extends VersionRecord {
  decision: VersionDecision;
  evaluations: ProfileEvaluation[];
  reasons: Reason[];
  satisfiesProfiles?: string[];
}

export interface VersionGroup {
  id: string;
  identity: MediaFingerprint["identity"];
  versions: VersionEvaluation[];
  remote?: RemoteStatus;
  /** Generic profile state used by acquisition; REMOTE remains a compatibility view. */
  profileStatuses?: ProfileStatus[];
}

/** CineCircle's former Riven aliases, normalized to ISO-639-2 where possible. */
const LANGUAGE_ALIASES: Record<string, string> = {
  it: "ita", ita: "ita", italian: "ita", italiano: "ita",
  en: "eng", eng: "eng", english: "eng", inglese: "eng",
  es: "spa", esp: "spa", spa: "spa", spanish: "spa", espanol: "spa", "español": "spa",
  fr: "fra", fre: "fra", fra: "fra", french: "fra", francais: "fra", "français": "fra",
  de: "deu", ger: "deu", deu: "deu", german: "deu", deutsch: "deu",
  pt: "por", por: "por", portuguese: "por", portugues: "por", "português": "por",
  ja: "jpn", jpn: "jpn", japanese: "jpn",
  ko: "kor", kor: "kor", korean: "kor",
  zh: "zho", chi: "zho", zho: "zho", chinese: "zho",
  ru: "rus", rus: "rus", russian: "rus",
  nl: "nld", dut: "nld", nld: "nld", dutch: "nld", nederlands: "nld",
  pl: "pol", pol: "pol", polish: "pol", polski: "pol",
  tr: "tur", tur: "tur", turkish: "tur", turkce: "tur", "türkçe": "tur",
  he: "heb", heb: "heb", hebrew: "heb",
  original: "original",
};

function normalizeLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized] || normalized;
}

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
    const recoverability = evaluateRecoverability(torrent);
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
        // Unknown language must stay unknown. Assuming English here could turn
        // incomplete filename evidence into a destructive retention decision.
        audio: languages.map((language) => ({ language, ...audio, provenance: { language: "FILENAME", codec: "FILENAME", channels: "FILENAME", atmos: "FILENAME" } })),
        subtitles: [], release: { source: inferSource(name), group: name.match(/-([A-Za-z0-9]+)(?:\.[^.]+)?$/)?.[1], provenance: { source: "FILENAME", group: "FILENAME" } },
        storage: { provider, torrentId: torrent.id, fileId: file.id, path, size: file.size || torrent.bytes, infoHash: torrent.infoHash || torrent.raw?.infoHash || torrent.raw?.infohash || torrent.raw?.hash || torrent.raw?.hashString, recoverability, addedAt: torrent.addedAt?.toISOString(), provenance: { provider: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", torrentId: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", path: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", size: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN", infoHash: provider === "alldebrid" ? "ALLDEBRID" : "UNKNOWN" } },
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
    sizePreference: "LARGER", minimumSizeDifferencePercent: 10, releaseGroupConsistency: "DISABLED",
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
  acquisitionMode: "ARR",
  preferCompletePack: false,
  safety: { deleteDryRun: true, requireRecoverableBeforeDelete: true, allowDeleteWhenIdentityUncertain: false, allowDeleteWhenMetadataIncomplete: false },
  policyVersion: "1",
};

type TrackLanguagePolicy = {
  required: { values: string[]; mode: LanguageMode };
  preferred: string[];
  original?: boolean;
  missingRequiredAction?: "REVIEW" | "DELETE_IF_REPLACED";
};

function emptyTrackLanguagePolicy(): TrackLanguagePolicy {
  return { required: { values: [], mode: "ALL" }, preferred: [], original: false, missingRequiredAction: "REVIEW" };
}

function resolvedTrackLanguagePolicies(policy: LanguagePolicy): { audio: TrackLanguagePolicy; subtitles: TrackLanguagePolicy; legacyCombined?: boolean } {
  if (policy.audio || policy.subtitles) {
    return {
      audio: { ...emptyTrackLanguagePolicy(), ...(policy.audio || {}), required: { ...emptyTrackLanguagePolicy().required, ...(policy.audio?.required || {}) } },
      subtitles: { ...emptyTrackLanguagePolicy(), ...(policy.subtitles || {}), required: { ...emptyTrackLanguagePolicy().required, ...(policy.subtitles?.required || {}) } },
    };
  }
  const legacy = { required: policy.required, preferred: policy.preferred, original: policy.original, missingRequiredAction: policy.missingRequiredAction };
  if (policy.scope === "SUBTITLE") return { audio: emptyTrackLanguagePolicy(), subtitles: legacy };
  if (policy.scope === "AUDIO_OR_SUBTITLE") return { audio: legacy, subtitles: legacy, legacyCombined: true };
  return { audio: legacy, subtitles: emptyTrackLanguagePolicy() };
}

function matchesRequiredLanguages(required: TrackLanguagePolicy["required"], available: Set<string>, original?: string): boolean {
  const values = required.values.map(normalizeLanguage);
  const matches = (value: string) => {
    const resolved = value === "original" ? original : value;
    return Boolean(resolved && available.has(resolved));
  };
  return required.mode === "ANY" ? values.length === 0 || values.some(matches) : values.every(matches);
}

function languageRequirementFailures(version: VersionRecord, policy: LanguagePolicy): Array<{ kind: "audio" | "subtitles"; policy: TrackLanguagePolicy }> {
  const resolved = resolvedTrackLanguagePolicies(policy);
  const audio = new Set(version.fingerprint.audio.map((stream) => normalizeLanguage(stream.language)));
  const subtitles = new Set(version.fingerprint.subtitles.map((stream) => normalizeLanguage(stream.language)));
  const original = version.fingerprint.identity.originalLanguage ? normalizeLanguage(version.fingerprint.identity.originalLanguage) : undefined;
  if (resolved.legacyCombined) {
    const required = resolved.audio.required;
    const combined = new Set([...audio, ...subtitles]);
    return matchesRequiredLanguages(required, combined, original) ? [] : [{ kind: "audio", policy: resolved.audio }];
  }
  const failures: Array<{ kind: "audio" | "subtitles"; policy: TrackLanguagePolicy }> = [];
  if (!matchesRequiredLanguages(resolved.audio.required, audio, original)) failures.push({ kind: "audio", policy: resolved.audio });
  if (!matchesRequiredLanguages(resolved.subtitles.required, subtitles, original)) failures.push({ kind: "subtitles", policy: resolved.subtitles });
  return failures;
}

function preferredTrackLanguageScore(available: Set<string>, policy: TrackLanguagePolicy, original?: string): number {
  let score = 0;
  policy.preferred.map(normalizeLanguage).forEach((language, index) => {
    if (available.has(language)) score = Math.max(score, 1_000 - index * 50);
  });
  if (policy.original && original && available.has(original)) score += 500;
  return score;
}

function preferredLanguageScore(version: VersionRecord, policy: LanguagePolicy): number {
  const resolved = resolvedTrackLanguagePolicies(policy);
  const original = version.fingerprint.identity.originalLanguage ? normalizeLanguage(version.fingerprint.identity.originalLanguage) : undefined;
  const audio = new Set(version.fingerprint.audio.map((stream) => normalizeLanguage(stream.language)));
  const subtitles = new Set(version.fingerprint.subtitles.map((stream) => normalizeLanguage(stream.language)));
  return preferredTrackLanguageScore(audio, resolved.audio, original) + preferredTrackLanguageScore(subtitles, resolved.subtitles, original) / 10;
}

function rank(value: string | undefined, order: string[]): number {
  if (!value) return order.length + 1;
  const index = order.findIndex((entry) => entry.toLowerCase() === value.toLowerCase());
  return index < 0 ? order.length : index;
}

function evaluateProfile(version: VersionRecord, profile: VersionProfile): ProfileEvaluation {
  const reasons: Reason[] = [];
  const breakdown: Record<string, number> = {};
  for (const failure of languageRequirementFailures(version, profile.languagePolicy)) {
    reasons.push({
      code: failure.kind === "audio" ? "required_audio_language_missing" : "required_subtitle_language_missing",
      message: `Required ${failure.kind === "audio" ? "audio" : "subtitle"} language policy is not satisfied`,
      facts: { required: failure.policy.required, availableAudio: version.fingerprint.audio.map((stream) => stream.language), availableSubtitles: version.fingerprint.subtitles.map((stream) => stream.language) },
    });
  }
  if (!evaluateRule(profile.hardRequirements, version)) {
    reasons.push({ code: "hard_rule_failed", message: "Configured hard requirement rule is not satisfied", facts: { rule: profile.hardRequirements } });
  }
  if (profile.target === "DIRECT_PLAY" && version.fingerprint.video.resolution !== "1080p") {
    reasons.push({ code: "remote_requires_1080p", message: "REMOTE / DIRECT PLAY requires a verified 1080p version", facts: { actualResolution: version.fingerprint.video.resolution, requiredResolution: "1080p" } });
  }
  const resolutionRank = rank(version.fingerprint.video.resolution, [profile.preferredResolution, "1080p", "720p"]);
  breakdown.resolution = Math.max(0, 40 - resolutionRank * 12);
  // Source, codec and audio codec describe a file but do not prove visual or
  // audible quality. They affect ranking only through explicit custom rules.
  breakdown.language = preferredLanguageScore(version, profile.languagePolicy);
  if (profile.target === "DIRECT_PLAY") {
    breakdown.bandwidth = version.fingerprint.storage.size > 0 ? Math.max(0, 20 - Math.log10(version.fingerprint.storage.size / 1_000_000_000 + 1) * 8) : 0;
  }
  for (const [criterion, weight] of Object.entries(profile.scoring || {})) {
    const current = breakdown[criterion] || 0;
    breakdown[criterion] = current + Number(weight || 0);
  }
  for (const [index, rule] of (profile.scoringRules || []).entries()) {
    const matches = evaluateRule(
      rule.op === "IN" ? { op: "IN", field: rule.field, values: rule.values || [] } : rule.op === "HAS" ? { op: "HAS", field: rule.field, value: rule.value } : { op: "COMPARE", field: rule.field, operator: rule.operator || "equals", value: rule.value },
      version,
    );
    if (matches) breakdown[`rule:${index}`] = Number(rule.weight || 0);
  }
  const eligible = reasons.length === 0;
  const score = eligible ? Math.round(Object.values(breakdown).reduce((sum, value) => sum + value, 0) * 100) / 100 : undefined;
  if (eligible) reasons.push({ code: "profile_eligible", message: `Eligible for ${profile.name}`, facts: { target: profile.target } });
  return { profileId: profile.id, eligible, score, breakdown, reasons };
}

function compareForProfile(left: VersionEvaluation, right: VersionEvaluation, profile: VersionProfile): number {
  const leftScore = left.evaluations.find((evaluation) => evaluation.profileId === profile.id)?.score || 0;
  const rightScore = right.evaluations.find((evaluation) => evaluation.profileId === profile.id)?.score || 0;
  if (leftScore !== rightScore) return rightScore - leftScore;
  const preference = profile.sizePreference || "IGNORE";
  if (preference === "IGNORE") return 0;
  if (left.fingerprint.video.resolution !== right.fingerprint.video.resolution) return 0;
  const leftSize = Number(left.fingerprint.storage.size || 0);
  const rightSize = Number(right.fingerprint.storage.size || 0);
  if (!leftSize || !rightSize || leftSize === rightSize) return 0;
  const difference = Math.abs(leftSize - rightSize) / Math.max(leftSize, rightSize) * 100;
  if (difference < Math.max(0, Number(profile.minimumSizeDifferencePercent || 0))) return 0;
  return preference === "LARGER" ? rightSize - leftSize : leftSize - rightSize;
}

function languageFailuresCanBeRemoved(profile: VersionProfile, reasons: Reason[]): boolean {
  const resolved = resolvedTrackLanguagePolicies(profile.languagePolicy);
  return reasons.length > 0 && reasons.every((reason) => {
    if (reason.code === "required_audio_language_missing") return resolved.audio.missingRequiredAction === "DELETE_IF_REPLACED";
    if (reason.code === "required_subtitle_language_missing") return resolved.subtitles.missingRequiredAction === "DELETE_IF_REPLACED";
    // Stored snapshots created before audio/subtitle policies were separated.
    if (reason.code === "required_language_missing") return profile.languagePolicy.missingRequiredAction === "DELETE_IF_REPLACED";
    return false;
  });
}

function groupKey(version: VersionRecord): string {
  const identity = version.fingerprint.identity;
  if (!identity.normalizedTitle || identity.confidence < 0.65) return `review:${version.id}`;
  return [identity.kind, identity.normalizedTitle, identity.year || "", identity.season ?? "", identity.episode ?? ""].join(":");
}

function applyReleaseGroupConsistency(groups: VersionGroup[], profiles: VersionProfile[]): VersionGroup[] {
  const profile = profiles.find((candidate) => candidate.enabled && candidate.target === "QUALITY" && candidate.releaseGroupConsistency === "SEASON");
  if (!profile) return groups;
  const seasons = new Map<string, VersionGroup[]>();
  for (const group of groups) {
    const identity = group.identity;
    if (identity.kind !== "episode" || identity.season === undefined || !identity.normalizedTitle) continue;
    const key = `${identity.normalizedTitle}:${identity.year || ""}:${identity.season}`;
    seasons.set(key, [...(seasons.get(key) || []), group]);
  }
  for (const seasonGroups of seasons.values()) {
    const counts = new Map<string, number>();
    for (const group of seasonGroups) {
      const kept = group.versions.find((version) => version.decision === "KEEP" && version.satisfiesProfiles?.includes(profile.id));
      const releaseGroup = kept?.fingerprint.release?.group?.trim();
      if (releaseGroup) counts.set(releaseGroup, (counts.get(releaseGroup) || 0) + 1);
    }
    const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    if (!ordered.length || (ordered.length > 1 && ordered[0][1] === ordered[1][1])) continue;
    const preferredGroup = ordered[0][0];
    for (const group of seasonGroups) {
      const eligible = group.versions.filter((version) => version.fingerprint.release?.group?.trim() === preferredGroup && version.evaluations.some((evaluation) => evaluation.profileId === profile.id && evaluation.eligible));
      if (!eligible.length) continue;
      const winner = [...eligible].sort((left, right) => compareForProfile(left, right, profile))[0];
      const current = group.versions.find((version) => version.decision === "KEEP" && version.satisfiesProfiles?.includes(profile.id));
      if (current?.id === winner.id) continue;
      if (current) {
        current.decision = "DELETE_CANDIDATE";
        current.reasons.push({ code: "season_release_group_replaced", message: `Release group ${preferredGroup} is preferred for this season`, facts: { preferredReleaseGroup: preferredGroup, season: group.identity.season } });
      }
      winner.decision = "KEEP";
      winner.satisfiesProfiles = [...new Set([...(winner.satisfiesProfiles || []), profile.id])];
      winner.reasons.push({ code: "season_release_group_preference", message: `Preferred release group for season: ${preferredGroup}`, facts: { preferredReleaseGroup: preferredGroup, season: group.identity.season } });
    }
  }
  return groups;
}

export function evaluateVersionGroups(versions: VersionRecord[], profiles = defaultVersionProfiles, policy: VersionManagerPolicy = defaultVersionManagerPolicy): VersionGroup[] {
  const groups = new Map<string, VersionRecord[]>();
  for (const version of versions) groups.set(groupKey(version), [...(groups.get(groupKey(version)) || []), version]);
  const evaluatedGroups = [...groups.entries()].map(([id, members]) => {
    const activeProfiles = profiles.filter((profile) => profile.enabled && (profile.target !== "DIRECT_PLAY" || policy.enableRemote));
    const evaluations = members.map((version): VersionEvaluation => ({ ...version, decision: "REVIEW", evaluations: activeProfiles.map((profile) => evaluateProfile(version, profile)), reasons: [] }));
    const tiedProfiles = new Set<string>();
    const leadingTiedVersionIds = new Set<string>();
    for (const profile of activeProfiles) {
      const eligible = evaluations.filter((version) => version.fingerprint.identity.confidence >= 0.65 && version.evaluations.find((evaluation) => evaluation.profileId === profile.id)?.eligible);
      const ordered = [...eligible].sort((a, b) => compareForProfile(a, b, profile));
      const winner = ordered.length > 1 && compareForProfile(ordered[0], ordered[1], profile) === 0 ? undefined : ordered[0];
      if (ordered.length > 1 && !winner) {
        tiedProfiles.add(profile.id);
        for (const version of ordered) {
          if (compareForProfile(ordered[0], version, profile) !== 0) break;
          leadingTiedVersionIds.add(version.id);
        }
      }
      if (winner) {
        winner.decision = "KEEP";
        winner.satisfiesProfiles = [...new Set([...(winner.satisfiesProfiles || []), profile.id])];
        winner.reasons.push({ code: "profile_winner", message: "Best eligible version for the local retention policy", facts: { profile: profile.id, score: winner.evaluations.find((e) => e.profileId === profile.id)?.score } });
      }
    }
    for (const version of evaluations) {
      const failedEvaluations = version.evaluations.filter((evaluation) => !evaluation.eligible);
      const hasHardRequirementFailure = failedEvaluations.length > 0;
      const languageFailureCanBeRemoved = failedEvaluations.length > 0 && failedEvaluations.every((evaluation) => {
        const profile = activeProfiles.find((candidate) => candidate.id === evaluation.profileId);
        return Boolean(profile && languageFailuresCanBeRemoved(profile, evaluation.reasons));
      });
      const recoverability = version.fingerprint.storage.recoverability?.status || (version.fingerprint.storage.infoHash ? "RECOVERABLE" : "UNKNOWN");
      const recoverable = recoverability === "RECOVERABLE";
      const safeForDelete = (policy.safety?.requireRecoverableBeforeDelete ?? true) ? recoverable : true;
      const hasSurvivingKeep = evaluations.some((candidate) => candidate.decision === "KEEP");
      const everyProfileHasReplacement = activeProfiles.every((profile) => evaluations.some((candidate) => candidate.decision === "KEEP" && candidate.evaluations.some((evaluation) => evaluation.profileId === profile.id && evaluation.eligible)));
      if (version.decision === "REVIEW" && (!hasHardRequirementFailure || languageFailureCanBeRemoved) && version.fingerprint.identity.confidence >= 0.65 && evaluations.length > 1 && hasSurvivingKeep && everyProfileHasReplacement && safeForDelete) {
        version.decision = "DELETE_CANDIDATE";
        version.reasons.push({ code: languageFailureCanBeRemoved ? "required_language_replaced" : "no_profile_slot", message: languageFailureCanBeRemoved ? "A compliant retained replacement exists for this content" : "Not the single best admissible version for this content", facts: { groupId: id } });
      } else if (version.decision === "REVIEW") {
        if (!safeForDelete && version.fingerprint.identity.confidence >= 0.65 && !hasHardRequirementFailure) version.reasons.push({ code: recoverability === "NOT_RECOVERABLE" ? "recoverability_required" : "recoverability_unknown", message: recoverability === "NOT_RECOVERABLE" ? "Delete preview requires a recoverable provider item" : "Recoverability could not be established for this provider item", facts: { recoverabilityStatus: recoverability, infoHashAvailable: recoverable } });
        version.reasons.push({
          code: tiedProfiles.size ? "policy_tie" : hasHardRequirementFailure ? "hard_requirement_failed" : "identity_uncertain",
          message: tiedProfiles.size ? "The configured policy cannot distinguish the leading versions" : hasHardRequirementFailure ? "A mandatory requirement failed; operator review is required" : "Identity confidence is insufficient for an automatic candidate decision",
          facts: { confidence: version.fingerprint.identity.confidence, leadingTie: leadingTiedVersionIds.has(version.id) },
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
    const profileStatuses = activeProfiles.map((profile) => ({
      profileId: profile.id,
      satisfied: evaluations.some((version) => version.fingerprint.identity.confidence >= 0.65 && version.evaluations.some((evaluation) => evaluation.profileId === profile.id && evaluation.eligible && version.decision === "KEEP")),
    }));
    return { id, identity: members[0].fingerprint.identity, versions: evaluations, remote, profileStatuses };
  });
  return applyReleaseGroupConsistency(evaluatedGroups, profiles);
}

const OPERATOR_ALIASES: Record<string, string> = {
  eq: "equals",
  neq: "not_equals",
  gt: "greater_than",
  gte: "greater_or_equal",
  lt: "less_than",
  lte: "less_or_equal",
};

function canonicalCompare(left: unknown, right: unknown): number {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalValue(item)]));
}

function canonicalRule(node: RuleNode | undefined): unknown {
  if (!node) return null;
  if (node.op === "AND" || node.op === "OR") {
    const children = node.children.map(canonicalRule).sort(canonicalCompare);
    return { op: node.op, children };
  }
  if (node.op === "NOT") return { op: "NOT", child: canonicalRule(node.child) };
  if (node.op === "IN") {
    const values = node.values.map(canonicalValue).sort(canonicalCompare);
    return { op: "IN", field: node.field, values };
  }
  const leaf = node as Extract<RuleNode, { op: "COMPARE" | "HAS" }>;
  const operator = "operator" in leaf && leaf.operator ? OPERATOR_ALIASES[leaf.operator] || leaf.operator : undefined;
  return { op: leaf.op, field: leaf.field, ...(operator ? { operator } : {}), ...("value" in leaf ? { value: canonicalValue(leaf.value) } : {}) };
}

function canonicalScoringRule(rule: ScoringRule): unknown {
  const op = rule.op || "COMPARE";
  const operator = rule.operator ? OPERATOR_ALIASES[rule.operator] || rule.operator : undefined;
  if (op === "IN") {
    const values = (rule.values || []).map(canonicalValue).sort(canonicalCompare);
    return { op, field: rule.field, values, weight: rule.weight };
  }
  return { op, field: rule.field, ...(operator ? { operator } : {}), ...("value" in rule ? { value: canonicalValue(rule.value) } : {}), weight: rule.weight };
}

function canonicalLanguagePolicy(policy: LanguagePolicy): unknown {
  const resolved = resolvedTrackLanguagePolicies(policy);
  const canonicalTrackPolicy = (track: TrackLanguagePolicy) => ({
    required: {
      mode: track.required.mode,
      values: [...track.required.values].map((value) => value.trim().toLowerCase()).sort(),
    },
    preferred: [...track.preferred].map((value) => value.trim().toLowerCase()),
    missingRequiredAction: track.missingRequiredAction || "REVIEW",
  });
  return {
    audio: { ...canonicalTrackPolicy(resolved.audio), original: resolved.audio.original === true },
    subtitles: canonicalTrackPolicy(resolved.subtitles),
  };
}

function canonicalProfile(profile: VersionProfile): unknown {
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
    sizePreference: profile.sizePreference || "IGNORE",
    minimumSizeDifferencePercent: profile.minimumSizeDifferencePercent ?? 0,
    releaseGroupConsistency: profile.releaseGroupConsistency || "DISABLED",
    arrProfiles: profile.arrProfiles ? {
      movie: profile.arrProfiles.movie ? { provider: "radarr", serverId: profile.arrProfiles.movie.serverId, qualityProfileId: profile.arrProfiles.movie.qualityProfileId } : null,
      tv: profile.arrProfiles.tv ? { provider: "sonarr", serverId: profile.arrProfiles.tv.serverId, qualityProfileId: profile.arrProfiles.tv.qualityProfileId } : null,
    } : null,
  };
}

/** Hashes the complete decision configuration; policyVersion is revision metadata, not content identity. */
export function versionManagerPolicyHash(policy: VersionManagerPolicy, profiles: VersionProfile[] = defaultVersionProfiles): string {
  const normalized = {
    policy: {
      acquisitionMode: policy.acquisitionMode === "NATIVE" ? "NATIVE" : "ARR",
      enableRemote: policy.enableRemote === true,
      acquireMissingRemote: policy.acquireMissingRemote === true,
      preferCompletePack: policy.preferCompletePack === true,
      safety: { ...defaultVersionManagerPolicy.safety, ...(policy.safety || {}) },
    },
    profiles: profiles.map(canonicalProfile),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}
