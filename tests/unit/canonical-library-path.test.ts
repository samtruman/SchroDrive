import { describe, expect, test } from "bun:test";
import { canonicalLibraryDirectory, canonicalLibraryPath } from "../../src/services/canonicalLibraryPath";

describe("canonical library paths", () => {
  test("uses the same TMDb-derived movie directory for every consumer", () => {
    expect(canonicalLibraryDirectory("/organized", { category: "Movies", title: "Wolfs", year: 2024 }))
      .toBe("/organized/Movies/Wolfs (2024)");
    expect(canonicalLibraryPath("/organized", { category: "Movies", title: "Wolfs", year: 2024, sourceFilename: "release.mkv" }))
      .toBe("/organized/Movies/Wolfs (2024)/release.mkv");
  });

  test("keeps season paths deterministic for TV", () => {
    expect(canonicalLibraryPath("/organized", { category: "TV", title: "Slow Horses", year: 2022, season: 6, episode: 4, sourceFilename: "Slow.Horses.S06E04.mkv" }))
      .toBe("/organized/TV/Slow Horses (2022)/Season 06/Slow.Horses.S06E04.mkv");
  });
});
