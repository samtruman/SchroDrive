import type { VersionGroup } from "./versionManager";

export type DeleteImpactState = "READY" | "PARTIALLY_REDUNDANT" | "BLOCKED";
export interface DeleteImpact {
  providerItemId: string;
  provider: string;
  state: DeleteImpactState;
  onlyCopy: boolean;
  versions: Array<{ id: string; title?: string; season?: number; episode?: number; decision?: string; profileIds?: string[]; reasons?: string[]; files: Array<{ path?: string; size?: number }> }>;
  affectedGroups: string[];
  reasons: string[];
  alternativeVersions: Array<{ id: string; title?: string; season?: number; episode?: number; providerItemId: string; decision?: string; profileIds?: string[]; reasons?: string[] }>;
  physicalSize: number;
  protectedByKeep: boolean;
}

export function buildDeleteImpact(groups: VersionGroup[], query = "", scope = "all"): DeleteImpact[] {
  const result = new Map<string, DeleteImpact>();
  const q = query.trim().toLowerCase();
  for (const group of groups) for (const version of group.versions) {
    const storage = version.fingerprint.storage;
    const text = JSON.stringify({ group, version }).toLowerCase();
    if (q && !text.includes(q)) continue;
    if (scope === "candidates" && version.decision !== "DELETE_CANDIDATE") continue;
    if (scope === "attention" && version.decision !== "REVIEW") continue;
    const key = `${storage.provider}:${storage.torrentId}`;
    const item = result.get(key) || { providerItemId: storage.torrentId, provider: storage.provider, state: "READY" as DeleteImpactState, onlyCopy: true, versions: [], affectedGroups: [], reasons: [], alternativeVersions: [], physicalSize: 0, protectedByKeep: false };
    item.versions.push({ id: version.id, title: group.identity.title, season: group.identity.season, episode: group.identity.episode, decision: version.decision, profileIds: version.satisfiesProfiles || [], reasons: (version.reasons || []).map((reason) => reason.message), files: [{ path: storage.path, size: storage.size }] });
    item.physicalSize = Math.max(item.physicalSize, Number(storage.size || 0));
    if (!item.affectedGroups.includes(group.id)) item.affectedGroups.push(group.id);
    if (version.decision === "KEEP") { item.onlyCopy = false; item.protectedByKeep = true; }
    if (version.decision === "REVIEW") { item.state = "BLOCKED"; item.reasons.push("Review or identity blocker requires operator decision"); }
    if (version.decision === "DELETE_CANDIDATE" && storage.recoverability?.status !== "RECOVERABLE") { item.state = "BLOCKED"; item.reasons.push("Provider item is not confirmed recoverable"); }
    result.set(key, item);
  }
  for (const item of result.values()) {
    const relatedGroups = groups.filter((group) => item.affectedGroups.includes(group.id));
    const alternatives = relatedGroups.flatMap((group) => group.versions)
      .filter((version) => version.fingerprint.storage.torrentId !== item.providerItemId && version.decision === "KEEP")
      .map((version) => ({ id: version.id, title: version.fingerprint.identity.title, season: version.fingerprint.identity.season, episode: version.fingerprint.identity.episode, providerItemId: version.fingerprint.storage.torrentId, decision: version.decision, profileIds: version.satisfiesProfiles || [], reasons: (version.reasons || []).map((reason) => reason.message) }));
    item.alternativeVersions = alternatives;
    if (item.onlyCopy) item.reasons.push("ONLY COPY — No alternative version identified");
    if (item.protectedByKeep) { item.state = "PARTIALLY_REDUNDANT"; item.reasons.push("PROTECTED — ProviderItem contains a KEEP version"); }
    else if (item.alternativeVersions.length) item.reasons.push(`Alternative KEEP versions on ${new Set(item.alternativeVersions.map((version) => version.providerItemId)).size} other ProviderItem(s)`);
    if (!item.reasons.length) item.reasons.push("ProviderItem is the physical delete unit; executor is disabled");
  }
  return [...result.values()].sort((a, b) => a.providerItemId.localeCompare(b.providerItemId));
}
