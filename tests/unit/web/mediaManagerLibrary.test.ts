import { describe, expect, test } from "bun:test";
import {
  libraryGroupProfileIds,
  matchesLibraryFilter,
  sortLibraryGroups,
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
});
