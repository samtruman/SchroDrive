import { describe, expect, test } from "bun:test";
import type { DebridProvider, TorrentInfo, VirtualDirectory } from "../../../src/providers";
import { loadMediaManagerInventory } from "../../../src/services/mediaManagerInventory";
import { evaluateVersionGroups, type VersionProfile } from "../../../src/services/versionManager";

function item(id: string, name: string, files: TorrentInfo["files"] = []): TorrentInfo {
  return { id, name, status: "finished", progress: 100, bytes: files.reduce((sum, file) => sum + file.size, 0), files };
}

function provider(items: TorrentInfo[], directories: VirtualDirectory[], counters?: { list: number; tree: number }): DebridProvider {
  return {
    id: "fixture",
    displayName: "Fixture",
    isConfigured: () => true,
    isRateLimited: () => false,
    getWaitTime: () => 0,
    listTorrents: async () => { if (counters) counters.list++; return items; },
    fetchDirectories: async () => { if (counters) counters.tree++; return directories; },
    addMagnet: async () => ({ id: "unused" }),
    checkExisting: async () => false,
    isTorrentDead: () => false,
    deleteTorrent: async () => {},
    resolveDownloadUrl: async () => null,
  } as DebridProvider;
}

const profile: VersionProfile = {
  id: "primary", name: "PRIMARY", enabled: true, target: "QUALITY", preferredResolution: "2160p",
  languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false },
  sourceOrder: ["REMUX", "WEB-DL"], codecOrder: ["HEVC", "H264"], audioOrder: ["TRUEHD", "DDP"],
};

describe("Media Manager canonical inventory", () => {
  test("uses one ProviderItem file tree to create one single-file fingerprint", async () => {
    const versions = await loadMediaManagerInventory([provider(
      [item("movie", "Release folder")],
      [{ id: "movie", name: "Release folder", originalName: "Release folder", files: [{ id: "mkv", name: "Movie.2025.1080p.WEB-DL.mkv", size: 10 }] }],
    )]);
    expect(versions).toHaveLength(1);
    expect(versions[0].fingerprint.storage.torrentId).toBe("movie");
  });

  test("expands season packs and multifile torrents while ignoring non-media files", async () => {
    const versions = await loadMediaManagerInventory([provider(
      [item("season", "Season Pack")],
      [{ id: "season", name: "Season Pack", originalName: "Season Pack", files: [
        { id: "e1", name: "Show.S01E01.1080p.mkv", size: 10 },
        { id: "e2", name: "Show.S01E02.1080p.mp4", size: 11 },
        { id: "sample", name: "sample.mkv", size: 1 },
        { id: "sub", name: "Show.S01E01.srt", size: 1 },
      ] }],
    )]);
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.fingerprint.storage.fileId)).toEqual(["e1", "e2"]);
  });

  test("preserves nested file paths and handles a provider item without a media extension", async () => {
    const versions = await loadMediaManagerInventory([provider(
      [item("folder", "Show Season 1")],
      [{ id: "folder", name: "Show Season 1", originalName: "Show Season 1", files: [{ id: "nested", name: "Show.S01E01.1080p.mkv", size: 10 }] }],
    )]);
    expect(versions).toHaveLength(1);
    expect(versions[0].fingerprint.storage.path).toBe("Show.S01E01.1080p.mkv");
  });

  test("deduplicates identical file representations from a provider tree", async () => {
    const versions = await loadMediaManagerInventory([provider(
      [item("dup", "Release")],
      [{ id: "dup", name: "Release", originalName: "Release", files: [
        { id: "a", name: "Movie.2025.1080p.mkv", size: 10 },
        { id: "b", name: "Movie.2025.1080p.mkv", size: 10 },
      ] }],
    )]);
    expect(versions).toHaveLength(1);
  });

  test("falls back explicitly to inline files when no full tree is available", async () => {
    const counters = { list: 0, tree: 0 };
    const versions = await loadMediaManagerInventory([provider(
      [item("inline", "Movie.2025.1080p.mkv", [{ id: "inline-file", name: "Movie.2025.1080p.mkv", path: "Movie.2025.1080p.mkv", size: 10, selected: true }])],
      [], counters,
    )]);
    expect(versions).toHaveLength(1);
    expect(counters).toEqual({ list: 1, tree: 1 });
  });

  test("uses a stable item-name fallback when a provider exposes no files", async () => {
    const versions = await loadMediaManagerInventory([provider(
      [item("name-only", "Movie.2025.1080p.mkv")],
      [],
    )]);
    expect(versions).toHaveLength(1);
    expect(versions[0].fingerprint.storage.fileId).toBe("torrent");
  });

  test("keeps policy multi-version evaluation intact after canonical expansion", async () => {
    const versions = await loadMediaManagerInventory([provider(
      [item("pack", "Movie pack")],
      [{ id: "pack", name: "Movie pack", originalName: "Movie pack", files: [
        { id: "2160", name: "Movie.2025.2160p.REMUX.mkv", size: 20 },
        { id: "1080", name: "Movie.2025.1080p.WEB-DL.mkv", size: 10 },
      ] }],
    )]);
    const [group] = evaluateVersionGroups(versions, [profile]);
    expect(group.versions).toHaveLength(2);
    expect(group.versions.some((version) => version.decision === "KEEP")).toBe(true);
  });
});
