import { describe, expect, test } from "bun:test";
import { mergeProbedFingerprint } from "../../../src/services/versionManagerProbe";

function fingerprint(provider: string, torrentId: string, identity: Record<string, unknown>) {
  return {
    identity: {
      title: "1917",
      kind: "movie",
      confidence: 1,
      source: "manual",
      provenance: { title: "MANUAL", tmdbId: "MANUAL" },
      ...identity,
    },
    video: { resolution: "2160p", codec: "HEVC", provenance: { resolution: "FILENAME" } },
    audio: [{ language: "ita", provenance: { language: "FILENAME" } }],
    subtitles: [],
    release: { source: "BLURAY", provenance: { source: "FILENAME" } },
    storage: { provider, torrentId, fileId: "torrent", path: "1917.mkv", size: 100, provenance: { provider: "UNKNOWN" } },
    probe: { status: "not_requested", tool: "filename" },
  } as any;
}

describe("version manager probe cache isolation", () => {
  test("reuses media facts without replacing provider storage or manual identity", () => {
    const current = fingerprint("realdebrid", "RD-ITEM", { tmdbId: "530915" });
    const cached = fingerprint("alldebrid", "AD-ITEM", { tmdbId: "wrong-cache-id", title: "Wrong cached title" });
    cached.video = { resolution: "2160p", codec: "H265", width: 3840, provenance: { codec: "FFPROBE" } };
    cached.audio = [{ language: "eng", codec: "TRUEHD", provenance: { language: "FFPROBE" } }];
    cached.probe = { status: "complete", tool: "ffprobe", version: "fixture" };

    const merged = mergeProbedFingerprint(current, cached);

    expect(merged.storage).toEqual(current.storage);
    expect(merged.identity).toEqual(current.identity);
    expect(merged.release).toEqual(current.release);
    expect(merged.video).toMatchObject({ width: 3840, codec: "H265" });
    expect(merged.audio).toEqual(cached.audio);
    expect(merged.probe).toEqual(cached.probe);
  });

  test("accepts a probed TMDb id only when the current identity has none", () => {
    const current = fingerprint("realdebrid", "RD-ITEM", {});
    delete current.identity.tmdbId;
    const cached = fingerprint("alldebrid", "AD-ITEM", { tmdbId: "530915" });

    const merged = mergeProbedFingerprint(current, cached);

    expect(merged.identity.tmdbId).toBe("530915");
    expect(merged.identity.title).toBe("1917");
    expect(merged.storage.provider).toBe("realdebrid");
  });
});
