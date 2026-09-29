import { describe, expect, test } from "bun:test";
import type { TorrentInfo } from "../../../src/providers";
import { analyzeMigrationImport, executeMigrationImportBulk, executeMigrationImportItem } from "../../../src/services/migrationImporter";
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

  test("bulk execution revalidates each item and resumes by skipping hashes already present", async () => {
    const added: string[] = [];
    const hashes = new Set<string>(["a".repeat(40)]);
    const provider: any = {
      isConfigured: () => true,
      listTorrents: async () => [...hashes].map((hash) => torrent(`target-${hash.slice(0, 4)}`, hash)),
      addMagnet: async (magnet: string) => { const hash = magnet.split(":").pop()!; hashes.add(hash); added.push(hash); return { id: `target-${hash.slice(0, 4)}` }; },
    };
    const items: any[] = [
      { source: "MANIFEST", index: 0, status: "READY_TO_IMPORT", infoHash: "a".repeat(40), originalName: "already.mkv", reason: "ready at initial snapshot" },
      { source: "MANIFEST", index: 1, status: "READY_TO_IMPORT", infoHash: "b".repeat(40), originalName: "new.mkv", reason: "ready at initial snapshot" },
    ];
    const progress: any[] = [];
    const result = await executeMigrationImportBulk(items, provider, { targetInventory: () => provider.listTorrents(), onProgress: (value) => progress.push(value) });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(added).toEqual(["b".repeat(40)]);
    expect(progress.at(-1).remaining).toBe(0);
  });

  test("classifies HTTP 451 as legal rejection without retry", async () => {
    let calls = 0;
    const provider: any = { isConfigured: () => true, listTorrents: async () => [], addMagnet: async () => { calls++; const error: any = new Error("legal"); error.response = { status: 451 }; throw error; } };
    const result = await executeMigrationImportBulk([{ source: "MANIFEST", index: 0, status: "READY_TO_IMPORT", infoHash: "c".repeat(40), reason: "ready" }], provider, { targetInventory: () => provider.listTorrents(), sleep: async () => { throw new Error("must not sleep"); } });
    expect(calls).toBe(1);
    expect(result.rejectedLegal).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "REJECTED_LEGAL", reason: "LEGAL_RESTRICTION", retryCount: 0, importExecuted: true });
  });

  test("continues after seven legal rejections and imports a later valid item", async () => {
    const calls: string[] = [];
    const provider: any = { isConfigured: () => true, listTorrents: async () => [], addMagnet: async (magnet: string) => { const hash = magnet.split(":").pop()!; calls.push(hash); if (hash !== "2".repeat(40)) { const error: any = new Error("legal"); error.response = { status: 451 }; throw error; } return { id: "valid-target" }; } };
    const itemHashes = ["a", "b", "c", "d", "e", "f", "1", "2"];
    const items = itemHashes.map((value, index) => ({ source: "MANIFEST" as const, index, status: "READY_TO_IMPORT" as const, infoHash: value.repeat(40), reason: "ready" }));
    const result = await executeMigrationImportBulk(items, provider, { targetInventory: () => provider.listTorrents() });
    expect(result.rejectedLegal).toBe(7);
    expect(result.imported).toBe(1);
    expect(result.systemicFailure).toBeUndefined();
    expect(calls).toHaveLength(8);
  });

  test("retries 429, but stops on systemic 401 and persistent 5xx", async () => {
    let rateCalls = 0;
    const rateProvider: any = { isConfigured: () => true, listTorrents: async () => [], addMagnet: async () => { rateCalls++; if (rateCalls === 1) { const error: any = new Error("rate limit"); error.response = { status: 429, headers: { "retry-after": "1" } }; throw error; } return { id: "rate-ok" }; } };
    const rateResult = await executeMigrationImportBulk([{ source: "MANIFEST", index: 0, status: "READY_TO_IMPORT", infoHash: "1".repeat(40), reason: "ready" }], rateProvider, { targetInventory: () => rateProvider.listTorrents(), sleep: async () => undefined });
    expect(rateCalls).toBe(2);
    expect(rateResult.imported).toBe(1);

    const authProvider: any = { isConfigured: () => true, listTorrents: async () => [], addMagnet: async () => { const error: any = new Error("auth"); error.response = { status: 401 }; throw error; } };
    const authResult = await executeMigrationImportBulk([{ source: "MANIFEST", index: 0, status: "READY_TO_IMPORT", infoHash: "2".repeat(40), reason: "ready" }], authProvider, { targetInventory: () => authProvider.listTorrents() });
    expect(authResult.systemicFailure?.status).toBe(401);
    expect(authResult.results).toHaveLength(0);

    const serverProvider: any = { isConfigured: () => true, listTorrents: async () => [], addMagnet: async () => { const error: any = new Error("server"); error.response = { status: 503 }; throw error; } };
    const serverResult = await executeMigrationImportBulk([{ source: "MANIFEST", index: 0, status: "READY_TO_IMPORT", infoHash: "3".repeat(40), reason: "ready" }], serverProvider, { targetInventory: () => serverProvider.listTorrents(), sleep: async () => undefined });
    expect(serverResult.systemicFailure?.status).toBe(503);
  });
});
