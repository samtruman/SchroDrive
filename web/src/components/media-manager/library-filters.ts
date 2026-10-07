export type LibraryDecision = "KEEP" | "REVIEW" | "DELETE_CANDIDATE";
export type LibraryMediaType = "all" | "movie" | "tv";
export type LibrarySort = "title" | "versions";

export function missingProfileNeeds(payload: any): any[] {
  if (Array.isArray(payload?.needs)) return payload.needs;
  if (Array.isArray(payload?.previews)) return payload.previews;
  return [];
}

export function missingNeedVersions(item: any): any[] {
  if (Array.isArray(item?.existingVersions) && item.existingVersions.length) return item.existingVersions;
  if (Array.isArray(item?.rejectedVersions) && item.rejectedVersions.length) return item.rejectedVersions;
  return [];
}

export function missingNeedSearchText(item: any): string {
  const identity = item?.contentIdentity || {};
  return [
    identity.title,
    identity.year,
    identity.season,
    identity.episode,
    item?.mediaType,
    item?.profileId,
    item?.profileName,
    item?.whatIsMissing,
    item?.why,
    ...(item?.reasonCodes || []),
    ...missingNeedVersions(item).flatMap((version: any) => [
      version.id,
      version.decision,
      version.fingerprint?.storage?.provider,
      version.fingerprint?.storage?.torrentId,
      version.fingerprint?.storage?.path,
    ]),
  ].filter((value) => value !== undefined && value !== null).join(" ").toLowerCase();
}

export function matchesMissingNeed(item: any, filter: Pick<LibraryFilter, "query" | "profile" | "mediaType">): boolean {
  const identity = item?.contentIdentity || {};
  const isTv = item?.mediaType === "tv" || identity.kind === "episode";
  return (!filter.query.trim() || missingNeedSearchText(item).includes(filter.query.trim().toLowerCase())) &&
    (filter.profile === "all" || item?.profileId === filter.profile || item?.missingProfileId === filter.profile) &&
    (filter.mediaType === "all" || (filter.mediaType === "tv" ? isTv : !isTv));
}

export function sortMissingNeeds(items: any[]): any[] {
  return [...items].sort((left, right) => {
    const leftIdentity = left?.contentIdentity || {};
    const rightIdentity = right?.contentIdentity || {};
    return String(leftIdentity.title || left?.title || "").localeCompare(String(rightIdentity.title || right?.title || "")) ||
      Number(leftIdentity.season ?? left?.season ?? 0) - Number(rightIdentity.season ?? right?.season ?? 0) ||
      Number(leftIdentity.episode ?? left?.episode ?? 0) - Number(rightIdentity.episode ?? right?.episode ?? 0);
  });
}

export interface LibraryFilter {
  query: string;
  profile: string;
  mediaType: LibraryMediaType;
  decision: "all" | "keep" | "review" | "delete_candidate";
  multipleVersions: boolean;
}

function versionsOf(group: any): any[] {
  return Array.isArray(group?.versions) ? group.versions : [];
}

export interface LibraryPhysicalRelease {
  key: string;
  provider: string;
  providerItemId: string;
  physicalSize: number;
  recoverable: boolean;
  members: Array<{ group: any; version: any }>;
}

export function physicalReleaseEpisodeCount(release: LibraryPhysicalRelease): number {
  return new Set(release.members.flatMap(({ group, version }) => {
    const identity = group.identity || version.fingerprint?.identity || {};
    const season = identity.season ?? version.season;
    const episode = identity.episode ?? version.episode;
    return (identity.kind === "episode" || season !== undefined || episode !== undefined) && season !== undefined && episode !== undefined
      ? [`${season}:${episode}`]
      : [];
  })).size;
}

export function groupLibraryPhysicalReleases(groups: any[]): LibraryPhysicalRelease[] {
  const releases = new Map<string, LibraryPhysicalRelease & { seenFiles: Set<string> }>();
  for (const group of groups) {
    for (const version of versionsOf(group)) {
      const storage = version?.fingerprint?.storage || {};
      const provider = String(storage.provider || "");
      const providerItemId = String(storage.torrentId || "");
      if (!provider || !providerItemId) continue;
      const key = `${provider}:${providerItemId}`;
      const release = releases.get(key) || {
        key,
        provider,
        providerItemId,
        physicalSize: 0,
        recoverable: true,
        members: [],
        seenFiles: new Set<string>(),
      };
      release.members.push({ group, version });
      const fileKey = String(storage.fileId || storage.path || version.id);
      if (!release.seenFiles.has(fileKey)) {
        release.seenFiles.add(fileKey);
        release.physicalSize += Number(storage.size || 0);
      }
      if (storage.recoverability?.status !== "RECOVERABLE") release.recoverable = false;
      releases.set(key, release);
    }
  }
  return [...releases.values()].map(({ seenFiles: _seenFiles, ...release }) => release);
}

function identityOf(group: any): any {
  return group?.identity || group?.contentIdentity || {};
}

function isTvGroup(group: any): boolean {
  const identity = identityOf(group);
  return identity.kind === "episode" || identity.mediaType === "tv" || group?.mediaType === "tv";
}

function profileIsSatisfied(group: any, profileId: string): boolean {
  const status = (group?.profileStatuses || []).find((candidate: any) => candidate.profileId === profileId);
  if (status) return status.satisfied === true;
  return versionsOf(group).some((version) => (version.satisfiesProfiles || []).includes(profileId));
}

function decisionMatches(group: any, decision: LibraryFilter["decision"]): boolean {
  if (decision === "all") return true;
  const expected = decision.toUpperCase() as LibraryDecision;
  return versionsOf(group).some((version) => version.decision === expected);
}

export function libraryGroupProfileIds(group: any): string[] {
  return [...new Set([
    ...(group?.profileStatuses || []).map((status: any) => status.profileId).filter(Boolean),
    ...versionsOf(group).flatMap((version) => version.satisfiesProfiles || []),
  ])];
}

export function libraryGroupSearchText(group: any): string {
  const identity = identityOf(group);
  const searchable = [
    identity.title,
    identity.normalizedTitle,
    identity.originalTitle,
    identity.year,
    identity.kind,
    identity.mediaType,
    identity.season,
    identity.episode,
    group?.id,
    ...versionsOf(group).flatMap((version) => [
      version.id,
      version.decision,
      version.releaseName,
      version.filename,
      version.fingerprint?.storage?.provider,
      version.fingerprint?.storage?.torrentId,
      version.fingerprint?.storage?.path,
      version.fingerprint?.release?.source,
    ]),
  ];
  return searchable.filter((value) => value !== undefined && value !== null).join(" ").toLowerCase();
}

export function matchesLibraryFilter(group: any, filter: LibraryFilter): boolean {
  const query = filter.query.trim().toLowerCase();
  const versions = versionsOf(group);
  return (!query || libraryGroupSearchText(group).includes(query)) &&
    (filter.profile === "all" || profileIsSatisfied(group, filter.profile)) &&
    (filter.mediaType === "all" || (filter.mediaType === "tv" ? isTvGroup(group) : !isTvGroup(group))) &&
    decisionMatches(group, filter.decision) &&
    (!filter.multipleVersions || versions.length > 1);
}

export function sortLibraryGroups(groups: any[], sort: LibrarySort): any[] {
  return [...groups].sort((left, right) => {
    if (sort === "versions") {
      return versionsOf(right).length - versionsOf(left).length ||
        String(identityOf(left).title || "").localeCompare(String(identityOf(right).title || ""));
    }
    return String(identityOf(left).title || "Unidentified content").localeCompare(String(identityOf(right).title || "Unidentified content"));
  });
}
