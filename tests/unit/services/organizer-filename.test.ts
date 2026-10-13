import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  computeTarget,
  makeSymlink,
  type Parsed,
} from "../../../src/services/organizer";

const movie: Parsed = { type: "movie", title: "Example Film", year: 2024, ext: ".mkv" };
const episode: Parsed = { type: "tv", show: "Example Show", season: 1, episode: 2, ext: ".mkv" };

describe("Organizer filenames", () => {
  test("preserves the original basename for a movie", () => {
    const target = computeTarget(movie, "Example.Film.2024.1080p.WEB-DL.mkv", "/mount/release/file.mkv");
    expect(target).toEndWith("/Movies/Example Film (2024)/Example.Film.2024.1080p.WEB-DL.mkv");
  });

  test("preserves the original basename for episodes", () => {
    const target = computeTarget(
      episode,
      "Example.Show.S01E02.1080p.WEB-DL.ITA-ENG.mkv",
      "/mount/__all__/Release/Season 01/Example.Show.S01E02.1080p.WEB-DL.ITA-ENG.mkv",
    );
    expect(target).toEndWith(
      "/TV/Example Show/Season 01/Example.Show.S01E02.1080p.WEB-DL.ITA-ENG.mkv",
    );
    expect(target).not.toContain("Season 01/Season 01");
  });

  test("does not silently replace a different original-name symlink collision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "schro-organizer-"));
    try {
      const destination = path.join(root, "organized", "same.mkv");
      const first = path.join(root, "source-a.mkv");
      const second = path.join(root, "source-b.mkv");
      await makeSymlink(first, destination, false, true);
      await makeSymlink(second, destination, false, true);
      expect(await fs.readlink(destination)).toBe(path.relative(path.dirname(destination), first));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
