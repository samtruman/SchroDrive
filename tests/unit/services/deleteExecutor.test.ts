import { describe, expect, mock, test } from "bun:test";
import { BatchDeleteExecutionError, executeVersionManagerDelete, executeVersionManagerDeleteBatch } from "../../../src/services/deleteExecutor";

function version(id: string, torrentId: string, decision: "KEEP" | "DELETE_CANDIDATE") {
  return {
    id,
    decision,
    fingerprint: {
      identity: { title: "Synthetic title", kind: "movie", confidence: 0.99 },
      storage: { provider: "fixture", torrentId, path: `${id}.mkv`, size: 100, recoverability: { status: "RECOVERABLE", source: "INFOHASH", infoHash: "abc" } },
    },
    evaluations: [],
    reasons: [],
  } as any;
}

function groups() {
  return [{ id: "movie", identity: { title: "Synthetic title", kind: "movie" }, versions: [version("candidate", "remove-me", "DELETE_CANDIDATE"), version("winner", "keep-me", "KEEP")] }] as any;
}

function batchGroups() {
  return [{ id: "movie", identity: { title: "Synthetic title", kind: "movie" }, versions: [version("candidate-a", "remove-a", "DELETE_CANDIDATE"), version("candidate-b", "remove-b", "DELETE_CANDIDATE"), version("winner", "keep-me", "KEEP")] }] as any;
}

function provider(present = true) {
  const deleteTorrent = mock(async () => undefined);
  return {
    id: "fixture",
    listTorrents: mock(async () => present ? [{ id: "remove-me" }] : []),
    deleteTorrent,
  } as any;
}

describe("version manager delete executor", () => {
  test("dry run revalidates but never calls provider delete", async () => {
    const source = provider();
    const result = await executeVersionManagerDelete({ groups: groups(), provider: source, providerItemId: "remove-me", dryRun: true });
    expect(result).toMatchObject({ status: "VALIDATED", executed: false });
    expect(source.listTorrents).toHaveBeenCalledTimes(1);
    expect(source.deleteTorrent).toHaveBeenCalledTimes(0);
  });

  test("live mode requires the exact ProviderItem confirmation", async () => {
    const source = provider();
    await expect(executeVersionManagerDelete({ groups: groups(), provider: source, providerItemId: "remove-me", dryRun: false, confirmation: "wrong" })).rejects.toThrow("confirmation");
    expect(source.deleteTorrent).toHaveBeenCalledTimes(0);
  });

  test("live mode deletes once after all checks and exact confirmation", async () => {
    const source = provider();
    const result = await executeVersionManagerDelete({ groups: groups(), provider: source, providerItemId: "remove-me", dryRun: false, confirmation: "remove-me" });
    expect(result).toMatchObject({ status: "DELETED", executed: true });
    expect(source.deleteTorrent).toHaveBeenCalledTimes(1);
  });

  test("refuses a ProviderItem that disappeared after the snapshot", async () => {
    const source = provider(false);
    await expect(executeVersionManagerDelete({ groups: groups(), provider: source, providerItemId: "remove-me", dryRun: true })).rejects.toThrow("no longer exists");
    expect(source.deleteTorrent).toHaveBeenCalledTimes(0);
  });

  test("refuses a protected physical resource", async () => {
    const source = provider();
    const protectedGroups = [{ id: "movie", identity: { title: "Synthetic title", kind: "movie" }, versions: [version("candidate", "shared", "DELETE_CANDIDATE"), version("protected", "shared", "KEEP")] }] as any;
    await expect(executeVersionManagerDelete({ groups: protectedGroups, provider: source, providerItemId: "shared", dryRun: true })).rejects.toThrow("no longer physically eligible");
    expect(source.deleteTorrent).toHaveBeenCalledTimes(0);
  });

  test("allows deleting the policy KEEP item when the complete operator selection preserves its alternative", async () => {
    const source = provider();
    source.listTorrents = mock(async () => [{ id: "keep-me" }]);
    const selection = [{ provider: "fixture", providerItemId: "keep-me" }];
    const result = await executeVersionManagerDelete({ groups: groups(), provider: source, providerItemId: "keep-me", dryRun: true, selection });
    expect(result).toMatchObject({ status: "VALIDATED", impact: { state: "READY", providerItemId: "keep-me" } });
    expect(source.deleteTorrent).toHaveBeenCalledTimes(0);
  });

  test("refuses an operator selection that would delete both alternatives", async () => {
    const source = provider();
    source.listTorrents = mock(async () => [{ id: "remove-me" }, { id: "keep-me" }]);
    const selection = [
      { provider: "fixture", providerItemId: "remove-me" },
      { provider: "fixture", providerItemId: "keep-me" },
    ];
    await expect(executeVersionManagerDeleteBatch({ groups: groups(), provider: source, providerItemIds: ["remove-me", "keep-me"], dryRun: true, selection })).rejects.toThrow("final safety check");
    expect(source.deleteTorrent).toHaveBeenCalledTimes(0);
  });

  test("batch dry run preflights every selected item without deleting", async () => {
    const source = provider();
    source.listTorrents = mock(async () => [{ id: "remove-a" }, { id: "remove-b" }]);
    const result = await executeVersionManagerDeleteBatch({ groups: batchGroups(), provider: source, providerItemIds: ["remove-a", "remove-b"], dryRun: true });
    expect(result).toMatchObject({ status: "VALIDATED", executed: false });
    expect(source.listTorrents).toHaveBeenCalledTimes(1);
    expect(source.deleteTorrent).toHaveBeenCalledTimes(0);
  });

  test("batch live mode stops on the first provider failure", async () => {
    const source = provider();
    source.listTorrents = mock(async () => [{ id: "remove-a" }, { id: "remove-b" }]);
    source.deleteTorrent = mock(async (id: string) => { if (id === "remove-b") throw new Error("fixture timeout"); });
    const ids = ["remove-a", "remove-b"];
    await expect(executeVersionManagerDeleteBatch({ groups: batchGroups(), provider: source, providerItemIds: ids, dryRun: false, confirmation: JSON.stringify(ids) })).rejects.toBeInstanceOf(BatchDeleteExecutionError);
    expect(source.deleteTorrent).toHaveBeenCalledTimes(2);
  });
});
