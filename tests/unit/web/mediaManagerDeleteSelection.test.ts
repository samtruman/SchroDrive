import { describe, expect, test } from "bun:test";
import { groupVersionsByPhysicalItem } from "../../../web/src/components/media-manager/operator-guidance";

function version(id: string, providerItemId: string, episode: number) {
  return {
    id,
    decision: "DELETE_CANDIDATE",
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
});
