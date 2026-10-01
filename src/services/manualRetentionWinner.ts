import { getDb } from "../core/db";
import type { VersionGroup } from "./versionManager";

export interface ManualRetentionWinner {
  providerId: string;
  groupId: string;
  versionId: string;
  updatedAt: string;
}

export function saveManualRetentionWinner(providerId: string, groupId: string, versionId: string): ManualRetentionWinner {
  const updatedAt = new Date().toISOString();
  getDb().prepare(`INSERT OR REPLACE INTO version_manager_manual_winners
    (provider_id, group_id, version_id, updated_at) VALUES (?, ?, ?, ?)`)
    .run(providerId, groupId, versionId, updatedAt);
  return { providerId, groupId, versionId, updatedAt };
}

export function clearManualRetentionWinner(providerId: string, groupId: string): void {
  getDb().prepare("DELETE FROM version_manager_manual_winners WHERE provider_id = ? AND group_id = ?").run(providerId, groupId);
}

export function getManualRetentionWinners(providerId: string): Map<string, ManualRetentionWinner> {
  const rows = getDb().prepare("SELECT provider_id, group_id, version_id, updated_at FROM version_manager_manual_winners WHERE provider_id = ?").all(providerId) as any[];
  return new Map(rows.map((row) => [row.group_id, { providerId: row.provider_id, groupId: row.group_id, versionId: row.version_id, updatedAt: row.updated_at }]));
}

/** Applies an operator choice only to a genuine ranking tie. Other review
 * causes remain fail-closed and cannot be converted into delete candidates. */
export function applyManualRetentionWinners(groups: VersionGroup[], providerId: string): VersionGroup[] {
  const overrides = getManualRetentionWinners(providerId);
  return groups.map((group) => {
    const override = overrides.get(group.id);
    if (!override) return group;
    const selected = group.versions.find((version) => version.id === override.versionId);
    const isTie = group.versions.some((version) => version.reasons.some((reason) => reason.code === "policy_tie"));
    if (!selected || !isTie) return group;
    return {
      ...group,
      versions: group.versions.map((version) => {
        if (version.id === override.versionId) return {
          ...version,
          decision: "KEEP" as const,
          reasons: [{ code: "manual_winner", message: "Kept by explicit operator choice", facts: { providerId, groupId: group.id } }],
        };
        if (version.decision !== "REVIEW" || !version.reasons.some((reason) => reason.code === "policy_tie")) return version;
        return {
          ...version,
          decision: "DELETE_CANDIDATE" as const,
          reasons: [{ code: "manual_winner_selected", message: "Another tied version was explicitly selected to keep", facts: { providerId, winnerVersionId: override.versionId } }],
        };
      }),
    };
  });
}
