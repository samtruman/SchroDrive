import { describe, expect, test } from "bun:test";
import { aggregateMigrationJobs, effectiveMigrationStatus } from "../../../src/services/migrationState";

describe("effective migration state", () => {
  test("durable legal rejection hides raw provider readiness", () => {
    expect(effectiveMigrationStatus("READY_TO_IMPORT", { executionStatus: "REJECTED_LEGAL" })).toMatchObject({ status: "REJECTED_LEGAL" });
  });
  test("imported item is only promoted when inventory confirms it", () => {
    expect(effectiveMigrationStatus("ALREADY_PRESENT_EQUIVALENT_HASH", { executionStatus: "IMPORTED" }).status).toBe("IMPORTED");
    expect(effectiveMigrationStatus("READY_TO_IMPORT", { executionStatus: "IMPORTED" }).status).toBe("READY_TO_IMPORT");
  });
  test("raw status remains authoritative without history", () => {
    expect(effectiveMigrationStatus("REVIEW").status).toBe("REVIEW");
  });
  test("aggregates item audit rows into a read-only job summary", () => {
    const jobs = aggregateMigrationJobs([
      { id: 1, sourceProvider: "alldebrid", targetProvider: "realdebrid", infoHash: "a", executionStatus: "IMPORTED", createdAt: "2026-09-29T10:00:00Z" },
      { id: 2, sourceProvider: "alldebrid", targetProvider: "realdebrid", infoHash: "b", executionStatus: "REJECTED_LEGAL", reason: "LEGAL_RESTRICTION", createdAt: "2026-09-29T10:01:00Z" },
    ]);
    expect(jobs[0]).toMatchObject({ total: 2, imported: 1, rejectedLegal: 1, status: "PARTIAL" });
  });
});
