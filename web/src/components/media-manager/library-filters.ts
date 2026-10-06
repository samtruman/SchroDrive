export type LibraryDecision = "KEEP" | "REVIEW" | "DELETE_CANDIDATE";
export type LibraryMediaType = "all" | "movie" | "tv";
export type LibrarySort = "title" | "versions";

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
