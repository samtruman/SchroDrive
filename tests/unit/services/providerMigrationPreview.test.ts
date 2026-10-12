import { describe, expect, test } from "bun:test";
import { previewProviderMigration, rememberMigrationPreview, selectMigrationPreview } from "../../../src/services/providerMigrationPreview";

const torrent = (hash: string) => ({ id: hash, name: "Synthetic movie", infoHash: hash.repeat(40), status: "finished", progress: 100, bytes: 100, files: [] });
const provider = (id: string, inventory: any[]) => ({ id, displayName: id, isConfigured: () => true, listTorrents: async () => inventory, addMagnet: () => { throw new Error("Preview must never mutate a provider"); }, deleteTorrent: () => { throw new Error("Never delete a source item"); } }) as any;

describe("direct provider migration", () => {
  test("reads source, reconciles target and excludes durable legal failures without mutations", async () => {
    const audit = [{ infoHash: "b".repeat(40), executionStatus: "REJECTED_LEGAL" }];
    const plan = await previewProviderMigration(provider("alldebrid", [torrent("a"), torrent("b"), torrent("c")]), provider("realdebrid", [torrent("a")]), audit);
    expect(plan.counts.READY_TO_IMPORT).toBe(1);
    expect(plan.counts.REJECTED_LEGAL).toBe(1);
    const saved = rememberMigrationPreview(plan);
    expect(selectMigrationPreview(saved.previewId, "alldebrid", "realdebrid", ["c".repeat(40)], audit).items).toHaveLength(1);
    expect(() => selectMigrationPreview(saved.previewId, "alldebrid", "realdebrid", ["b".repeat(40)], audit)).toThrow("ineligible");
    expect(() => selectMigrationPreview(saved.previewId, "realdebrid", "alldebrid", ["c".repeat(40)], audit)).toThrow("providers");
    expect(() => selectMigrationPreview(saved.previewId, "alldebrid", "realdebrid", ["f".repeat(40)], audit)).toThrow("ineligible");
    expect(() => selectMigrationPreview("expired", "alldebrid", "realdebrid", ["c".repeat(40)], audit)).toThrow("expired");
    expect(() => selectMigrationPreview(saved.previewId, "alldebrid", "realdebrid", ["c".repeat(40)], [{ infoHash: "c".repeat(40), executionStatus: "FAILED_PERMANENT" }])).toThrow("ineligible");
  });
  test("rejects identical providers", async () => {
    await expect(previewProviderMigration(provider("alldebrid", []), provider("alldebrid", []), [])).rejects.toThrow("different");
  });
});
