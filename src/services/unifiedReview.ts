import { createHash } from "node:crypto";
import type { OrganizerReviewEntry } from "./organizerReview";
import type { VersionGroup, VersionEvaluation } from "./versionManager";
import { normalizeMediaTitle } from "./mediaParser";

export type UnifiedReviewIssueType = "IDENTITY_ISSUE" | "POLICY_REVIEW" | "RECOVERABILITY_ISSUE";

export interface UnifiedReviewEntry {
  key: string;
  identity?: VersionGroup["identity"];
  title?: string;
  year?: number;
  kind?: string;
  season?: number;
  episode?: number;
  issueTypes: UnifiedReviewIssueType[];
  reasonCodes: string[];
  blockers: string[];
  policyDecision?: "REVIEW";
  recoverability?: { status: "RECOVERABLE" | "NOT_RECOVERABLE" | "UNKNOWN"; sources: string[] };
  identityResolutionStatus?: string;
  organizerReview?: OrganizerReviewEntry;
  /** Compatibility projection used by the existing Review detail/actions. */
  review?: OrganizerReviewEntry;
  parsed?: OrganizerReviewEntry["parsed"];
  sourceBasename?: string;
  sourcePath?: string;
  decision?: OrganizerReviewEntry["decision"];
  versionGroupId?: string;
  versionIds: string[];
  versions?: VersionEvaluation[];
  allowedActions: string[];
  allowIdentityActions?: boolean;
}

export interface UnifiedReviewSummary {
  total: number;
  identityIssues: number;
  policyReviews: number;
  recoverabilityIssues: number;
}

export interface UnifiedReviewQueue {
  entries: UnifiedReviewEntry[];
  summary: UnifiedReviewSummary;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identityKey(identity: Partial<VersionGroup["identity"]> | undefined): string | undefined {
  if (!identity) return undefined;
  const episodeSuffix = identity.kind === "episode" ? `:${identity.season ?? ""}:${identity.episode ?? ""}` : "";
  if (identity.tmdbId) return `tmdb:${identity.kind || "unknown"}:${identity.tmdbId}${episodeSuffix}`;
  if (identity.imdbId) return `imdb:${identity.kind || "unknown"}:${identity.imdbId}${episodeSuffix}`;
  if (identity.tvdbId) return `tvdb:${identity.kind || "unknown"}:${identity.tvdbId}${episodeSuffix}`;
  if (!identity.normalizedTitle && !identity.title) return undefined;
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

function keyForIdentity(identity: VersionGroup["identity"] | undefined, fallback: string): string {
  return `review_${digest(identityKey(identity) || fallback)}`;
}

function recoverabilityFor(version: VersionEvaluation): "RECOVERABLE" | "NOT_RECOVERABLE" | "UNKNOWN" {
  return version.fingerprint.storage.recoverability?.status || (version.fingerprint.storage.infoHash ? "RECOVERABLE" : "UNKNOWN");
}

function mergeEntry(entries: Map<string, UnifiedReviewEntry>, value: UnifiedReviewEntry): void {
  const current = entries.get(value.key);
  if (!current) {
    entries.set(value.key, value);
    return;
  }
  current.issueTypes = [...new Set([...current.issueTypes, ...value.issueTypes])];
  current.reasonCodes = [...new Set([...current.reasonCodes, ...value.reasonCodes])];
  current.blockers = [...new Set([...current.blockers, ...value.blockers])];
  current.versionIds = [...new Set([...current.versionIds, ...value.versionIds])];
  if (value.versions?.length) {
    const versions = new Map((current.versions || []).map((version) => [version.id, version]));
    value.versions.forEach((version) => versions.set(version.id, version));
    current.versions = [...versions.values()];
  }
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
  if (value.versionGroupId) current.versionGroupId ||= value.versionGroupId;
  if (value.policyDecision) current.policyDecision = value.policyDecision;
  if (value.recoverability) {
    const rank = { RECOVERABLE: 0, UNKNOWN: 1, NOT_RECOVERABLE: 2 };
    if (!current.recoverability || rank[value.recoverability.status] > rank[current.recoverability.status]) current.recoverability = value.recoverability;
    current.recoverability.sources = [...new Set([...(current.recoverability?.sources || []), ...value.recoverability.sources])];
  }
}

function organizerIssue(entry: OrganizerReviewEntry): boolean {
  const status = String(entry.parsed.status);
  return status === "ambiguous" || status === "unmatched" || status === "fallback" || status === "conflict";
}

function makeOrganizerEntry(entry: OrganizerReviewEntry): UnifiedReviewEntry {
  const kind: "movie" | "episode" | "unknown" = entry.override?.kind || (entry.parsed.kind === "episode" ? "episode" : entry.parsed.kind === "movie" ? "movie" : "unknown");
  const identity = {
    tmdbId: entry.override?.tmdbId,
    imdbId: entry.override?.imdbId,
    tvdbId: entry.override?.tvdbId,
    title: entry.override?.title || entry.parsed.title,
    originalTitle: entry.override?.originalTitle,
    normalizedTitle: normalizeMediaTitle(entry.override?.title || entry.parsed.title || ""),
    year: entry.override?.year || entry.parsed.year,
    kind,
    season: entry.override?.season || entry.parsed.season,
    episode: entry.override?.episode || entry.parsed.episode,
    confidence: entry.override ? 1 : entry.parsed.confidence,
    source: entry.override ? "manual" as const : "unknown" as const,
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

export function buildUnifiedReviewQueue(groups: VersionGroup[], organizerReviews: OrganizerReviewEntry[] = [], status: "pending" | "dismissed" | "all" = "pending"): UnifiedReviewQueue {
  const entries = new Map<string, UnifiedReviewEntry>();
  const aliases = new Map<string, string>();
  const canonicalByKey = new Map<string, boolean>();
  const add = (value: UnifiedReviewEntry): void => {
    const fallback = identityKey({ ...value.identity, tmdbId: undefined, imdbId: undefined, tvdbId: undefined });
    const canonical = Boolean(value.identity?.tmdbId || value.identity?.imdbId || value.identity?.tvdbId);
    const aliasedKey = fallback ? aliases.get(fallback) : undefined;
    const existingKey = entries.has(value.key) ? value.key : aliasedKey;
    const existingCanonical = existingKey ? canonicalByKey.get(existingKey) === true : false;
    if (existingKey && !(canonical && existingCanonical && existingKey !== value.key)) {
      value.key = existingKey;
      mergeEntry(entries, value);
      canonicalByKey.set(existingKey, existingCanonical || canonical);
    } else {
      entries.set(value.key, value);
      canonicalByKey.set(value.key, canonical);
    }
    if (fallback && (!canonical || !existingCanonical)) aliases.set(fallback, value.key);
  };
  for (const organizer of organizerReviews) {
    if (status !== "all" && organizer.decision !== status) continue;
    if (!organizerIssue(organizer)) continue;
    add(makeOrganizerEntry(organizer));
  }

  for (const group of groups) {
    const reviewVersions = group.versions.filter((version) => version.decision === "REVIEW");
    if (reviewVersions.length === 0) continue;
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
    const issueTypes: UnifiedReviewIssueType[] = [];
    if (hasIdentity) issueTypes.push("IDENTITY_ISSUE");
    if (hasRecoverability) issueTypes.push("RECOVERABILITY_ISSUE");
    if (policyReasons.length > 0) issueTypes.push("POLICY_REVIEW");
    if (issueTypes.length === 0) issueTypes.push("POLICY_REVIEW");
    const states = reviewVersions.map(recoverabilityFor);
    const state = states.includes("NOT_RECOVERABLE") ? "NOT_RECOVERABLE" : states.includes("UNKNOWN") ? "UNKNOWN" : "RECOVERABLE";
    const sources = [...new Set(reviewVersions.map((version) => version.fingerprint.storage.recoverability?.source || (version.fingerprint.storage.infoHash ? "INFOHASH" : "UNKNOWN")))];
    const fallback = reviewVersions.map((version) => `${version.fingerprint.storage.provider}:${version.fingerprint.storage.torrentId}:${version.fingerprint.storage.fileId || ""}`).sort().join("|");
    add({
      key: keyForIdentity(group.identity, fallback), identity: group.identity, title: group.identity.title, year: group.identity.year, kind: group.identity.kind,
      season: group.identity.season, episode: group.identity.episode, issueTypes, reasonCodes, blockers: [...new Set(reviewVersions.flatMap((version) => version.reasons.map((reason) => reason.message)))],
      policyDecision: "REVIEW", recoverability: { status: state, sources }, identityResolutionStatus: identityStatus, versionGroupId: group.id,
      versionIds: reviewVersions.map((version) => version.id), versions: reviewVersions, allowedActions: ["DETAILS"], allowIdentityActions: false,
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
