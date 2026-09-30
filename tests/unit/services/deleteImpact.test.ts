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
});
