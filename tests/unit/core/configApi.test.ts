import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRuntimeOrPersistedValue, saveConfigToFile, getConfigWithSources } from "../../../src/core/configApi";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe("configuration loading", () => {
  test("classifies a real container environment value as locked", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "PLEX_URL=persisted-url\n");
    const previous = process.env.PLEX_URL;
    process.env.PLEX_URL = "container-url";

    const result = getConfigWithSources({ envPath, containerEnvKeys: new Set(["PLEX_URL"]) });
    expect(result.config.PLEX_URL.value).toBe("container-url");
    expect(result.config.PLEX_URL.source).toBe("env");
    expect(result.config.PLEX_URL.provenance).toBe("CONTAINER_ENV");
    expect(result.config.PLEX_URL.locked).toBe(true);
    if (previous === undefined) delete process.env.PLEX_URL;
    else process.env.PLEX_URL = previous;
  });

  test("classifies a value present only in persisted .env as editable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "JELLYFIN_API_KEY=persisted-secret\n");

    const result = getConfigWithSources({ envPath, containerEnvKeys: new Set() });
    expect(result.config.JELLYFIN_API_KEY.value).toBe("persisted-secret");
    expect(result.config.JELLYFIN_API_KEY.source).toBe("file");
    expect(result.config.JELLYFIN_API_KEY.provenance).toBe("PERSISTED_DOTENV");
    expect(result.config.JELLYFIN_API_KEY.locked).toBe(false);
  });

  test("classifies absent values as editable defaults", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    const result = getConfigWithSources({ envPath: path.join(tempDir, ".env"), containerEnvKeys: new Set() });
    expect(result.config.JELLYFIN_USER_ID.value).toBe("");
    expect(result.config.JELLYFIN_USER_ID.source).toBe("default");
    expect(result.config.JELLYFIN_USER_ID.provenance).toBe("DEFAULT");
    expect(result.config.JELLYFIN_USER_ID.locked).toBe(false);
    expect(result.config.ORGANIZER_FILENAME_MODE.value).toBe("canonical");
    expect(result.config.ORGANIZER_FILENAME_MODE.source).toBe("default");
    expect(result.config.ORGANIZER_FILENAME_MODE.locked).toBe(false);
    expect(result.config.PROVIDER_RECONCILIATION_ENABLED.value).toBe("false");
    expect(result.config.PROVIDER_RECONCILIATION_RECENT_INTERVAL_MS.value).toBe("900000");
    expect(result.config.PROVIDER_RECONCILIATION_FULL_INTERVAL_MS.value).toBe("21600000");
    expect(result.config.PROVIDER_RECONCILIATION_RECENT_LIMIT.value).toBe("30");
    expect(result.config.PROVIDER_RECONCILIATION_RUN_FULL_ON_START.value).toBe("true");
    expect(result.config.ARR_DOWNLOADS_PATH.value).toBe("");
  });

  test("uses a non-empty runtime value before persisted .env", () => {
    expect(resolveRuntimeOrPersistedValue("runtime", "persisted")).toBe("runtime");
  });

  test("uses persisted .env when Docker supplied an empty placeholder", () => {
    expect(resolveRuntimeOrPersistedValue("", "persisted")).toBe("persisted");
    expect(resolveRuntimeOrPersistedValue(undefined, "persisted")).toBe("persisted");
  });

  test("returns an empty value when neither source is configured", () => {
    expect(resolveRuntimeOrPersistedValue("", "")).toBe("");
    expect(resolveRuntimeOrPersistedValue(undefined, undefined)).toBe("");
  });

  test("persists canonical Seerr keys and preserves an existing secret on partial save", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    process.chdir(tempDir);
    fs.writeFileSync(path.join(tempDir, ".env"), "SEERR_API_KEY=existing-secret\nTMDB_API_KEY=existing-tmdb\n");

    const result = saveConfigToFile({ SEERR_URL: "http://seerr:5055", SEERR_AUTH: "" });
    expect(result.success).toBe(true);

    const persisted = fs.readFileSync(path.join(tempDir, ".env"), "utf8");
    expect(persisted).toContain("SEERR_URL=http://seerr:5055");
    expect(persisted).toContain("SEERR_API_KEY=existing-secret");
    expect(persisted).not.toContain("OVERSEERR_URL");
    expect(getConfigWithSources().config.SEERR_URL.value).toBe("http://seerr:5055");
    expect(getConfigWithSources().config.SEERR_API_KEY.value).toBe("existing-secret");
    expect(getConfigWithSources().config.SEERR_API_KEY.locked).toBe(false);
    expect(getConfigWithSources().config.SEERR_API_KEY.provenance).toBe("PERSISTED_DOTENV");
  });

  test("persists a UI edit and keeps it editable after reload", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    const envPath = path.join(tempDir, ".env");
    process.chdir(tempDir);
    fs.writeFileSync(envPath, "JELLYFIN_API_KEY=old-secret\n");

    expect(saveConfigToFile({ JELLYFIN_API_KEY: "new-secret" }).success).toBe(true);
    const result = getConfigWithSources({ envPath, containerEnvKeys: new Set() });
    expect(result.config.JELLYFIN_API_KEY.value).toBe("new-secret");
    expect(result.config.JELLYFIN_API_KEY.source).toBe("file");
    expect(result.config.JELLYFIN_API_KEY.locked).toBe(false);
  });

  test("a real container value wins over persisted .env and remains locked", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "SEERR_API_KEY=persisted-secret\n");
    const previous = process.env.SEERR_API_KEY;
    process.env.SEERR_API_KEY = "container-secret";

    const result = getConfigWithSources({ envPath, containerEnvKeys: new Set(["SEERR_API_KEY"]) });
    expect(result.config.SEERR_API_KEY.value).toBe("container-secret");
    expect(result.config.SEERR_API_KEY.source).toBe("env");
    expect(result.config.SEERR_API_KEY.provenance).toBe("CONTAINER_ENV");
    expect(result.config.SEERR_API_KEY.locked).toBe(true);
    if (previous === undefined) delete process.env.SEERR_API_KEY;
    else process.env.SEERR_API_KEY = previous;
  });

  test("loads legacy AllDebrid and Premiumize provider keys", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "AD_API_KEY=legacy-ad\nPM_API_KEY=legacy-pm\nPM_WEBDAV_PASSWORD=legacy-pm-secret\n");

    const result = getConfigWithSources({ envPath, containerEnvKeys: new Set() });
    expect(result.config.ALLDEBRID_API_KEY.value).toBe("legacy-ad");
    expect(result.config.PREMIUMIZE_API_KEY.value).toBe("legacy-pm");
    expect(result.config.PREMIUMIZE_WEBDAV_PASSWORD.value).toBe("legacy-pm-secret");
    expect(result.config.ALLDEBRID_API_KEY.source).toBe("file");
    expect(result.config.PREMIUMIZE_API_KEY.locked).toBe(false);
  });

  test("canonical provider keys take precedence over legacy persisted keys", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "AD_API_KEY=legacy-ad\nALLDEBRID_API_KEY=canonical-ad\nPM_API_KEY=legacy-pm\nPREMIUMIZE_API_KEY=canonical-pm\n");

    const result = getConfigWithSources({ envPath, containerEnvKeys: new Set() });
    expect(result.config.ALLDEBRID_API_KEY.value).toBe("canonical-ad");
    expect(result.config.PREMIUMIZE_API_KEY.value).toBe("canonical-pm");
  });

  test("migrates provider credentials to canonical names when saving", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    process.chdir(tempDir);
    fs.writeFileSync(path.join(tempDir, ".env"), "AD_API_KEY=legacy-ad\nPM_API_KEY=legacy-pm\n");

    const result = saveConfigToFile({ ALLDEBRID_WEBDAV_URL: "https://dav.example" });
    expect(result.success).toBe(true);

    const persisted = fs.readFileSync(path.join(tempDir, ".env"), "utf8");
    expect(persisted).toContain("ALLDEBRID_API_KEY=legacy-ad");
    expect(persisted).toContain("PREMIUMIZE_API_KEY=legacy-pm");
    expect(persisted).toContain("ALLDEBRID_WEBDAV_URL=https://dav.example");
    expect(persisted).not.toContain("AD_API_KEY=");
    expect(persisted).not.toContain("PM_API_KEY=");
  });

  test("preserves legacy secrets during an unrelated partial save while canonicalizing them", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schrodrive-config-"));
    process.chdir(tempDir);
    fs.writeFileSync(path.join(tempDir, ".env"), "AD_WEBDAV_PASSWORD=legacy-ad-secret\nPM_WEBDAV_PASSWORD=legacy-pm-secret\n");

    const result = saveConfigToFile({ PORT: "8999" });
    expect(result.success).toBe(true);

    const persisted = fs.readFileSync(path.join(tempDir, ".env"), "utf8");
    expect(persisted).toContain("ALLDEBRID_WEBDAV_PASSWORD=legacy-ad-secret");
    expect(persisted).toContain("PREMIUMIZE_WEBDAV_PASSWORD=legacy-pm-secret");
    expect(persisted).toContain("PORT=8999");
    expect(persisted).not.toContain("AD_WEBDAV_PASSWORD=");
    expect(persisted).not.toContain("PM_WEBDAV_PASSWORD=");
  });
});
