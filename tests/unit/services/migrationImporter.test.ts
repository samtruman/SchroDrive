import { describe, expect, test } from "bun:test";
import type { TorrentInfo } from "../../../src/providers";
import { analyzeMigrationImport, executeMigrationImportItem } from "../../../src/services/migrationImporter";
import { exportMigrationLibrary } from "../../../src/services/migrationExporter";

const torrent = (id: string, hash?: string): TorrentInfo => ({
  id, name: id, status: "finished", progress: 100, bytes: 1, files: [], infoHash: hash,
});

describe("migration importer preview", () => {
  test("FULL export is idempotent against the source inventory", () => {
    const inventory = [torrent("one", "a".repeat(40)), torrent("two", "b".repeat(40))];
    const exported = exportMigrationLibrary(inventory);
    const plan = analyzeMigrationImport({ manifest: exported.manifest, magnetsText: exported.magnetsText }, inventory);
    expect(plan.readOnly).toBe(true);
    expect(plan.counts.ALREADY_PRESENT).toBe(2);
    expect(plan.items).toHaveLength(2);
    expect(plan.counts.ALREADY_PRESENT_EQUIVALENT_HASH).toBe(0);
    expect(plan.counts.READY_TO_IMPORT).toBe(0);
  });

  test("recognises an equivalent hash under a different provider item id", () => {
    const plan = analyzeMigrationImport({ magnetsText: `magnet:?xt=urn:btih:${"a".repeat(40)}` }, [torrent("other", "a".repeat(40))]);
    expect(plan.counts.ALREADY_PRESENT_EQUIVALENT_HASH).toBe(1);
  });

  test("uses provider-raw infohash evidence when normalized fields are absent", () => {
    const plan = analyzeMigrationImport({ magnetsText: `magnet:?xt=urn:btih:${"a".repeat(40)}` }, [{ ...torrent("rd-item"), raw: { hashString: "a".repeat(40) } }]);
    expect(plan.counts.ALREADY_PRESENT_EQUIVALENT_HASH).toBe(1);
    expect(plan.counts.READY_TO_IMPORT).toBe(0);
  });

  test("classifies new, missing, invalid and duplicate magnet inputs without mutation", () => {
    const hash = "c".repeat(40);
    const plan = analyzeMigrationImport({ magnetsText: [
      `magnet:?xt=urn:btih:${hash}`,
      `magnet:?xt=urn:btih:${hash}`,
      "not-a-magnet",
      "magnet:?xt=urn:btih:invalid",
    ].join("\n") });
    expect(plan.counts.READY_TO_IMPORT).toBe(1);
    expect(plan.counts.INVALID_MAGNET).toBe(2);
    expect(plan.counts.MISSING_HASH).toBe(0);
  });

  test("manifest without a recoverable hash is not importable", () => {
    const plan = analyzeMigrationImport({ manifest: { schemaVersion: "1.0", items: [{ providerItemId: "x", originalName: "unknown" }] } });
    expect(plan.counts.MISSING_HASH).toBe(1);
  });

  test("rejects unsupported manifest schema without trusting metadata", () => {
    const plan = analyzeMigrationImport({ manifest: { schemaVersion: "9.9", items: [] } });
    expect(plan.errors).toContain("Unsupported manifest schema version");
    expect(plan.items).toHaveLength(0);
  });

  test("executes only the supplied recoverable item through DebridProvider", async () => {
    const calls: string[] = [];
    const provider: any = { addMagnet: async (magnet: string) => { calls.push(magnet); return { id: "target-1" }; } };
    const result = await executeMigrationImportItem({ canonicalInfohash: "d".repeat(40), originalName: "Movie.mkv" }, provider);
    expect(result.providerItemId).toBe("target-1");
    expect(calls).toEqual([`magnet:?xt=urn:btih:${"d".repeat(40)}`]);
  });
});
