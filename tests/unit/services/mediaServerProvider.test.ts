import { describe, expect, test } from "bun:test";
import { config } from "../../../src/core/config";
import { JellyfinMediaServerProvider, PlexMediaServerProvider } from "../../../src/services/mediaServerProvider";
import { resolveVersionIdentity, type MetadataCatalog } from "../../../src/services/versionManagerMetadata";
import { fingerprintTorrent } from "../../../src/services/versionManager";

const original = { jellyfinUrl: config.jellyfinUrl, jellyfinApiKey: config.jellyfinApiKey, jellyfinUserId: config.jellyfinUserId };

describe("MediaServerProvider adapters", () => {
  test("exposes symmetric Plex/Jellyfin capabilities and graceful unconfigured status", async () => {
    expect(new PlexMediaServerProvider().capabilities()).toEqual(new JellyfinMediaServerProvider().capabilities());
    config.jellyfinUrl = "";
    config.jellyfinApiKey = "";
    expect((await new JellyfinMediaServerProvider().catalog()).status).toBe("configuration_unavailable");
  });

  test("maps Jellyfin identity, path, streams and external IDs read-only", async () => {
    config.jellyfinUrl = "http://jellyfin.test";
    config.jellyfinApiKey = "test-only";
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ Items: [{ Name: "Example", Type: "Movie", ProductionYear: 2025, Path: "/media/Example.mkv", ProviderIds: { Tmdb: "123", Tvdb: "456", Imdb: "tt123" }, OriginalLanguage: "it", RunTimeTicks: 10000000, MediaSources: [{ Container: "mkv", MediaStreams: [{ Type: "Video", Codec: "hevc", Width: 3840, Height: 2160, BitRate: 1000, VideoRangeType: "HDR10" }, { Type: "Audio", Codec: "truehd", Channels: 8, Language: "ita", DisplayTitle: "Italian Atmos" }, { Type: "Subtitle", Language: "eng", IsForced: true }] }] }] })) as Response) as typeof fetch;
    try {
      const result = await new JellyfinMediaServerProvider().catalog();
      expect(result.status).toBe("matched");
      expect(result.items[0]).toMatchObject({ tmdbId: "123", tvdbId: "456", imdbId: "tt123", originalLanguage: "it", path: "/media/Example.mkv" });
      expect(result.items[0].streams).toEqual(expect.arrayContaining([expect.objectContaining({ type: "video", width: 3840, height: 2160, hdr: "HDR10" }), expect.objectContaining({ type: "audio", language: "ita", channels: 8 }), expect.objectContaining({ type: "subtitle", language: "eng", forced: true })]));
    } finally {
      globalThis.fetch = previousFetch;
      Object.assign(config, original);
    }
  });

  test("distinguishes Jellyfin authentication failure and network unavailability", async () => {
    config.jellyfinUrl = "http://jellyfin.test";
    config.jellyfinApiKey = "test-only";
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
      expect((await new JellyfinMediaServerProvider().catalog()).status).toBe("authentication_failed");
      globalThis.fetch = (async () => { throw new Error("network unavailable"); }) as typeof fetch;
      expect((await new JellyfinMediaServerProvider().catalog()).status).toBe("unavailable");
    } finally {
      globalThis.fetch = previousFetch;
      Object.assign(config, original);
    }
  });

  test("preserves different paths when canonical evidence agrees and reports conflicts when IDs disagree", () => {
    const version = fingerprintTorrent({ id: "v", name: "Example.2025.2160p.mkv", status: "completed", progress: 100, bytes: 1, files: [{ id: "f", name: "Example.2025.2160p.mkv", path: "/debrid/Example.mkv", size: 1, selected: true }] }, "test")[0];
    const agreeing: MetadataCatalog[] = [
      { source: "PLEX", status: "matched", items: [{ title: "Example", year: 2025, kind: "movie", tmdbId: "123", path: "/plex/Example.mkv", source: "PLEX" }] },
      { source: "JELLYFIN", status: "matched", items: [{ title: "Example", year: 2025, kind: "movie", tmdbId: "123", path: "/jellyfin/Example.mkv", source: "JELLYFIN" }] },
    ];
    const resolved = resolveVersionIdentity(version, agreeing);
    expect(resolved.identityStatus).toBe("resolved");
    expect(resolved.item?.path).toBe("/plex/Example.mkv");
    const conflicting = resolveVersionIdentity(version, [{ ...agreeing[0], items: [{ ...agreeing[0].items[0], tmdbId: "999" }] }, agreeing[1]]);
    expect(conflicting.identityStatus).toBe("conflict");
  });
});
