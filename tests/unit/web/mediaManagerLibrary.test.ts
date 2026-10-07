import { describe, expect, test } from "bun:test";
import {
  groupLibraryPhysicalReleases,
  libraryGroupProfileIds,
  matchesLibraryFilter,
  matchesMissingNeed,
  missingNeedVersions,
  missingProfileNeeds,
  physicalReleaseEpisodeCount,
  sortLibraryGroups,
  sortMissingNeeds,
} from "../../../web/src/components/media-manager/library-filters";

const movie = {
  id: "movie-1",
  identity: { title: "The Film", normalizedTitle: "the film", kind: "movie", year: 2024 },
  profileStatuses: [{ profileId: "primary", satisfied: true }, { profileId: "remote", satisfied: false }],
  versions: [
    {
      id: "film-keep",
      decision: "KEEP",
      satisfiesProfiles: ["primary"],
      fingerprint: { storage: { provider: "fixture", torrentId: "torrent-1", path: "/media/The.Film.2024.mkv" } },
    },
    {
      id: "film-review",
      decision: "REVIEW",
      fingerprint: { storage: { provider: "fixture", torrentId: "torrent-2", path: "/media/The.Film.alt.mkv" } },
    },
  ],
};

const episode = {
  id: "show-s01e01",
  identity: { title: "The Show", normalizedTitle: "the show", kind: "episode", season: 1, episode: 1 },
  profileStatuses: [{ profileId: "primary", satisfied: true }],
  versions: [{ id: "episode-keep", decision: "KEEP", satisfiesProfiles: ["primary"] }],
};

describe("Library filter semantics", () => {
  test("uses actual satisfied profiles, exact decisions, and version cardinality", () => {
    expect(libraryGroupProfileIds(movie)).toEqual(["primary", "remote"]);
    expect(matchesLibraryFilter(movie, { query: "the.film.2024", profile: "primary", mediaType: "movie", decision: "keep", multipleVersions: true })).toBe(true);
    expect(matchesLibraryFilter(movie, { query: "", profile: "remote", mediaType: "all", decision: "all", multipleVersions: false })).toBe(false);
    expect(matchesLibraryFilter(movie, { query: "", profile: "all", mediaType: "all", decision: "review", multipleVersions: false })).toBe(true);
    expect(matchesLibraryFilter(movie, { query: "", profile: "all", mediaType: "all", decision: "delete_candidate", multipleVersions: false })).toBe(false);
  });

  test("classifies Type from the real identity kind", () => {
    expect(matchesLibraryFilter(episode, { query: "", profile: "all", mediaType: "tv", decision: "all", multipleVersions: false })).toBe(true);
    expect(matchesLibraryFilter(episode, { query: "", profile: "all", mediaType: "movie", decision: "all", multipleVersions: false })).toBe(false);
  });

  test("sorts by title or actual version count", () => {
    expect(sortLibraryGroups([movie, episode], "title").map((group) => group.id)).toEqual(["movie-1", "show-s01e01"]);
    expect(sortLibraryGroups([episode, movie], "versions").map((group) => group.id)).toEqual(["movie-1", "show-s01e01"]);
  });

  test("reads missing profile needs from the current API shape and keeps legacy compatibility", () => {
    const current = [{ needId: "current" }];
    const legacy = [{ needId: "legacy" }];
    expect(missingProfileNeeds({ needs: current, previews: legacy })).toBe(current);
    expect(missingProfileNeeds({ previews: legacy })).toBe(legacy);
    expect(missingProfileNeeds({})).toEqual([]);
  });

  test("filters and sorts missing needs by their own semantics and current files", () => {
    const westies = {
      id: "westies",
      contentIdentity: { title: "The Westies", kind: "episode", season: 1, episode: 6 },
      mediaType: "tv",
      profileId: "primary",
      whatIsMissing: "required audio",
      existingVersions: [],
      rejectedVersions: [{ id: "version-1", fingerprint: { storage: { provider: "alldebrid", torrentId: "755", path: "/The.Westies.S01E06.mkv" } } }],
    };
    const silo = { id: "silo", contentIdentity: { title: "Silo", kind: "episode", season: 3, episode: 1 }, mediaType: "tv", profileId: "primary", rejectedVersions: [] };
    expect(missingNeedVersions(westies)).toHaveLength(1);
    expect(matchesMissingNeed(westies, { query: "s01e06", profile: "primary", mediaType: "tv" })).toBe(true);
    expect(matchesMissingNeed(westies, { query: "", profile: "other", mediaType: "all" })).toBe(false);
    expect(sortMissingNeeds([westies, silo]).map((item) => item.id)).toEqual(["silo", "westies"]);
  });

  test("groups season-pack members into one physical release and deduplicates its size", () => {
    const packGroups = [
      { id: "s01e01", identity: { title: "Show", kind: "episode", season: 1, episode: 1 }, versions: [{ id: "pack-e01", decision: "KEEP", fingerprint: { storage: { provider: "fixture", torrentId: "pack", fileId: "e01", path: "e01.mkv", size: 100, recoverability: { status: "RECOVERABLE" } } } }] },
      { id: "s01e02", identity: { title: "Show", kind: "episode", season: 1, episode: 2 }, versions: [{ id: "pack-e02", decision: "KEEP", fingerprint: { storage: { provider: "fixture", torrentId: "pack", fileId: "e02", path: "e02.mkv", size: 200, recoverability: { status: "RECOVERABLE" } } } }] },
    ];
    const releases = groupLibraryPhysicalReleases(packGroups);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ key: "fixture:pack", physicalSize: 300, recoverable: true });
    expect(releases[0].members.map(({ group }) => group.id)).toEqual(["s01e01", "s01e02"]);
    expect(physicalReleaseEpisodeCount(releases[0])).toBe(2);
  });

  test("does not label duplicate movie records as a season pack", () => {
    const duplicateMovieRecords = [
      { id: "review-copy", identity: { kind: "unknown" }, versions: [{ id: "review", decision: "REVIEW", fingerprint: { storage: { provider: "fixture", torrentId: "movie", fileId: "file", path: "1917.mkv", size: 100 } } }] },
      { id: "movie-1917", identity: { title: "1917", kind: "movie", year: 2019 }, versions: [{ id: "keep", decision: "KEEP", fingerprint: { storage: { provider: "fixture", torrentId: "movie", fileId: "file", path: "1917.mkv", size: 100 } } }] },
    ];
    const [release] = groupLibraryPhysicalReleases(duplicateMovieRecords);
    expect(physicalReleaseEpisodeCount(release)).toBe(0);
  });
});
