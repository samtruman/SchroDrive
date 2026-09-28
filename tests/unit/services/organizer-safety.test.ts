import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readlink, lstat, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { config } from "../../../src/core/config";
import { computeTarget, makeSymlink, organizeOnce, resolveCollisionTarget } from "../../../src/services/organizer";

const fixtures: string[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "schrodrive-organizer-safety-"));
  fixtures.push(root);
  return root;
}

describe("Organizer safety", () => {
  test("preserves an existing symlink and allocates a deterministic collision target", async () => {
    const root = await fixture();
    const sourceA = path.join(root, "source-a.mkv");
    const sourceB = path.join(root, "source-b.mkv");
    const destination = path.join(root, "organized", "Film (2024).mkv");
    await writeFile(sourceA, "a");
    await writeFile(sourceB, "b");

    await makeSymlink(sourceA, destination, false, true);
    const alternate = await resolveCollisionTarget(sourceB, destination);
    const alternateAgain = await resolveCollisionTarget(sourceB, destination);
    expect(alternate).toBe(alternateAgain);
    expect(alternate).not.toBe(destination);

    await makeSymlink(sourceB, alternate, false, true);
    expect(await readlink(destination)).toBe(path.relative(path.dirname(destination), sourceA));
    expect(await readlink(alternate)).toBe(path.relative(path.dirname(alternate), sourceB));
  });

  test("does not overwrite a real file or directory", async () => {
    const root = await fixture();
    const source = path.join(root, "source.mkv");
    const realFile = path.join(root, "real.mkv");
    const realDir = path.join(root, "directory");
    await writeFile(source, "source");
    await writeFile(realFile, "keep");
    await mkdir(realDir);

    await makeSymlink(source, realFile, false, true);
    await makeSymlink(source, path.join(realDir, "child.mkv"), false, true);
    expect(await readFile(realFile, "utf8")).toBe("keep");
    expect((await lstat(realDir)).isDirectory()).toBe(true);
  });

  test("dry-run performs no mkdir, symlink, unlink or prune", async () => {
    const root = await fixture();
    const sourceRoot = path.join(root, "provider");
    const organized = path.join(root, "organized");
    const broken = path.join(organized, "Movies", "broken.mkv");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(path.dirname(broken), { recursive: true });
    await symlink(path.join(root, "missing.mkv"), broken);

    const previous = {
      mountBase: config.mountBase,
      organizedBase: config.organizedBase,
      providers: config.providers,
      webdavMountsEnabled: config.webdavMountsEnabled,
    };
    config.mountBase = root;
    config.organizedBase = organized;
    config.providers = ["provider"];
    config.webdavMountsEnabled = false;
    try {
      await organizeOnce({ dryRun: true });
      expect(await lstat(broken)).toBeTruthy();
      expect(await lstat(path.join(organized, "TV")).catch(() => null)).toBeNull();
    } finally {
      config.mountBase = previous.mountBase;
      config.organizedBase = previous.organizedBase;
      config.providers = previous.providers;
      config.webdavMountsEnabled = previous.webdavMountsEnabled;
    }
  });

  test("does not prune broken links when discovery is empty", async () => {
    const root = await fixture();
    const sourceRoot = path.join(root, "provider");
    const organized = path.join(root, "organized");
    const broken = path.join(organized, "Movies", "broken.mkv");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(path.dirname(broken), { recursive: true });
    await symlink(path.join(root, "missing.mkv"), broken);

    const previous = {
      mountBase: config.mountBase,
      organizedBase: config.organizedBase,
      providers: config.providers,
      webdavMountsEnabled: config.webdavMountsEnabled,
    };
    config.mountBase = root;
    config.organizedBase = organized;
    config.providers = ["provider"];
    config.webdavMountsEnabled = false;
    try {
      await organizeOnce({ dryRun: false });
      expect((await lstat(broken)).isSymbolicLink()).toBe(true);
    } finally {
      config.mountBase = previous.mountBase;
      config.organizedBase = previous.organizedBase;
      config.providers = previous.providers;
      config.webdavMountsEnabled = previous.webdavMountsEnabled;
    }
  });

  test("fails closed when the organized root is missing", async () => {
    const root = await fixture();
    const sourceRoot = path.join(root, "provider");
    const organized = path.join(root, "missing-organized");
    await mkdir(sourceRoot, { recursive: true });

    const previous = { mountBase: config.mountBase, organizedBase: config.organizedBase, providers: config.providers, webdavMountsEnabled: config.webdavMountsEnabled };
    config.mountBase = root;
    config.organizedBase = organized;
    config.providers = ["provider"];
    config.webdavMountsEnabled = false;
    try {
      await expect(organizeOnce({ dryRun: false })).rejects.toThrow("organized root unavailable");
      expect(await lstat(organized).catch(() => null)).toBeNull();
    } finally {
      config.mountBase = previous.mountBase;
      config.organizedBase = previous.organizedBase;
      config.providers = previous.providers;
      config.webdavMountsEnabled = previous.webdavMountsEnabled;
    }
  });

  test("fails closed when the organized root is not a directory", async () => {
    const root = await fixture();
    const sourceRoot = path.join(root, "provider");
    const rootFile = path.join(root, "organized-file");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(rootFile, "not a directory");

    const previous = { mountBase: config.mountBase, organizedBase: config.organizedBase, providers: config.providers, webdavMountsEnabled: config.webdavMountsEnabled };
    config.mountBase = root;
    config.organizedBase = rootFile;
    config.providers = ["provider"];
    config.webdavMountsEnabled = false;
    try {
      await expect(organizeOnce({ dryRun: false })).rejects.toThrow("organized root unavailable");
      expect((await lstat(rootFile)).isFile()).toBe(true);
    } finally {
      config.mountBase = previous.mountBase;
      config.organizedBase = previous.organizedBase;
      config.providers = previous.providers;
      config.webdavMountsEnabled = previous.webdavMountsEnabled;
    }
  });

  test("fails closed when the organized root is inaccessible", async () => {
    const root = await fixture();
    const sourceRoot = path.join(root, "provider");
    const organized = path.join(root, "organized");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(organized);
    await chmod(organized, 0o000);

    const previous = { mountBase: config.mountBase, organizedBase: config.organizedBase, providers: config.providers, webdavMountsEnabled: config.webdavMountsEnabled };
    config.mountBase = root;
    config.organizedBase = organized;
    config.providers = ["provider"];
    config.webdavMountsEnabled = false;
    try {
      await expect(organizeOnce({ dryRun: false })).rejects.toThrow("organized root unavailable");
    } finally {
      await chmod(organized, 0o700);
      config.mountBase = previous.mountBase;
      config.organizedBase = previous.organizedBase;
      config.providers = previous.providers;
      config.webdavMountsEnabled = previous.webdavMountsEnabled;
    }
  });

  test("allows an unused optional category to be absent", async () => {
    const root = await fixture();
    const sourceRoot = path.join(root, "provider");
    const organized = path.join(root, "organized");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(path.join(organized, "Movies"), { recursive: true });
    await mkdir(path.join(organized, "TV"), { recursive: true });

    const previous = { mountBase: config.mountBase, organizedBase: config.organizedBase, providers: config.providers, webdavMountsEnabled: config.webdavMountsEnabled };
    config.mountBase = root;
    config.organizedBase = organized;
    config.providers = ["provider"];
    config.webdavMountsEnabled = false;
    try {
      await expect(organizeOnce({ dryRun: false })).resolves.toBeUndefined();
      expect(await lstat(path.join(organized, "Anime")).catch(() => null)).toBeNull();
    } finally {
      config.mountBase = previous.mountBase;
      config.organizedBase = previous.organizedBase;
      config.providers = previous.providers;
      config.webdavMountsEnabled = previous.webdavMountsEnabled;
    }
  });

  test("creates an absent category only when an item needs it", async () => {
    const root = await fixture();
    const source = path.join(root, "provider", "__all__", "[SubsPlease] One Piece S01E01 [AB12CD34].mkv");
    const organized = path.join(root, "organized");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "anime");

    const previousBase = config.organizedBase;
    config.organizedBase = organized;
    try {
      const target = computeTarget(
        { type: "tv", show: "One Piece", season: 1, episode: 1, ext: ".mkv" },
        path.basename(source),
        source,
      )!;
      expect(target).toContain(`${path.sep}Anime${path.sep}`);
      expect(await lstat(path.join(organized, "Anime")).catch(() => null)).toBeNull();
      await makeSymlink(source, target, false, true);
      expect((await lstat(path.dirname(target))).isDirectory()).toBe(true);
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
    } finally {
      config.organizedBase = previousBase;
    }
  });

  test("dry-run plans an absent category without creating it", async () => {
    const root = await fixture();
    const source = path.join(root, "source.mkv");
    const target = path.join(root, "organized", "Future", "source.mkv");
    await writeFile(source, "source");
    await makeSymlink(source, target, true, true);
    expect(await lstat(path.join(root, "organized")).catch(() => null)).toBeNull();
  });

  test("honors canonical and original filename modes", async () => {
    const root = await fixture();
    const previousBase = config.organizedBase;
    const previousMode = config.organizerFilenameMode;
    const parsed = { type: "movie" as const, title: "Film", year: 2024, ext: ".mkv" };
    try {
      config.organizedBase = root;
      config.organizerFilenameMode = "canonical";
      expect(computeTarget(parsed, "Film.2160p.WEB-DL.mkv")).toEndWith("Film (2024).mkv");
      config.organizerFilenameMode = "original";
      expect(computeTarget(parsed, "Film.2160p.WEB-DL.mkv")).toEndWith("Film.2160p.WEB-DL.mkv");
    } finally {
      config.organizedBase = previousBase;
      config.organizerFilenameMode = previousMode;
    }
  });

  test.each([
    ["movie 2160p + 1080p", { type: "movie", title: "Film", year: 2024, ext: ".mkv" }, "Film.2160p.REMUX.mkv", "Film.1080p.WEB-DL.mkv"],
    ["two movie releases", { type: "movie", title: "Film", year: 2024, ext: ".mkv" }, "Film.A.mkv", "Film.B.mkv"],
    ["episode 2160p + 1080p", { type: "tv", show: "Show", year: 2024, season: 1, episode: 2, ext: ".mkv" }, "Show.S01E02.2160p.mkv", "Show.S01E02.1080p.mkv"],
    ["two episode releases", { type: "tv", show: "Show", year: 2024, season: 1, episode: 2, ext: ".mkv" }, "Show.S01E02.A.mkv", "Show.S01E02.B.mkv"],
  ] as const)("preserves %s as separate links", async (_label, parsed, sourceNameA, sourceNameB) => {
    const root = await fixture();
    const previousBase = config.organizedBase;
    const previousMode = config.organizerFilenameMode;
    config.organizedBase = path.join(root, "organized");
    config.organizerFilenameMode = "canonical";
    try {
      const sourceA = path.join(root, sourceNameA);
      const sourceB = path.join(root, sourceNameB);
      await writeFile(sourceA, "a");
      await writeFile(sourceB, "b");
      const canonical = computeTarget(parsed, sourceNameA, sourceA)!;
      expect(computeTarget(parsed, sourceNameB, sourceB)).toBe(canonical);
      await makeSymlink(sourceA, canonical, false, true);
      const alternate = await resolveCollisionTarget(sourceB, canonical);
      await makeSymlink(sourceB, alternate, false, true);
      expect((await lstat(canonical)).isSymbolicLink()).toBe(true);
      expect((await lstat(alternate)).isSymbolicLink()).toBe(true);
    } finally {
      config.organizedBase = previousBase;
      config.organizerFilenameMode = previousMode;
    }
  });

  test("keeps multifile episodes on distinct destinations", async () => {
    const root = await fixture();
    const previousBase = config.organizedBase;
    config.organizedBase = path.join(root, "organized");
    try {
      const first = computeTarget({ type: "tv", show: "Show", year: 2024, season: 1, episode: 1, ext: ".mkv" }, "Show.S01E01.mkv")!;
      const second = computeTarget({ type: "tv", show: "Show", year: 2024, season: 1, episode: 2, ext: ".mkv" }, "Show.S01E02.mkv")!;
      expect(first).not.toBe(second);
    } finally {
      config.organizedBase = previousBase;
    }
  });
});
