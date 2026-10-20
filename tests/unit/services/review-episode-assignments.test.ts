import { describe, expect, test } from "bun:test";
import { validateReviewEpisodeAssignments } from "../../../src/services/reviewEpisodeAssignments";

describe("manual season episode assignments", () => {
  const entries = [
    { id: "one-all", sourcePath: "/mnt/alldebrid/__all__/release/one.mkv" },
    { id: "one-shows", sourcePath: "/mnt/alldebrid/shows/release/one.mkv" },
    { id: "two", sourcePath: "/mnt/alldebrid/shows/release/two.mkv" },
  ];
  test("preserves explicit numbers across views of one file", () => {
    const result = validateReviewEpisodeAssignments(entries, [
      { id: "one-all", episode: 1 }, { id: "one-shows", episode: 1 }, { id: "two", episode: 2 },
    ]);
    expect([...result.values()]).toEqual([1, 1, 2]);
  });
  test("rejects conflicting numbers for the same source", () => {
    expect(() => validateReviewEpisodeAssignments(entries, [
      { id: "one-all", episode: 1 }, { id: "one-shows", episode: 2 }, { id: "two", episode: 2 },
    ])).toThrow();
  });
  test("rejects missing, repeated and invalid assignments", () => {
    expect(() => validateReviewEpisodeAssignments(entries, [{ id: "one-all", episode: 1 }])).toThrow();
    expect(() => validateReviewEpisodeAssignments(entries, [
      { id: "one-all", episode: 1 }, { id: "one-all", episode: 1 }, { id: "two", episode: -1 },
    ])).toThrow();
  });
});
