import type { TorrentInfo } from "../providers";
import { normalizeMediaTitle, parseMediaFilename } from "./mediaParser";

export type VersionDecision = "KEEP" | "DELETE_CANDIDATE" | "REVIEW";
export type VersionTarget = "QUALITY" | "DIRECT_PLAY" | string;
export type LanguageMode = "ANY" | "ALL";

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
  maxBitrate?: number;
  maxSizeBytes?: number;
}

export interface MediaFingerprint {
  identity: {
    title?: string;
    normalizedTitle?: string;
    year?: number;
    kind?: "movie" | "episode" | "unknown";
    season?: number;
    episode?: number;
    episodeEnd?: number;
    confidence: number;
    source: "filename" | "provider" | "unknown";
  };
  video: {
    resolution?: string;
    codec?: string;
    bitrate?: number;
    bitDepth?: number;
    hdr10?: boolean;
    hdr10Plus?: boolean;
    dolbyVision?: boolean;
  };
  audio: Array<{ language: string; codec?: string; channels?: number; atmos?: boolean }>;
  subtitles: Array<{ language: string; forced?: boolean }>;
  release: { source?: string; group?: string };
  storage: { provider: string; torrentId: string; fileId?: string; path: string; size: number; addedAt?: string };
  probe: { status: "not_requested" | "complete"; tool: "filename" | "provider" };
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
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ita: "ita", italian: "ita", eng: "eng", english: "eng", original: "original",
  fre: "fra", french: "fra", ger: "deu", german: "deu", spa: "spa", spanish: "spa",
};

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
  const files = torrent.files.length > 0 ? torrent.files : [{ id: "torrent", name: torrent.name, path: torrent.name, size: torrent.bytes, selected: true }];
  return files.filter((file) => /\.(mkv|mp4|m4v|avi|ts)$/i.test(file.name)).map((file) => {
    const parsed = parseMediaFilename(file.name, file.path);
    const name = file.name || torrent.name;
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
        },
        video: {
          resolution: inferResolution(name), codec: inferCodec(name),
          hdr10: /HDR10?(?:\b|\+|\.)/i.test(name), hdr10Plus: /HDR10\+/i.test(name),
          dolbyVision: /(?:\bDV\b|DOLBY[ ._-]?VISION)/i.test(name),
        },
        audio: (languages.length > 0 ? languages : ["eng"]).map((language) => ({ language, ...audio })),
        subtitles: [], release: { source: inferSource(name), group: name.match(/-([A-Za-z0-9]+)(?:\.[^.]+)?$/)?.[1] },
        storage: { provider, torrentId: torrent.id, fileId: file.id, path: file.path, size: file.size || torrent.bytes, addedAt: torrent.addedAt?.toISOString() },
        probe: { status: "not_requested", tool: "filename" },
      },
    };
  });
}

export const defaultVersionProfiles: VersionProfile[] = [
  {
    id: "primary", name: "PRIMARY / QUALITY", enabled: true, target: "QUALITY", preferredResolution: "2160p",
    languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: true },
    sourceOrder: ["REMUX", "BLURAY", "WEB-DL", "WEBRIP", "HDTV"], codecOrder: ["HEVC", "AV1", "H264"], audioOrder: ["TRUEHD", "DTS-HD MA", "DTS-HD", "DDP", "EAC3", "AAC"],
  },
  {
    id: "remote", name: "REMOTE / DIRECT PLAY", enabled: false, target: "DIRECT_PLAY", preferredResolution: "1080p",
    languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false },
    sourceOrder: ["WEB-DL", "WEBRIP", "BLURAY", "REMUX"], codecOrder: ["H264", "HEVC", "AV1"], audioOrder: ["AAC", "EAC3", "DDP", "DTS-HD", "TRUEHD"],
  },
];

function hasRequiredLanguages(version: VersionRecord, policy: LanguagePolicy): boolean {
  const available = new Set(version.fingerprint.audio.map((stream) => stream.language));
  const required = policy.required.values.map((value) => LANGUAGE_ALIASES[value.toLowerCase()] || value.toLowerCase());
  return policy.required.mode === "ANY" ? required.length === 0 || required.some((value) => available.has(value)) : required.every((value) => available.has(value));
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

export function evaluateVersionGroups(versions: VersionRecord[], profiles = defaultVersionProfiles): VersionGroup[] {
  const groups = new Map<string, VersionRecord[]>();
  for (const version of versions) groups.set(groupKey(version), [...(groups.get(groupKey(version)) || []), version]);
  return [...groups.entries()].map(([id, members]) => {
    const evaluations = members.map((version): VersionEvaluation => ({ ...version, decision: "REVIEW", evaluations: profiles.filter((profile) => profile.enabled).map((profile) => evaluateProfile(version, profile)), reasons: [] }));
    for (const profile of profiles.filter((item) => item.enabled)) {
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
    return { id, identity: members[0].fingerprint.identity, versions: evaluations };
  });
}
