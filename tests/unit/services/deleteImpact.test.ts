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
    expect(item.state).toBe("BLOCKED");
    expect(item.onlyCopy).toBe(true);
    expect(item.protectedByKeep).toBe(true);
    expect(item.versions.map((candidate) => candidate.id)).toEqual(["e01-keep", "e02-candidate"]);
    expect(item.alternativeVersions).toEqual([]);
    expect(buildDeleteImpact([
      group("show-s01e01", { title: "Neagley", normalizedTitle: "neagley", kind: "episode", year: 2026, season: 1, episode: 1 }, [
        version("e01-keep", "season-pack", "KEEP", "Neagley", { kind: "episode", normalizedTitle: "neagley", year: 2026, season: 1, episode: 1 }),
      ]),
    ], "", "candidates")).toEqual([]);
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

  test("keeps a blocked duplicate visible outside the deletable Policy Delete scope", () => {
    const candidate = version("duplicate", "torrent-duplicate", "DELETE_CANDIDATE");
    const keep = version("retained", "torrent-duplicate", "KEEP");
    const alternative = version("alternative", "torrent-alternative", "KEEP");
    const items = buildDeleteImpact([
      group("movie", { title: "Duplicate title", normalizedTitle: "duplicate title", kind: "movie" }, [candidate, keep, alternative]),
    ], "", "protected");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "PARTIALLY_REDUNDANT", onlyCopy: false, protectedByKeep: true });
    expect(items[0].versions.some((item) => item.decision === "DELETE_CANDIDATE")).toBe(true);
    expect(items[0].alternativeVersions.some((item) => item.providerItemId === "torrent-alternative")).toBe(true);
  });

  test("blocks a season pack when an unrelated episode has no alternative", () => {
    const packKeep = version("pack-e01-keep", "pack", "KEEP", "Example show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "example show" });
    const packCandidate = version("pack-e02-candidate", "pack", "DELETE_CANDIDATE", "Example show", { kind: "episode", season: 1, episode: 2, normalizedTitle: "example show" });
    const packReview = version("pack-e03-review", "pack", "REVIEW", "Example show", { kind: "episode", season: 1, episode: 3, normalizedTitle: "example show" });
    const e01Alternative = version("e01-alternative", "single-e01", "KEEP", "Example show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "example show" });
    const e02Alternative = version("e02-alternative", "single-e02", "KEEP", "Example show", { kind: "episode", season: 1, episode: 2, normalizedTitle: "example show" });
    const groups = [
      group("e01", { title: "Example show", normalizedTitle: "example show", kind: "episode", season: 1, episode: 1 }, [packKeep, e01Alternative]),
      group("e02", { title: "Example show", normalizedTitle: "example show", kind: "episode", season: 1, episode: 2 }, [packCandidate, e02Alternative]),
      group("e03", { title: "Example show", normalizedTitle: "example show", kind: "episode", season: 1, episode: 3 }, [packReview]),
    ];
    expect(buildDeleteImpact(groups, "", "candidates").map((item) => item.providerItemId).sort()).toEqual(["single-e01", "single-e02"]);
    expect(buildDeleteImpact(groups, "", "protected")[0]).toMatchObject({ onlyCopy: true, state: "BLOCKED" });
  });

  test("promotes separate lower-resolution duplicates to candidates when a larger pack covers them", () => {
    const packE01 = version("pack-e01", "season-pack", "DELETE_CANDIDATE", "Pack show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "pack show" });
    const packE02 = version("pack-e02", "season-pack", "DELETE_CANDIDATE", "Pack show", { kind: "episode", season: 1, episode: 2, normalizedTitle: "pack show" });
    const packE03 = version("pack-e03", "season-pack", "REVIEW", "Pack show", { kind: "episode", season: 1, episode: 3, normalizedTitle: "pack show" });
    const singleE01 = version("single-e01", "single-e01", "KEEP", "Pack show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "pack show" });
    const singleE02 = version("single-e02", "single-e02", "KEEP", "Pack show", { kind: "episode", season: 1, episode: 2, normalizedTitle: "pack show" });
    const groups = [
      group("e01", { title: "Pack show", normalizedTitle: "pack show", kind: "episode", season: 1, episode: 1 }, [packE01, singleE01]),
      group("e02", { title: "Pack show", normalizedTitle: "pack show", kind: "episode", season: 1, episode: 2 }, [packE02, singleE02]),
      group("e03", { title: "Pack show", normalizedTitle: "pack show", kind: "episode", season: 1, episode: 3 }, [packE03]),
    ];

    const candidates = buildDeleteImpact(groups, "", "candidates");
    expect(candidates.map((item) => item.providerItemId).sort()).toEqual(["single-e01", "single-e02"]);
    expect(candidates.every((item) => item.state === "READY" && item.onlyCopy === false)).toBe(true);
    expect(candidates.every((item) => item.alternativeVersions.some((alternative) => alternative.providerItemId === "season-pack"))).toBe(true);
    expect(candidates.every((item) => item.alternativeVersions.some((alternative) => alternative.providerItemId === "season-pack" && alternative.decision === "KEEP"))).toBe(true);
    expect(buildDeleteImpact(groups, "", "protected").some((item) => item.providerItemId === "season-pack" && item.state === "BLOCKED")).toBe(true);
  });

  test("does not let a lower-resolution pack override a higher-resolution separate version", () => {
    const packE01 = version("pack-e01", "season-pack", "DELETE_CANDIDATE", "Quality show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "quality show" });
    const packE02 = version("pack-e02", "season-pack", "REVIEW", "Quality show", { kind: "episode", season: 1, episode: 2, normalizedTitle: "quality show" });
    const singleE01 = version("single-e01", "single-e01", "KEEP", "Quality show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "quality show" });
    packE01.fingerprint.video.resolution = "1080p";
    packE02.fingerprint.video.resolution = "1080p";
    singleE01.fingerprint.video.resolution = "2160p";
    const groups = [
      group("e01", { title: "Quality show", normalizedTitle: "quality show", kind: "episode", season: 1, episode: 1 }, [packE01, singleE01]),
      group("e02", { title: "Quality show", normalizedTitle: "quality show", kind: "episode", season: 1, episode: 2 }, [packE02]),
    ];
    const all = buildDeleteImpact(groups);
    expect(all.some((item) => item.providerItemId === "single-e01")).toBe(false);
  });

  test("does not delete a compliant standalone episode for a smaller non-compliant pack", () => {
    const packE01 = version("pack-e01-language", "language-pack", "DELETE_CANDIDATE", "Language show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "language show" });
    const packE02 = version("pack-e02-language", "language-pack", "REVIEW", "Language show", { kind: "episode", season: 1, episode: 2, normalizedTitle: "language show" });
    const standaloneE01 = version("single-e01-language", "single-language", "KEEP", "Language show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "language show" });
    packE01.fingerprint.storage.size = 5;
    standaloneE01.fingerprint.storage.size = 10;
    packE01.evaluations = [{ profileId: "primary", eligible: false, breakdown: {}, reasons: [] }];
    standaloneE01.evaluations = [{ profileId: "primary", eligible: true, score: 100, breakdown: {}, reasons: [] }];
    const groups = [
      group("language-e01", { title: "Language show", normalizedTitle: "language show", kind: "episode", season: 1, episode: 1 }, [packE01, standaloneE01]),
      group("language-e02", { title: "Language show", normalizedTitle: "language show", kind: "episode", season: 1, episode: 2 }, [packE02]),
    ];

    expect(buildDeleteImpact(groups, "", "candidates").some((item) => item.providerItemId === "single-language")).toBe(false);
    expect(buildDeleteImpact(groups, "", "protected").some((item) => item.providerItemId === "language-pack" && item.state === "BLOCKED")).toBe(true);
  });

  test("lets profile ranking decide when retained singles collectively cover the pack", () => {
    const packE01 = version("pack-e01", "season-pack", "DELETE_CANDIDATE", "Complete show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "complete show" });
    const packE02 = version("pack-e02", "season-pack", "DELETE_CANDIDATE", "Complete show", { kind: "episode", season: 1, episode: 2, normalizedTitle: "complete show" });
    const singleE01 = version("single-e01", "single-e01", "KEEP", "Complete show", { kind: "episode", season: 1, episode: 1, normalizedTitle: "complete show" });
    const singleE02 = version("single-e02", "single-e02", "KEEP", "Complete show", { kind: "episode", season: 1, episode: 2, normalizedTitle: "complete show" });
    const groups = [
      group("e01", { title: "Complete show", normalizedTitle: "complete show", kind: "episode", season: 1, episode: 1 }, [packE01, singleE01]),
      group("e02", { title: "Complete show", normalizedTitle: "complete show", kind: "episode", season: 1, episode: 2 }, [packE02, singleE02]),
    ];
    const candidates = buildDeleteImpact(groups, "", "candidates");
    expect(candidates.map((item) => item.providerItemId)).toEqual(["season-pack"]);
    expect(candidates[0].alternativeVersions.map((version) => version.providerItemId).sort()).toEqual(["single-e01", "single-e02"]);
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
