import { describe, expect, test } from "bun:test";
import { getDb } from "../../../src/core/db";
import { recordOrganizerReview, decideOrganizerReview, getOrganizerReview } from "../../../src/services/organizerReview";
import { applyManualIdentityOverrides } from "../../../src/services/manualIdentity";
import { validateReviewEpisodeAssignments } from "../../../src/services/reviewEpisodeAssignments";
import { fingerprintTorrent } from "../../../src/services/versionManager";

const parsed = (file: string) => ({ status: "ambiguous" as const, kind: "movie" as const, title: "Fixture", extension: ".mkv", sourceBasename: file, confidence: 0.4, reason: "fixture" });
const override = { title: "Fixture Series", kind: "episode" as const, tmdbId: "123", season: 3 };
function version(file: string) {
  return fingerprintTorrent({ id: "fixture", name: "Fixture", status: "finished", progress: 100, bytes: 1000, files: [{ id: file, name: file, path: `release/${file}`, size: 1000, selected: true }] }, "alldebrid")[0];
}
describe("manual episode mapping integration", () => {
  test("saves different episodes for different files and reads the mapping back", () => {
    const paths = ["/mnt/schrodrive/alldebrid/shows/release/one.mkv", "/mnt/schrodrive/alldebrid/__all__/release/one.mkv", "/mnt/schrodrive/alldebrid/shows/release/two.mkv"];
    const rows = paths.map((path, index) => recordOrganizerReview(path, parsed(index === 2 ? "two.mkv" : "one.mkv")));
    const assignments = validateReviewEpisodeAssignments(rows, rows.map((row, index) => ({ id: row.id, episode: index === 2 ? 2 : 1 })));
    getDb().transaction(() => rows.forEach((row) => decideOrganizerReview(row.id, "accepted", { ...override, episode: assignments.get(row.id) })))();
    expect(getOrganizerReview(paths[0])?.override).toMatchObject({ ...override, episode: 1 });
    expect(getOrganizerReview(paths[2])?.override).toMatchObject({ ...override, episode: 2 });
    const result = applyManualIdentityOverrides([version("one.mkv"), version("two.mkv")]);
    expect(result[0].fingerprint.identity).toMatchObject({ ...override, episode: 1 });
    expect(result[1].fingerprint.identity).toMatchObject({ ...override, episode: 2 });
  });
  test("rejects an unsupported provider without marking the review accepted", () => {
    const path = "/mnt/schrodrive/unrecognised/shows/fixture/unsafe.mkv";
    const row = recordOrganizerReview(path, parsed("unsafe.mkv"));
    expect(() => decideOrganizerReview(row.id, "accepted", { ...override, episode: 1 })).toThrow();
    expect(getOrganizerReview(path)?.decision).toBe("pending");
  });
  test("does not save any item if the mapping is incomplete", () => {
    const rows = [recordOrganizerReview("/mnt/schrodrive/alldebrid/shows/release/three.mkv", parsed("three.mkv")), recordOrganizerReview("/mnt/schrodrive/alldebrid/shows/release/four.mkv", parsed("four.mkv"))];
    expect(() => validateReviewEpisodeAssignments(rows, [{ id: rows[0].id, episode: 3 }])).toThrow();
    expect(getOrganizerReview(rows[0].sourcePath)?.decision).toBe("pending");
    expect(getOrganizerReview(rows[1].sourcePath)?.decision).toBe("pending");
  });
});
