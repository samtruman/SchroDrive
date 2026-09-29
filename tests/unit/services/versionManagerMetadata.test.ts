import { describe, expect, test } from "bun:test";
import type { TorrentInfo } from "../../../src/providers";
import { fingerprintTorrent, evaluateVersionGroups, type VersionRecord } from "../../../src/services/versionManager";
import { getCachedVersionManagerMetadata, invalidateVersionManagerMetadataCache, resolveVersionIdentity, saveVersionManagerMetadataCache, type MetadataCatalog } from "../../../src/services/versionManagerMetadata";

function version(name: string): VersionRecord {
  const torrent: TorrentInfo = { id: name, name, status: "finished", progress: 100, bytes: 1_000_000, files: [{ id: "0", name, path: name, size: 1_000_000, selected: true }] };
  return fingerprintTorrent(torrent, "alldebrid")[0];
}

const plex = (items: MetadataCatalog["items"]): MetadataCatalog => ({ source: "PLEX", status: "matched", items });
const jellyfin = (items: MetadataCatalog["items"]): MetadataCatalog => ({ source: "JELLYFIN", status: "matched", items });

describe("version manager metadata identity", () => {
  test("resolves a movie from a certain TMDb ID and preserves provenance", () => {
    const item = version("Dune.Part.Two.2024.2160p.WEB-DL.mkv");
    item.fingerprint.identity.tmdbId = "693134";
    const result = resolveVersionIdentity(item, [plex([{ title: "Dune: Part Two", year: 2024, kind: "movie", tmdbId: "693134", originalLanguage: "en", source: "PLEX" }])]);
    expect(result.status).toBe("matched");
    expect(result.conflicts).toHaveLength(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.98);
  });

  test("resolves title/year without an ID through a unique catalog candidate", () => {
    const item = version("The.Conversation.1974.1080p.WEB-DL.mkv");
    const result = resolveVersionIdentity(item, [jellyfin([{ title: "The Conversation", year: 1974, kind: "movie", tmdbId: "592", originalLanguage: "en", source: "JELLYFIN" }])]);
    expect(result.item?.tmdbId).toBe("592");
    expect(result.item?.source).toBe("JELLYFIN");
  });

  test("does not silently choose between homonymous candidates", () => {
    const item = version("Crash.1996.1080p.WEB-DL.mkv");
    const result = resolveVersionIdentity(item, [plex([
      { title: "Crash", year: 1996, kind: "movie", tmdbId: "",
        source: "PLEX" },
      { title: "Crash", year: 1996, kind: "movie", tmdbId: "1", source: "PLEX" },
    ])]);
    expect(result.status).toBe("ambiguous");
    expect(result.identityStatus).toBe("uncertain");
  });

  test("uses Plex GUID/provider IDs before title matching", () => {
    const item = version("Alien.1979.1080p.WEB-DL.mkv");
    item.fingerprint.identity.tmdbId = "348";
    const result = resolveVersionIdentity(item, [plex([{ title: "Alien", year: 1979, kind: "movie", tmdbId: "348", tvdbId: "wrong", source: "PLEX" }])]);
    expect(result.item?.tmdbId).toBe("348");
  });

  test("uses Jellyfin ProviderIds and original language", () => {
    const item = version("Spirited.Away.2001.1080p.WEB-DL.JPN.mkv");
    const result = resolveVersionIdentity(item, [jellyfin([{ title: "Spirited Away", year: 2001, kind: "movie", tmdbId: "129", imdbId: "tt0245429", originalLanguage: "ja", source: "JELLYFIN" }])]);
    expect(result.item?.originalLanguage).toBe("ja");
    expect(result.item?.imdbId).toBe("tt0245429");
  });

  test("reports conflicting provider IDs instead of selecting silently", () => {
    const item = version("Example.Movie.2020.1080p.WEB-DL.mkv");
    item.fingerprint.identity.tmdbId = "10";
    const result = resolveVersionIdentity(item, [
      plex([{ title: "Example Movie", year: 2020, kind: "movie", tmdbId: "10", source: "PLEX" }]),
      jellyfin([{ title: "Example Movie", year: 2020, kind: "movie", tmdbId: "20", source: "JELLYFIN" }]),
    ]);
    expect(result.identityStatus).toBe("conflict");
    expect(result.conflicts.some((conflict) => conflict.field === "tmdbId")).toBe(true);
    expect(result.conflicts.find((conflict) => conflict.field === "tmdbId")?.code).toBe("PROVIDER_ID_MISMATCH");
    expect(result.confidence).toBeLessThan(0.65);
  });

  test("classifies title, year, and season/episode conflicts explicitly", () => {
    const item = version("Example.Show.S02E03.2020.1080p.WEB-DL.mkv");
    item.fingerprint.identity.tmdbId = "100";
    const result = resolveVersionIdentity(item, [plex([
      { title: "Different Show", year: 2021, kind: "episode", season: 4, episode: 9, tmdbId: "100", source: "PLEX" },
      { title: "Another Show", year: 2022, kind: "episode", season: 5, episode: 10, tmdbId: "100", source: "PLEX" },
    ])]);
    expect(result.identityStatus).toBe("conflict");
    expect(result.conflicts.map((conflict) => conflict.code)).toEqual(expect.arrayContaining(["MULTIPLE_PLEX_CANDIDATES"]));
  });

  test("keeps series episodes distinct and groups only matching episode versions", () => {
    const first = version("The.Boys.S03E01.1080p.WEB-DL.mkv");
    const firstAlt = version("The.Boys.S03E01.2160p.WEB-DL.mkv");
    const second = version("The.Boys.S03E02.1080p.WEB-DL.mkv");
    expect(first.fingerprint.identity.season).toBe(3);
    expect(first.fingerprint.identity.episode).toBe(1);
    expect(second.fingerprint.identity.episode).toBe(2);
    expect(evaluateVersionGroups([first, firstAlt, second]).length).toBe(2);
  });

  test("preserves filename fallback and marks provider absence explicitly", () => {
    const item = version("Unresolved.Release.1080p.mkv");
    const result = resolveVersionIdentity(item, [{ source: "PLEX", status: "configuration_unavailable", items: [], error: "not configured" }]);
    expect(result.status).toBe("configuration_unavailable");
    expect(result.identityStatus).toBe("uncertain");
  });

  test("does not require Plex or Jellyfin for graceful filename fallback", () => {
    const item = version("Independent.Movie.2020.1080p.WEB-DL.mkv");
    const result = resolveVersionIdentity(item, []);
    expect(result.status).toBe("not_matched");
    expect(result.identityStatus).toBe("fallback");
    expect(result.confidence).toBeGreaterThan(0);
  });

  test("supports ORIGINAL as a language requirement using metadata, not an English assumption", () => {
    const item = version("Spirited.Away.2001.1080p.WEB-DL.ITA.JPN.mkv");
    item.fingerprint.identity.originalLanguage = "ja";
    item.fingerprint.audio = [{ language: "ita" }, { language: "jpn" }];
    const profile = { id: "primary", name: "PRIMARY", enabled: true, target: "QUALITY" as const, preferredResolution: "2160p", languagePolicy: { required: { values: ["original"], mode: "ALL" as const }, preferred: [], original: true }, sourceOrder: [], codecOrder: [], audioOrder: [] };
    expect(evaluateVersionGroups([item], [profile])[0].versions[0].evaluations[0].eligible).toBe(true);
  });

  test("uses persistent metadata cache entries and supports explicit invalidation", () => {
    const cacheKey = `test:metadata:${Date.now()}`;
    const metadata = { title: "Spirited Away", year: 2001, kind: "movie" as const, tmdbId: "129", source: "TMDB" as const };
    expect(getCachedVersionManagerMetadata(cacheKey)).toBeUndefined();
    saveVersionManagerMetadataCache(cacheKey, "TMDB", metadata);
    expect(getCachedVersionManagerMetadata(cacheKey)?.tmdbId).toBe("129");
    invalidateVersionManagerMetadataCache("TMDB");
    expect(getCachedVersionManagerMetadata(cacheKey)).toBeUndefined();
  });

  test("does not conflict on localized titles when canonical IDs agree", () => {
    const item = version("Example.Movie.2020.mkv");
    item.fingerprint.storage.path = "/media/example.mkv";
    const result = resolveVersionIdentity(item, [
      plex([{ title: "The Example", year: 2020, kind: "movie", tmdbId: "10", path: "/media/example.mkv", source: "PLEX" }]),
      jellyfin([{ title: "L'esempio", year: 2020, kind: "movie", tmdbId: "10", path: "/media/example.mkv", source: "JELLYFIN" }]),
    ]);
    expect(result.identityStatus).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(result.descriptiveDisagreements.some((entry) => entry.field === "title")).toBe(true);
  });

  test("does not conflict on normalized or edition titles when canonical IDs agree", () => {
    const item = version("Example.Movie.2020.mkv");
    const result = resolveVersionIdentity(item, [
      plex([{ title: "Example Movie", year: 2020, kind: "movie", tmdbId: "10", source: "PLEX" }]),
      jellyfin([{ title: "Example Movie - Extended Edition", year: 2020, kind: "movie", tmdbId: "10", source: "JELLYFIN" }]),
    ]);
    expect(result.identityStatus).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
  });

  test("ignores multiple weak Plex title candidates when another source has strong identity", () => {
    const item = version("Example.Movie.2020.mkv");
    const result = resolveVersionIdentity(item, [
      plex([
        { title: "Example Movie Release", year: 2020, kind: "movie", source: "PLEX" },
        { title: "Example Movie Extended", year: 2020, kind: "movie", source: "PLEX" },
      ]),
      jellyfin([{ title: "Example Movie", year: 2020, kind: "movie", tmdbId: "10", source: "JELLYFIN" }]),
    ]);
    expect(result.identityStatus).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
  });

  test("does not conflict when provider paths differ", () => {
    const item = version("Example.Movie.2020.mkv");
    const result = resolveVersionIdentity(item, [
      plex([{ title: "Example Movie", year: 2020, kind: "movie", tmdbId: "10", path: "/plex/Example.mkv", source: "PLEX" }]),
      jellyfin([{ title: "Example Movie", year: 2020, kind: "movie", tmdbId: "10", path: "/jellyfin/Example.mkv", source: "JELLYFIN" }]),
    ]);
    expect(result.identityStatus).toBe("resolved");
  });

  test("keeps strong canonical TMDb disagreement as conflict", () => {
    const item = version("Example.Movie.2020.mkv");
    item.fingerprint.storage.path = "/media/example.mkv";
    const result = resolveVersionIdentity(item, [
      plex([{ title: "Example Movie", year: 2020, kind: "movie", tmdbId: "10", path: "/media/example.mkv", source: "PLEX" }]),
      jellyfin([{ title: "Example Movie", year: 2020, kind: "movie", tmdbId: "20", path: "/media/example.mkv", source: "JELLYFIN" }]),
    ]);
    expect(result.identityStatus).toBe("conflict");
    expect(result.conflicts.some((entry) => entry.code === "PROVIDER_ID_MISMATCH")).toBe(true);
  });

  test("preserves Flow-like conflict/review behavior", () => {
    const item = version("Flow.2024.mkv");
    item.fingerprint.storage.path = "/media/flow.mkv";
    const result = resolveVersionIdentity(item, [
      plex([{ title: "Flow - Un mondo da salvare", year: 2024, kind: "movie", tmdbId: "823219", imdbId: "tt4772188", path: "/media/flow.mkv", source: "PLEX" }]),
      jellyfin([{ title: "FLOW", year: 2024, kind: "movie", tmdbId: "1281775", imdbId: "tt4772188", path: "/media/flow.mkv", source: "JELLYFIN" }]),
    ]);
    expect(result.identityStatus).toBe("conflict");
    expect(result.conflicts.find((entry) => entry.field === "tmdbId")?.code).toBe("PROVIDER_ID_MISMATCH");
  });

  test("keeps season and episode incompatibility conservative despite agreeing IDs", () => {
    const item = version("Example.Show.S02E03.mkv");
    item.fingerprint.storage.path = "/media/example-s02e03.mkv";
    const result = resolveVersionIdentity(item, [
      plex([{ title: "Example Show", year: 2020, kind: "episode", season: 2, episode: 3, tmdbId: "10", path: "/media/example-s02e03.mkv", source: "PLEX" }]),
      jellyfin([{ title: "Esempio", year: 2020, kind: "episode", season: 2, episode: 4, tmdbId: "10", path: "/media/example-s02e03.mkv", source: "JELLYFIN" }]),
    ]);
    expect(result.identityStatus).toBe("conflict");
    expect(result.conflicts.some((entry) => entry.code === "SEASON_EPISODE_MISMATCH")).toBe(true);
  });

  test("continues title/year fallback when no canonical IDs exist", () => {
    const item = version("Example.Movie.2020.mkv");
    const result = resolveVersionIdentity(item, [jellyfin([{ title: "Example Movie", year: 2020, kind: "movie", source: "JELLYFIN" }])]);
    expect(result.identityStatus).toBe("resolved");
    expect(result.item?.title).toBe("Example Movie");
  });
});
