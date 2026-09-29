import type { ContentIdentity, ProfileStatus, VersionGroup, VersionProfile } from "./versionManager";

export type AcquisitionStatus =
  | "PROFILE_SATISFIED"
  | "PROFILE_MISSING"
  | "ACQUISITION_BLOCKED"
  | "ACQUISITION_ELIGIBLE"
  | "ACQUISITION_PENDING"
  | "ACQUISITION_REQUESTED"
  | "ACQUISITION_ALREADY_EXISTS"
  | "ACQUISITION_AVAILABLE"
  | "ACQUISITION_FAILED";

export type AcquisitionProviderStatus =
  | "NOT_REQUESTED"
  | "REQUESTED"
  | "PENDING"
  | "PROCESSING"
  | "AVAILABLE"
  | "PARTIALLY_AVAILABLE"
  | "UNAVAILABLE"
  | "CONFIGURATION_UNAVAILABLE"
  | "MEDIA_NOT_FOUND"
  | "ERROR";

export type AcquisitionBlockReason =
  | "PROFILE_DISABLED"
  | "IDENTITY_NOT_RESOLVED"
  | "MISSING_CANONICAL_ID"
  | "IDENTITY_CONFLICT"
  | "MEDIA_TYPE_UNKNOWN"
  | "SEASON_EPISODE_REQUIRED"
  | "STALE_NEED"
  | "EQUIVALENT_REQUEST_EXISTS"
  | "PROFILE_SATISFIED";

export interface AcquisitionNeed {
  id: string;
  contentIdentity: ContentIdentity;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
  missingProfileId: string;
  missingProfileName: string;
  reason: string;
  reasonCode: string;
  status: AcquisitionStatus;
  confidence: number;
  createdAt: string;
  evaluatedAt: string;
  existingVersions: VersionGroup["versions"];
  rejectedVersions: VersionGroup["versions"];
  acquisitionEligibility: {
    eligible: boolean;
    reason?: AcquisitionBlockReason;
    adapterId?: string;
  };
  providerStatus?: string;
}

export interface AcquisitionEvaluationOptions {
  now?: Date;
  adapterId?: string;
  staleAfterMs?: number;
  acquisitionEnabled?: boolean;
}

function canonicalId(identity: ContentIdentity): string | undefined {
  return identity.tmdbId || identity.tvdbId || identity.imdbId;
}

export function acquisitionIdentityKey(identity: ContentIdentity, mediaType: string, season?: number, episode?: number): string {
  return [mediaType, canonicalId(identity) || identity.normalizedTitle || identity.title || "unknown", season ?? "", episode ?? ""].join(":");
}

function eligibility(identity: ContentIdentity, mediaType: "movie" | "tv", season?: number, episode?: number): AcquisitionNeed["acquisitionEligibility"] {
  if (identity.conflicts?.length || identity.resolutionStatus === "conflict") return { eligible: false, reason: "IDENTITY_CONFLICT" };
  if (identity.resolutionStatus !== "resolved") return { eligible: false, reason: "IDENTITY_NOT_RESOLVED" };
  if (!canonicalId(identity)) return { eligible: false, reason: "MISSING_CANONICAL_ID" };
  if (mediaType === "tv" && (season === undefined || episode === undefined)) return { eligible: false, reason: "SEASON_EPISODE_REQUIRED" };
  return { eligible: true };
}

export function createAcquisitionNeed(group: VersionGroup, profile: VersionProfile, options: AcquisitionEvaluationOptions = {}): AcquisitionNeed | undefined {
  const profileStatus = group.profileStatuses?.find((item) => item.profileId === profile.id);
  if (!profile.enabled || profileStatus?.satisfied !== false) return undefined;
  const identity = group.identity;
  const mediaType = identity.kind === "movie" ? "movie" : identity.kind === "episode" ? "tv" : undefined;
  const evaluatedAt = (options.now || new Date()).toISOString();
  if (!mediaType) return undefined;
  const eligible = eligibility(identity, mediaType, identity.season, identity.episode);
  const acquisitionEnabled = options.acquisitionEnabled !== false;
  const status: AcquisitionStatus = !acquisitionEnabled ? "PROFILE_MISSING" : eligible.eligible ? "ACQUISITION_ELIGIBLE" : "ACQUISITION_BLOCKED";
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

export function deriveAcquisitionNeeds(groups: VersionGroup[], profiles: VersionProfile[], options: AcquisitionEvaluationOptions = {}): AcquisitionNeed[] {
  return groups.flatMap((group) => profiles.flatMap((profile) => createAcquisitionNeed(group, profile, options) || []));
}

/** Stable local idempotency boundary before an adapter is ever called. */
export function deduplicateAcquisitionNeeds(needs: AcquisitionNeed[]): AcquisitionNeed[] {
  const seen = new Set<string>();
  return needs.filter((need) => {
    const key = `${acquisitionIdentityKey(need.contentIdentity, need.mediaType, need.season, need.episode)}:${need.missingProfileId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function revalidateAcquisitionNeed(need: AcquisitionNeed, groups: VersionGroup[], profiles: VersionProfile[], options: AcquisitionEvaluationOptions = {}): AcquisitionNeed {
  const group = groups.find((candidate) => candidate.identity.tmdbId === need.contentIdentity.tmdbId && candidate.identity.kind === need.contentIdentity.kind && candidate.identity.season === need.season && candidate.identity.episode === need.episode);
  const profile = profiles.find((candidate) => candidate.id === need.missingProfileId);
  if (!group || !profile) return { ...need, status: "ACQUISITION_BLOCKED", acquisitionEligibility: { eligible: false, reason: "STALE_NEED" }, evaluatedAt: (options.now || new Date()).toISOString() };
  const refreshed = createAcquisitionNeed(group, profile, options);
  if (!refreshed) return { ...need, status: "PROFILE_SATISFIED", acquisitionEligibility: { eligible: false, reason: "PROFILE_SATISFIED" }, evaluatedAt: (options.now || new Date()).toISOString() };
  return { ...refreshed, id: need.id, createdAt: need.createdAt };
}

export interface AcquisitionAdapterCapabilities {
  adapterId: string;
  enabled: boolean;
  supportsMovie: boolean;
  supportsTv: boolean;
  tvScope: "episode" | "season" | "series" | "unknown";
  canRequest: boolean;
}

export interface AcquisitionPreview {
  needId: string;
  status: AcquisitionStatus;
  adapterId: string;
  contentIdentity: ContentIdentity;
  mediaType: "movie" | "tv";
  requestedProfileId: string;
  requestedProfileName: string;
  providerStatus: string;
  providerMediaStatus?: string;
  providerRequestId?: string;
  providerStatusSource?: "MEDIA_STATUS" | "REQUEST_LOOKUP" | "BOTH";
  tvScope?: string;
  mappingWarning?: string;
  safe: boolean;
}

export interface AcquisitionAdapter {
  capabilities(): Promise<AcquisitionAdapterCapabilities>;
  status(need: AcquisitionNeed): Promise<{ status: AcquisitionStatus | AcquisitionProviderStatus; providerRequestId?: string; detail?: string }>;
  preview(need: AcquisitionNeed): Promise<AcquisitionPreview>;
  request(need: AcquisitionNeed): Promise<{ providerRequestId?: string; status: string; detail?: string }>;
}

export function profileStatus(profileId: string, satisfied: boolean): ProfileStatus {
  return { profileId, satisfied };
}
