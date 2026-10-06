import { describe, expect, test } from "bun:test";
import { groupVersionsByPhysicalItem, partitionPhysicalReleases } from "../../../web/src/components/media-manager/operator-guidance";

function version(id: string, providerItemId: string, episode: number, decision = "DELETE_CANDIDATE") {
  return {
    id,
    decision,
    fingerprint: {
      identity: { kind: "episode", season: 1, episode },
      storage: { provider: "alldebrid", torrentId: providerItemId, path: `Show.S01E${String(episode).padStart(2, "0")}.mkv` },
    },
  };
}

describe("Media Manager physical release selection", () => {
  test("renders a season pack as one physical release containing all episodes", () => {
    const releases = groupVersionsByPhysicalItem([
      version("e1", "pack-1", 1),
      version("e2", "pack-1", 2),
      version("e3", "pack-1", 3),
    ]);

    expect(releases).toHaveLength(1);
    expect(releases[0].key).toBe("alldebrid:pack-1");
    expect(releases[0].versions.map((item) => item.fingerprint.identity.episode)).toEqual([1, 2, 3]);
  });

  test("keeps independently stored episodes as separate selectable releases", () => {
    const releases = groupVersionsByPhysicalItem([
      version("e1", "episode-1", 1),
      version("e2", "episode-2", 2),
    ]);

    expect(releases).toHaveLength(2);
    expect(releases.map((release) => release.key).sort()).toEqual([
      "alldebrid:episode-1",
      "alldebrid:episode-2",
    ]);
  });

  test("keeps candidate packs and retained single episodes in separate semantic columns", () => {
    const { candidateReleases, retainedReleases } = partitionPhysicalReleases([
      version("candidate-e1", "season-pack", 1),
      version("candidate-e2", "season-pack", 2),
      version("keep-e1", "single-e1", 1, "KEEP"),
      version("keep-e2", "single-e2", 2, "KEEP"),
    ]);

    expect(candidateReleases.map((release) => release.key)).toEqual(["alldebrid:season-pack"]);
    expect(retainedReleases.map((release) => release.key).sort()).toEqual([
      "alldebrid:single-e1",
      "alldebrid:single-e2",
    ]);
  });
});
