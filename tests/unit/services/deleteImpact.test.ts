import { describe, expect, test } from "bun:test";
import { buildDeleteImpact } from "../../../src/services/deleteImpact";

function version(id: string, torrentId: string, decision: "KEEP" | "DELETE_CANDIDATE" | "REVIEW") {
  return { id, decision, fingerprint: { identity: { title: "Synthetic title", kind: "movie", confidence: 0.98 }, storage: { provider: "fixture", torrentId, path: `${id}.mkv`, size: 10, recoverability: { status: "RECOVERABLE", source: "INFOHASH" } } }, evaluations: [], reasons: [] } as any;
}

describe("physical delete impact projection", () => {
  test("groups versions by ProviderItem and flags an only copy", () => {
    const items = buildDeleteImpact([{ id: "group-1", identity: { title: "Synthetic title", kind: "movie" }, versions: [version("v1", "torrent-a", "DELETE_CANDIDATE")] }] as any);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ providerItemId: "torrent-a", onlyCopy: true });
    expect(items[0].reasons[0]).toContain("ONLY COPY");
  });

  test("marks a ProviderItem containing a surviving KEEP as partially redundant", () => {
    const items = buildDeleteImpact([{ id: "group-1", identity: { title: "Synthetic title", kind: "movie" }, versions: [version("v1", "torrent-a", "KEEP"), version("v2", "torrent-a", "DELETE_CANDIDATE")] }] as any);
    expect(items[0].state).toBe("PARTIALLY_REDUNDANT");
    expect(items[0].onlyCopy).toBe(false);
  });

  test("candidate and search filters preserve KEEP references from another episode in the physical pack", () => {
    const groups = [
      { id: "episode-1", identity: { title: "Show", kind: "episode", season: 1, episode: 1 }, versions: [version("candidate", "pack", "DELETE_CANDIDATE"), version("replacement", "other", "KEEP")] },
      { id: "episode-2", identity: { title: "Show", kind: "episode", season: 1, episode: 2 }, versions: [version("retained-episode", "pack", "KEEP")] },
    ] as any;
    expect(buildDeleteImpact(groups, "candidate.mkv", "candidates")).toHaveLength(0);
    const [item] = buildDeleteImpact(groups, "candidate.mkv", "protected");
    expect(item.protectedByKeep).toBe(true);
    expect(item.versions).toHaveLength(2);
    expect(item.alternativeVersions[0]).toMatchObject({ groupId: "episode-1", episode: 1, files: [{ path: "replacement.mkv", size: 10 }] });
    expect(buildDeleteImpact(groups, "", "protected").every(item => item.versions.some(v => v.decision === "DELETE_CANDIDATE"))).toBe(true);
  });

  test("an external KEEP is a replacement even when providers reuse the same item id", () => {
    const replacement = version("kept", "same-id", "KEEP");
    replacement.fingerprint.storage.provider = "another-provider";
    const groups = [{ id: "movie", identity: { title: "Movie", kind: "movie" }, versions: [version("candidate", "same-id", "DELETE_CANDIDATE"), replacement] }] as any;
    const [item] = buildDeleteImpact(groups, "", "candidates");
    expect(item.onlyCopy).toBe(false);
    expect(item.state).toBe("READY");
  });

  test("a replacement for one episode cannot make another episode deletable", () => {
    const groups = [
      { id: "e1", identity: { title: "Show" }, versions: [version("c1", "pack", "DELETE_CANDIDATE"), version("k1", "other", "KEEP")] },
      { id: "e2", identity: { title: "Show" }, versions: [version("c2", "pack", "DELETE_CANDIDATE")] },
    ] as any;
    expect(buildDeleteImpact(groups, "", "candidates")).toHaveLength(0);
    expect(buildDeleteImpact(groups, "", "protected")[0]).toMatchObject({ onlyCopy: true, state: "BLOCKED" });
  });
});
