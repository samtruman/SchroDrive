import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../../src/core/config";
import { deleteMagnetBackup, getMagnetBackupSchedule, listMagnetBackups, saveMagnetBackupSchedule } from "../../../src/services/magnetBackup";

const originalDataDir = config.dataDir;
const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-magnet-backup-"));

beforeAll(() => { (config as any).dataDir = temporaryDataDir; });
afterAll(() => { (config as any).dataDir = originalDataDir; fs.rmSync(temporaryDataDir, { recursive: true, force: true }); });

describe("magnet backup management", () => {
  test("persists a daily schedule and retention settings", () => {
    const saved = saveMagnetBackupSchedule({ enabled: true, provider: "AllDebrid", mode: "INCREMENTAL", frequency: "DAILY", time: "04:30", timezone: "Europe/Rome", keepLatest: 14, keepMonthly: 6 });
    expect(saved).toMatchObject({ enabled: true, provider: "alldebrid", mode: "INCREMENTAL", frequency: "DAILY", time: "04:30", keepLatest: 14, keepMonthly: 6 });
    expect(getMagnetBackupSchedule()).toMatchObject(saved);
  });

  test("protects a full baseline until dependent incrementals are deleted", () => {
    const directory = path.join(temporaryDataDir, "magnet-backups"); fs.mkdirSync(directory, { recursive: true });
    const fullFile = path.join(directory, "full.json"), incrementalFile = path.join(directory, "incremental.json"); fs.writeFileSync(fullFile, "{}"); fs.writeFileSync(incrementalFile, "{}");
    const common = { provider: "alldebrid", createdAt: new Date().toISOString(), itemCount: 1, magnetCount: 1, sha256: "fixture", added: 1, modified: 0, removed: 0, valid: true };
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify([{ ...common, id: "full", mode: "FULL", file: fullFile }, { ...common, id: "incremental", mode: "INCREMENTAL", file: incrementalFile, baseBackupId: "full" }]));
    expect(() => deleteMagnetBackup("full")).toThrow("still required");
    expect(deleteMagnetBackup("incremental").id).toBe("incremental");
    expect(deleteMagnetBackup("full").id).toBe("full");
    expect(listMagnetBackups()).toHaveLength(0);
  });
});
