import type { VersionGroup } from "./versionManager";

export type DeleteImpactState = "READY" | "PARTIALLY_REDUNDANT" | "BLOCKED";

type DeleteImpactFingerprint = VersionGroup["versions"][number]["fingerprint"];

interface DeleteImpactIdentity {
  tmdbId?: string;
  title?: string;
  originalTitle?: string;
  year?: number;
  kind?: string;
  season?: number;
  episode?: number;
}

interface DeleteImpactVersion {
  id: string;
  groupId: string;
  logicalKey: string;
  identity: DeleteImpactIdentity;
  title?: string;
  season?: number;
  episode?: number;
  decision?: string;
  profileIds?: string[];
  reasons?: string[];
  fingerprint?: DeleteImpactFingerprint;
  files: Array<{ path?: string; size?: number }>;
}

interface DeleteImpactAlternativeVersion {
  id: string;
  groupId: string;
  logicalKey: string;
  identity: DeleteImpactIdentity;
  title?: string;
  season?: number;
  episode?: number;
  providerItemId: string;
  decision?: string;
  profileIds?: string[];
  reasons?: string[];
  fingerprint?: DeleteImpactFingerprint;
}

export interface DeleteImpact {
  providerItemId: string;
  provider: string;
  state: DeleteImpactState;
  onlyCopy: boolean;
  versions: DeleteImpactVersion[];
  affectedGroups: string[];
  reasons: string[];
  alternativeVersions: DeleteImpactAlternativeVersion[];
  physicalSize: number;
  protectedByKeep: boolean;
}

function logicalKey(group: VersionGroup): string {
  const identity = group.identity || {};
  if (identity.kind === "episode" || identity.season !== undefined || identity.episode !== undefined) {
    return ["episode", identity.normalizedTitle || identity.title || "", identity.year || "", identity.season ?? "", identity.episode ?? ""].join(":");
  }
  return [identity.kind || "movie", identity.normalizedTitle || identity.title || "", identity.year || ""].join(":");
}

function deleteIdentity(group: VersionGroup): DeleteImpactIdentity {
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

function reasonMessages(version: VersionGroup["versions"][number]): string[] {
  return [...new Set((version.reasons || [])
    .map((reason) => {
      if (typeof reason === "string") return reason;
      const facts = reason.facts || {};
      const details: string[] = [];
      if (reason.code === "profile_winner") {
        if (facts.profile) details.push(`profile ${String(facts.profile)}`);
        if (typeof facts.score === "number") details.push(`score ${facts.score}`);
        const evaluation = version.evaluations?.find((candidate) => candidate.profileId === String(facts.profile));
        const breakdown = Object.entries(evaluation?.breakdown || {})
          .filter(([, value]) => Number.isFinite(Number(value)))
          .map(([key, value]) => `${key} ${value}`)
          .join(", ");
        if (breakdown) details.push(`score breakdown: ${breakdown}`);
      }
      return details.length ? `${reason.message} (${details.join("; ")})` : reason.message;
    })
    .filter(Boolean))];
}

function itemKey(provider: string, providerItemId: string): string {
  return `${provider}:${providerItemId}`;
}

function addReason(item: DeleteImpact, reason: string): void {
  if (!item.reasons.includes(reason)) item.reasons.push(reason);
}

function matchesScope(item: DeleteImpact, scope: string): boolean {
  const hasCandidate = item.versions.some((version) => version.decision === "DELETE_CANDIDATE");
  const hasReview = item.versions.some((version) => version.decision === "REVIEW");
  if (scope === "candidates") return item.state === "READY" && hasCandidate;
  if (scope === "protected") return hasCandidate && item.state !== "READY";
  if (scope === "attention") return !hasCandidate && hasReview;
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
export function buildDeleteImpact(groups: VersionGroup[], query = "", scope = "all"): DeleteImpact[] {
  const result = new Map<string, DeleteImpact>();
  const logicalKeepers = new Map<string, Array<{ group: VersionGroup; version: VersionGroup["versions"][number] }>>();
  const seenPhysicalFiles = new Map<string, Set<string>>();

  for (const group of groups) {
    for (const version of group.versions) {
      const storage = version.fingerprint.storage;
      const key = itemKey(storage.provider, storage.torrentId);
      const item = result.get(key) || {
        providerItemId: storage.torrentId,
        provider: storage.provider,
        state: "BLOCKED" as DeleteImpactState,
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
      if (!item.affectedGroups.includes(group.id)) item.affectedGroups.push(group.id);

      const physicalFileKey = storage.fileId || storage.path || version.id;
      const seenFiles = seenPhysicalFiles.get(key) || new Set<string>();
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

  for (const item of result.values()) {
    const candidates = item.versions.filter((version) => version.decision === "DELETE_CANDIDATE");
    const reviews = item.versions.filter((version) => version.decision === "REVIEW");

    item.alternativeVersions = candidates.flatMap((candidate) =>
      (logicalKeepers.get(candidate.logicalKey) || [])
        .filter(({ version }) => itemKey(version.fingerprint.storage.provider, version.fingerprint.storage.torrentId) !== itemKey(item.provider, item.providerItemId))
        .map(({ group, version }) => ({
          id: version.id,
          groupId: group.id,
          logicalKey: logicalKey(group),
          identity: deleteIdentity(group),
          title: group.identity.title,
          season: group.identity.season,
          episode: group.identity.episode,
          providerItemId: version.fingerprint.storage.torrentId,
          decision: version.decision,
          profileIds: version.satisfiesProfiles || [],
          reasons: reasonMessages(version),
          fingerprint: version.fingerprint,
        })),
    ).filter((version, index, all) => all.findIndex((candidate) => candidate.id === version.id) === index);

    const candidateWithoutAlternative = candidates.some((candidate) =>
      !item.alternativeVersions.some((alternative) => alternative.logicalKey === candidate.logicalKey),
    );
    item.onlyCopy = candidates.length > 0 && candidateWithoutAlternative;

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
      } else {
        addReason(item, "ProviderItem is the physical delete unit; final provider revalidation is required");
      }
    } else if (!candidates.length && reviews.length) {
      item.state = "BLOCKED";
    }

    item.reasons = [...new Set(item.reasons)];
  }

  const q = query.trim().toLowerCase();
  return [...result.values()]
    .filter((item) => {
      // Query is applied after full ProviderItem assembly so a matching episode
      // never hides the KEEP/blocker rows sharing its physical pack.
      if (q && !JSON.stringify(item).toLowerCase().includes(q)) return false;
      const hasNonKeep = item.versions.some((version) => version.decision !== "KEEP");
      return hasNonKeep && matchesScope(item, scope);
    })
    .sort((a, b) => a.providerItemId.localeCompare(b.providerItemId));
}
