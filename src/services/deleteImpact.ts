import type { VersionGroup } from "./versionManager";

export type DeleteImpactState = "READY" | "PARTIALLY_REDUNDANT" | "BLOCKED";
export interface DeleteImpact {
  providerItemId: string;
  provider: string;
  state: DeleteImpactState;
  onlyCopy: boolean;
  versions: ImpactVersion[];
  affectedGroups: string[];
  reasons: string[];
  alternativeVersions: ImpactVersion[];
  physicalSize: number;
  protectedByKeep: boolean;
}

interface ImpactVersion {
  id: string; groupId: string; title?: string; year?: number; season?: number; episode?: number;
  provider: string; providerItemId: string; decision?: string; profileIds: string[]; reasons: string[];
  files: Array<{ path?: string; size?: number }>;
  fingerprint: VersionGroup["versions"][number]["fingerprint"];
}

function project(group: VersionGroup, version: VersionGroup["versions"][number]): ImpactVersion {
  const storage = version.fingerprint.storage;
  return { id: version.id, groupId: group.id, title: group.identity.title, year: group.identity.year,
    season: group.identity.season, episode: group.identity.episode, provider: storage.provider,
    providerItemId: storage.torrentId, decision: version.decision, profileIds: version.satisfiesProfiles || [],
    reasons: (version.reasons || []).map(reason => reason.message), files: [{ path: storage.path, size: storage.size }], fingerprint: version.fingerprint };
}

export function buildDeleteImpact(groups: VersionGroup[], query = "", scope = "all"): DeleteImpact[] {
  const result = new Map<string, DeleteImpact>();
  const q = query.trim().toLowerCase();
  for (const group of groups) for (const version of group.versions) {
    const storage = version.fingerprint.storage;
    // Build the full physical resource before filtering. KEEP/REVIEW references
    // must remain visible even when searching for a candidate in a season pack.
    const key = `${storage.provider}:${storage.torrentId}`;
    const item = result.get(key) || { providerItemId: storage.torrentId, provider: storage.provider, state: "READY" as DeleteImpactState, onlyCopy: true, versions: [], affectedGroups: [], reasons: [], alternativeVersions: [], physicalSize: 0, protectedByKeep: false };
    item.versions.push(project(group, version));
    item.physicalSize = Math.max(item.physicalSize, Number(storage.size || 0));
    if (!item.affectedGroups.includes(group.id)) item.affectedGroups.push(group.id);
    if (version.decision === "KEEP") { item.onlyCopy = false; item.protectedByKeep = true; }
    if (version.decision === "REVIEW") { item.state = "BLOCKED"; item.reasons.push("Review or identity blocker requires operator decision"); }
    if (version.decision === "DELETE_CANDIDATE" && storage.recoverability?.status !== "RECOVERABLE") { item.state = "BLOCKED"; item.reasons.push("Provider item is not confirmed recoverable"); }
    result.set(key, item);
  }
  for (const item of result.values()) {
    const relatedGroups = groups.filter((group) => item.affectedGroups.includes(group.id));
    const alternatives = relatedGroups.flatMap(group => group.versions
      .filter(version => (version.fingerprint.storage.provider !== item.provider || version.fingerprint.storage.torrentId !== item.providerItemId) && version.decision === "KEEP")
      .map(version => project(group, version)));
    item.alternativeVersions = alternatives;
    item.onlyCopy = !item.protectedByKeep && item.versions.some(version => !alternatives.some(other => other.groupId === version.groupId));
    if (item.onlyCopy) item.reasons.push("ONLY COPY — No alternative version identified");
    if (item.protectedByKeep) { item.state = "PARTIALLY_REDUNDANT"; item.reasons.push("PROTECTED — ProviderItem contains a KEEP version"); }
    else if (item.alternativeVersions.length) item.reasons.push(`Alternative KEEP versions on ${new Set(item.alternativeVersions.map((version) => version.providerItemId)).size} other ProviderItem(s)`);
    if (!item.reasons.length) item.reasons.push("ProviderItem is the physical delete unit; executor is disabled");
    if (!item.protectedByKeep && (item.onlyCopy || !item.versions.some(version => version.decision === "DELETE_CANDIDATE"))) item.state = "BLOCKED";
  }
  return [...result.values()].filter(item => {
    const hasCandidate = item.versions.some(version => version.decision === "DELETE_CANDIDATE");
    const physicallyEligible = hasCandidate && item.state === "READY" && !item.onlyCopy && !item.protectedByKeep;
    // Candidate means a physical resource that could actually be deleted if
    // the executor existed. Logical candidates blocked by a KEEP/shared pack,
    // missing replacement, review, or recoverability stay in the separate
    // protected view.
    if (scope === "candidates" && !physicallyEligible) return false;
    if (scope === "protected" && (!hasCandidate || physicallyEligible)) return false;
    if (scope === "attention" && !item.versions.some(version => version.decision === "REVIEW")) return false;
    return !q || JSON.stringify(item).toLowerCase().includes(q);
  }).sort((a, b) => (a.versions[0]?.title || "").localeCompare(b.versions[0]?.title || "") || a.providerItemId.localeCompare(b.providerItemId));
}
