import { describe, expect, test } from "bun:test";
import { buildDeleteImpact, buildSelectedDeleteImpact } from "../../../src/services/deleteImpact";

type Decision = "KEEP" | "DELETE_CANDIDATE" | "REVIEW";

function version(
  id: string,
  torrentId: string,
  decision: Decision,
  title = "Synthetic title",
  identity: Record<string, unknown> = { kind: "movie", normalizedTitle: title.toLowerCase() },
) {
  return {
    id,
    decision,
    fingerprint: {
      identity: { title, confidence: 0.98, ...identity },
      video: { resolution: "1080p", codec: "HEVC", hdr10: true },
      audio: [{ language: "ita", codec: "EAC3" }],
      release: { source: "WEB-DL" },
      storage: {
        provider: "fixture",
        torrentId,
        fileId: id,
        path: `${id}.mkv`,
        size: 10,
        recoverability: { status: "RECOVERABLE", source: "INFOHASH" },
      },
      subtitles: [],
      probe: { status: "not_requested", tool: "filename" },
    },
    evaluations: [],
    reasons: [],
  } as any;
}

function group(id: string, identity: Record<string, unknown>, versions: any[]) {
  return { id, identity, versions } as any;
}

describe("physical delete impact projection", () => {
  test("projects a movie candidate only when another ProviderItem keeps the same movie", () => {
    const candidate = version("movie-candidate", "torrent-candidate", "DELETE_CANDIDATE");
    const keep = version("movie-keep", "torrent-keep", "KEEP");
    keep.evaluations = [{ profileId: "primary", eligible: true, score: 88, breakdown: { resolution: 40, source: 20, codec: 13, audio: 15 }, reasons: [] }];
    keep.reasons = [{ code: "profile_winner", message: "Best eligible version for the local retention policy", facts: { profile: "primary", score: 88 } }];
    const items = buildDeleteImpact([
      group("movie", { title: "Synthetic title", normalizedTitle: "synthetic title", kind: "movie", year: 2024 }, [
        candidate,
        keep,
      ]),
    ], "", "candidates");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      providerItemId: "torrent-candidate",
      state: "READY",
      onlyCopy: false,
      protectedByKeep: false,
    });
    expect(items[0].alternativeVersions.map((item) => item.id)).toEqual(["movie-keep"]);
    expect(items[0].alternativeVersions[0].reasons[0]).toContain("profile primary");
    expect(items[0].alternativeVersions[0].reasons[0]).toContain("score breakdown");
  });

  test("does not expose a ProviderItem containing only KEEP versions", () => {
    const items = buildDeleteImpact([
      group("movie", { title: "Kept title", normalizedTitle: "kept title", kind: "movie" }, [
        version("keep-a", "torrent-keep", "KEEP"),
        version("keep-b", "torrent-keep", "KEEP"),
      ]),
    ]);

    expect(items).toEqual([]);
  });

  test("protects a mixed season pack and keeps episode identities separate", () => {
    const items = buildDeleteImpact([
      group("show-s01e01", { title: "Neagley", normalizedTitle: "neagley", kind: "episode", year: 2026, season: 1, episode: 1 }, [
        version("e01-keep", "season-pack", "KEEP", "Neagley", { kind: "episode", normalizedTitle: "neagley", year: 2026, season: 1, episode: 1 }),
      ]),
      group("show-s01e02", { title: "Neagley", normalizedTitle: "neagley", kind: "episode", year: 2026, season: 1, episode: 2 }, [
        version("e02-candidate", "season-pack", "DELETE_CANDIDATE", "Neagley", { kind: "episode", normalizedTitle: "neagley", year: 2026, season: 1, episode: 2 }),
        version("e02-keep-other", "single-episode", "KEEP", "Neagley", { kind: "episode", normalizedTitle: "neagley", year: 2026, season: 1, episode: 2 }),
      ]),
    ], "", "protected");

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.providerItemId).toBe("season-pack");
    expect(item.state).toBe("PARTIALLY_REDUNDANT");
    expect(item.protectedByKeep).toBe(true);
    expect(item.versions.map((candidate) => candidate.id)).toEqual(["e01-keep", "e02-candidate"]);
    expect(item.alternativeVersions.map((candidate) => candidate.id)).toEqual(["e02-keep-other"]);
    expect(item.alternativeVersions.some((candidate) => candidate.id === "e01-keep")).toBe(false);
  });

  test("blocks a candidate without an alternative", () => {
    const items = buildDeleteImpact([
      group("movie", { title: "Only copy", normalizedTitle: "only copy", kind: "movie" }, [
        version("only-candidate", "torrent-only", "DELETE_CANDIDATE"),
      ]),
    ], "", "protected");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "BLOCKED", onlyCopy: true, protectedByKeep: false });
    expect(items[0].reasons.join(" ")).toContain("ONLY COPY");
  });

  test("puts review-only ProviderItems in Needs attention, not candidates", () => {
    const items = buildDeleteImpact([
      group("review", { title: "Uncertain", normalizedTitle: "uncertain", kind: "movie" }, [
        version("review-version", "torrent-review", "REVIEW"),
      ]),
    ], "", "attention");

    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("BLOCKED");
    expect(buildDeleteImpact([
      group("review", { title: "Uncertain", normalizedTitle: "uncertain", kind: "movie" }, [
        version("review-version", "torrent-review", "REVIEW"),
      ]),
    ], "", "candidates")).toEqual([]);
  });

  test("query filters after full physical assembly", () => {
    const items = buildDeleteImpact([
      group("e01", { title: "Pack show", normalizedTitle: "pack show", kind: "episode", season: 1, episode: 1 }, [
        version("e01-keep", "pack", "KEEP", "Pack show", { kind: "episode", normalizedTitle: "pack show", season: 1, episode: 1 }),
      ]),
      group("e02", { title: "Pack show", normalizedTitle: "pack show", kind: "episode", season: 1, episode: 2 }, [
        version("e02-candidate", "pack", "DELETE_CANDIDATE", "Pack show", { kind: "episode", normalizedTitle: "pack show", season: 1, episode: 2 }),
      ]),
    ], "e01-keep", "protected");

    expect(items).toHaveLength(1);
    expect(items[0].versions.map((candidate) => candidate.id)).toEqual(["e01-keep", "e02-candidate"]);
  });

  test("allows an explicit operator selection to delete the policy KEEP version", () => {
    const items = buildSelectedDeleteImpact([
      group("movie", { title: "Synthetic title", normalizedTitle: "synthetic title", kind: "movie" }, [
        version("candidate", "candidate-item", "DELETE_CANDIDATE"),
        version("keep", "keep-item", "KEEP"),
      ]),
    ], [{ provider: "fixture", providerItemId: "keep-item" }]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ providerItemId: "keep-item", state: "READY", onlyCopy: false });
    expect(items[0].alternativeVersions.map((candidate) => candidate.id)).toEqual(["candidate"]);
    expect(items[0].reasons.join(" ")).toContain("overrides the policy KEEP");
  });

  test("blocks an operator selection that removes every version of the same content", () => {
    const items = buildSelectedDeleteImpact([
      group("movie", { title: "Synthetic title", normalizedTitle: "synthetic title", kind: "movie" }, [
        version("candidate", "candidate-item", "DELETE_CANDIDATE"),
        version("keep", "keep-item", "KEEP"),
      ]),
    ], [
      { provider: "fixture", providerItemId: "candidate-item" },
      { provider: "fixture", providerItemId: "keep-item" },
    ]);

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.state === "BLOCKED" && item.onlyCopy)).toBe(true);
  });

  test("blocks a selected season pack when one episode has no surviving alternative", () => {
    const items = buildSelectedDeleteImpact([
      group("show-s01e01", { title: "Pack show", normalizedTitle: "pack show", kind: "episode", season: 1, episode: 1 }, [
        version("e01-pack", "season-pack", "KEEP", "Pack show", { kind: "episode", normalizedTitle: "pack show", season: 1, episode: 1 }),
        version("e01-single", "single-e01", "DELETE_CANDIDATE", "Pack show", { kind: "episode", normalizedTitle: "pack show", season: 1, episode: 1 }),
      ]),
      group("show-s01e02", { title: "Pack show", normalizedTitle: "pack show", kind: "episode", season: 1, episode: 2 }, [
        version("e02-pack", "season-pack", "KEEP", "Pack show", { kind: "episode", normalizedTitle: "pack show", season: 1, episode: 2 }),
      ]),
    ], [{ provider: "fixture", providerItemId: "season-pack" }]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ providerItemId: "season-pack", state: "BLOCKED", onlyCopy: true });
  });
});
