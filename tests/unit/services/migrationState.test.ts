import { describe, expect, test } from "bun:test";
import { effectiveMigrationStatus } from "../../../src/services/migrationState";

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
});
