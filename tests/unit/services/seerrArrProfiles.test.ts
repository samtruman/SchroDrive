import { afterEach, describe, expect, test } from "bun:test";
import axios from "axios";
import { config } from "../../../src/core/config";
import { discoverSeerrArrProfiles } from "../../../src/services/seerrArrProfiles";

describe("Seerr ARR quality-profile discovery", () => {
  const original = {
    url: config.overseerrUrl,
    key: config.overseerrApiKey,
    auth: config.overseerrAuth,
    get: axios.get,
  };

  afterEach(() => {
    config.overseerrUrl = original.url;
    config.overseerrApiKey = original.key;
    config.overseerrAuth = original.auth;
    axios.get = original.get;
  });

  test("reports an unconfigured Seerr gateway without making requests", async () => {
    config.overseerrUrl = "";
    config.overseerrApiKey = "";
    config.overseerrAuth = "";
    let calls = 0;
    axios.get = (async () => { calls += 1; return { data: [] }; }) as typeof axios.get;
    await expect(discoverSeerrArrProfiles()).resolves.toEqual({ source: "seerr", configured: false, profiles: [], errors: [] });
    expect(calls).toBe(0);
  });

  test("normalizes read-only Radarr and Sonarr profiles while preserving ownership", async () => {
    config.overseerrUrl = "http://seerr.fixture";
    config.overseerrApiKey = "fixture-key";
    config.overseerrAuth = "";
    axios.get = (async (url: string) => ({ data: url.endsWith("/radarr") ? { servers: [{ id: 1, name: "Radarr fixture", url: "http://radarr.fixture", profiles: [{ id: 7, name: "Movie HD" }] }] } : [{ id: "sonarr-1", name: "Sonarr fixture", qualityProfiles: [{ id: 9, name: "TV HD" }] }] })) as typeof axios.get;
    await expect(discoverSeerrArrProfiles()).resolves.toMatchObject({
      source: "seerr",
      configured: true,
      errors: [],
      profiles: [
        { kind: "radarr", serverId: "1", qualityProfileId: "7", qualityProfileName: "Movie HD" },
        { kind: "sonarr", serverId: "sonarr-1", qualityProfileId: "9", qualityProfileName: "TV HD" },
      ],
    });
  });

  test("keeps one ARR kind usable when the other is unavailable", async () => {
    config.overseerrUrl = "http://seerr.fixture";
    config.overseerrApiKey = "fixture-key";
    config.overseerrAuth = "";
    axios.get = (async (url: string) => {
      if (url.endsWith("/radarr")) return { data: [{ id: 1, name: "Radarr fixture", profiles: [{ id: 7, name: "Movie HD" }] }] };
      const error: any = new Error("fixture unavailable");
      error.response = { status: 503 };
      throw error;
    }) as typeof axios.get;
    const result = await discoverSeerrArrProfiles();
    expect(result.profiles).toHaveLength(1);
    expect(result.errors).toEqual([{ kind: "sonarr", code: "INVALID_RESPONSE", message: "Seerr sonarr discovery failed with HTTP 503" }]);
  });

  test("reads profiles through Seerr first and uses its declared ARR connection when a proxy route is absent", async () => {
    config.overseerrUrl = "http://seerr.fixture";
    config.overseerrApiKey = "fixture-key";
    config.overseerrAuth = "";
    axios.get = (async (url: string) => {
      if (url.endsWith("/settings/radarr")) return { data: [{ id: 0, name: "Radarr fixture", externalUrl: "http://radarr.fixture", apiKey: "arr-secret", profiles: [] }] };
      if (url.endsWith("/settings/sonarr")) return { data: [{ id: 0, name: "Sonarr fixture", externalUrl: "http://sonarr.fixture", apiKey: "arr-secret", profiles: [] }] };
      if (url.includes("/settings/radarr/0/profiles") || url.includes("/settings/sonarr/0/profiles")) { const error: any = new Error("not proxied"); error.response = { status: 404 }; throw error; }
      if (url === "http://radarr.fixture/api/v3/qualityprofile") return { data: [{ id: 5, name: "Movie 2160p" }] };
      if (url === "http://sonarr.fixture/api/v3/qualityprofile") return { data: [{ id: 6, name: "TV 1080p" }] };
      throw new Error(`Unexpected fixture URL: ${url}`);
    }) as typeof axios.get;
    const result = await discoverSeerrArrProfiles();
    expect(result.errors).toEqual([]);
    expect(result.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "radarr", qualityProfileId: "5", source: "arr-fallback" }),
      expect.objectContaining({ kind: "sonarr", qualityProfileId: "6", source: "arr-fallback" }),
    ]));
  });
});
