import { describe, expect, test } from "bun:test";
import { applyManualRetentionWinners, clearManualRetentionWinner, saveManualRetentionWinner } from "../../../src/services/manualRetentionWinner";

function tiedGroup(): any {
  const identity = { title: "Tie", normalizedTitle: "tie", kind: "movie", confidence: 1, source: "provider", resolutionStatus: "resolved" };
  const version = (id: string) => ({ id, decision: "REVIEW", fingerprint: { identity, storage: { provider: "alldebrid", torrentId: id } }, reasons: [{ code: "policy_tie", message: "Equivalent", facts: {} }], evaluations: [] });
  return { id: "tie-group", identity, versions: [version("first"), version("second")] };
}

describe("manual retention winner", () => {
  test("resolves only the selected provider tie", () => {
    saveManualRetentionWinner("alldebrid", "tie-group", "second");
    const resolved = applyManualRetentionWinners([tiedGroup()], "alldebrid")[0];
    expect(resolved.versions.find((item: any) => item.id === "second")?.decision).toBe("KEEP");
    expect(resolved.versions.find((item: any) => item.id === "first")?.decision).toBe("DELETE_CANDIDATE");
    expect(applyManualRetentionWinners([tiedGroup()], "realdebrid")[0].versions.every((item: any) => item.decision === "REVIEW")).toBe(true);
    clearManualRetentionWinner("alldebrid", "tie-group");
  });

  test("cannot override a non-tie review", () => {
    const group = tiedGroup();
    group.versions.forEach((version: any) => { version.reasons = [{ code: "identity_uncertain", message: "Uncertain", facts: {} }]; });
    saveManualRetentionWinner("alldebrid", group.id, "first");
    expect(applyManualRetentionWinners([group], "alldebrid")[0].versions.every((item: any) => item.decision === "REVIEW")).toBe(true);
    clearManualRetentionWinner("alldebrid", group.id);
  });
});
