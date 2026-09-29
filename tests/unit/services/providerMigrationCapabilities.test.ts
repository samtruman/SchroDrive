import { describe, expect, test } from "bun:test";
import { migrationRouteLevel, providerMigrationCapabilities } from "../../../src/services/providerMigrationCapabilities";

function provider(id: string, configured = true): any {
  return { id, displayName: id, isConfigured: () => configured };
}

describe("provider migration capabilities", () => {
  test("only the validated AllDebrid to Real-Debrid direction is E2E validated", () => {
    const allDebrid = providerMigrationCapabilities(provider("alldebrid"));
    const realDebrid = providerMigrationCapabilities(provider("realdebrid"));
    expect(migrationRouteLevel(allDebrid, realDebrid)).toEqual({ level: "E2E_VALIDATED", supported: true });
    expect(migrationRouteLevel(realDebrid, allDebrid)).toEqual({ level: "UNVALIDATED", supported: true });
  });

  test("TorBox is unvalidated rather than universally unsupported", () => {
    const torbox = providerMigrationCapabilities(provider("torbox"));
    expect(torbox.capabilities.every((item) => item.validation === "UNVALIDATED")).toBe(true);
    expect(torbox.capabilities.find((item) => item.capability === "inventory")?.note).toContain("Free account");
  });

  test("unknown providers fail closed for migration routes", () => {
    const unknown = providerMigrationCapabilities(provider("future-provider"));
    const allDebrid = providerMigrationCapabilities(provider("alldebrid"));
    expect(migrationRouteLevel(unknown, allDebrid).supported).toBe(false);
  });
});
