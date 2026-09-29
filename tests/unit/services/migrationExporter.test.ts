import { describe, expect, test } from "bun:test";
import type { TorrentInfo } from "../../../src/providers";
import { fingerprintTorrent, evaluateVersionGroups, defaultVersionProfiles } from "../../../src/services/versionManager";
import { exportMigrationLibrary } from "../../../src/services/migrationExporter";
import { isRecoverable } from "../../../src/services/migrationExporter";

function item(id: string, name: string, files: TorrentInfo["files"], extra: Partial<TorrentInfo> = {}): TorrentInfo {
  return { id, name, status: "finished", progress: 100, bytes: 100, files, ...extra };
}

describe("migration exporter", () => {
  test("FULL_LIBRARY exports identity-certain items", () => {
    const providerItem = item("one", "Movie", [{ id: "f", name: "Movie.2025.mkv", path: "Movie.2025.mkv", size: 100, selected: true }], { infoHash: "a".repeat(40), raw: { provider: "alldebrid" } });
    const versions = fingerprintTorrent(providerItem, "alldebrid");
    const groups = evaluateVersionGroups(versions, defaultVersionProfiles);
    const result = exportMigrationLibrary([providerItem], groups);
    expect(result.manifest.schemaVersion).toBe("1.0");
    expect(result.manifest.sourceProvider).toBe("alldebrid");
    expect(result.manifest.readOnly).toBe(true);
    expect(result.manifest.items).toHaveLength(1);
    expect(result.magnetsText.trim()).toBe(`magnet:?xt=urn:btih:${"a".repeat(40)}`);
  });

  test("FULL_LIBRARY keeps uncertain, conflicting, and un-fingerprinted provider items", () => {
    const uncertain = item("uncertain", "Unclear release", [], { magnetUri: "magnet:?xt=urn:btih:" + "b".repeat(40) });
    const conflicting = item("conflict", "Conflict release", [{ id: "f", name: "Conflict.2025.mkv", path: "Conflict.2025.mkv", size: 100, selected: true }], { infoHash: "c".repeat(40) });
    const result = exportMigrationLibrary([uncertain, conflicting], []);
    expect(result.manifest.items.map((entry) => entry.providerItemId)).toEqual(["uncertain", "conflict"]);
    expect(result.manifest.items[0].fingerprints).toHaveLength(0);
    expect(result.manifest.items.every((entry) => entry.exportable)).toBe(true);
  });

  test("multifile season packs are exported once as provider items", () => {
    const pack = item("pack", "Show Season 01", [
      { id: "e1", name: "Show.S01E01.mkv", path: "Show/Show.S01E01.mkv", size: 50, selected: true },
      { id: "e2", name: "Show.S01E02.mkv", path: "Show/Show.S01E02.mkv", size: 50, selected: true },
    ], { infoHash: "d".repeat(40) });
    const versions = fingerprintTorrent(pack, "alldebrid");
    const result = exportMigrationLibrary([pack], evaluateVersionGroups(versions, defaultVersionProfiles));
    expect(result.manifest.items).toHaveLength(1);
    expect(result.manifest.items[0].mediaFiles).toHaveLength(2);
    expect(result.manifest.items[0].mediaFiles[0]).not.toHaveProperty("path");
    expect(result.manifest.items[0].fingerprints).toHaveLength(2);
    expect(result.magnetsText.trim().split("\n")).toHaveLength(1);
  });

  test("duplicate magnets are deduplicated and export is independent of decisions", () => {
    const first = item("first", "First", [], { infoHash: "e".repeat(40) });
    const second = item("second", "Second", [], { magnetUri: "magnet:?xt=urn:btih:" + "e".repeat(40) });
    const result = exportMigrationLibrary([first, second], []);
    expect(result.manifest.items).toHaveLength(2);
    expect(result.manifest.magnetCount).toBe(1);
    expect(result.magnetsText.trim().split("\n")).toHaveLength(1);
  });

  test("recoverability requires a canonical magnet or infohash", () => {
    expect(isRecoverable(item("recoverable", "x", [], { infoHash: "1".repeat(40) }))).toBe(true);
    expect(isRecoverable(item("not-recoverable", "x", []))).toBe(false);
  });

  test("manifest output contains no local file path or credential fields", () => {
    const result = exportMigrationLibrary([item("safe", "Title", [{ id: "f", name: "Title.mkv", path: "/mnt/private/Title.mkv", size: 1, selected: true }], { infoHash: "2".repeat(40) })]);
    const serialized = JSON.stringify(result.manifest);
    expect(serialized).not.toContain("/mnt/private");
    expect(serialized).not.toMatch(/api[_-]?key|password|token|cookie|passkey/i);
  });

  test("filtered modes use slots without changing the provider inventory", () => {
    const primary = item("primary", "Movie.2160p.mkv", [{ id: "p", name: "Movie.2025.2160p.mkv", path: "Movie.2025.2160p.mkv", size: 100, selected: true }], { infoHash: "f".repeat(40) });
    const remote = item("remote", "Movie.1080p.mkv", [{ id: "r", name: "Movie.2025.1080p.mkv", path: "Movie.2025.1080p.mkv", size: 50, selected: true }], { infoHash: "1".repeat(40) });
    const versions = [...fingerprintTorrent(primary, "alldebrid"), ...fingerprintTorrent(remote, "alldebrid")];
    const groups = evaluateVersionGroups(versions, defaultVersionProfiles.map((profile) => profile.id === "remote" ? { ...profile, enabled: true } : profile), { enableRemote: true, acquireMissingRemote: false });
    const full = exportMigrationLibrary([primary, remote], groups, { mode: "FULL_LIBRARY" });
    const primaryOnly = exportMigrationLibrary([primary, remote], groups, { mode: "PRIMARY_ONLY" });
    expect(full.manifest.items).toHaveLength(2);
    expect(primaryOnly.manifest.items.length).toBeGreaterThan(0);
    expect(full.manifest.items).toHaveLength(2);
  });
});
