import { describe, expect, test } from "bun:test";
import { deriveAcquisitionNeeds, deduplicateAcquisitionNeeds, revalidateAcquisitionNeed } from "../../../src/services/acquisition";
import { evaluateVersionGroups, fingerprintTorrent, type VersionProfile } from "../../../src/services/versionManager";
import { SeerrAcquisitionAdapter } from "../../../src/services/seerrAcquisitionAdapter";
import { seerrApiBaseUrl } from "../../../src/services/seerrUrl";
import axios from "axios";
import { config } from "../../../src/core/config";

const torrent = (name: string) => ({ id: name, name, status: "completed", progress: 100, bytes: 1_000_000, files: [{ id: "f", name, path: name, size: 1_000_000, selected: true }] });
const profile = (overrides: Partial<VersionProfile> = {}): VersionProfile => ({
  id: "remote-custom", name: "Compact Remote", enabled: true, target: "DIRECT_PLAY", preferredResolution: "1080p",
  languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false },
  sourceOrder: ["WEB-DL"], codecOrder: ["H264"], audioOrder: ["AAC"], ...overrides,
});

describe("generic acquisition core", () => {
  test("creates a missing need for an enabled custom profile, not for a disabled profile", () => {
    const versions = fingerprintTorrent(torrent("Example.2025.2160p.WEB-DL.H265.mkv"), "test");
    versions[0].fingerprint.identity = { ...versions[0].fingerprint.identity, tmdbId: "123", resolutionStatus: "resolved", confidence: 1 };
    const [group] = evaluateVersionGroups(versions, [profile()], { enableRemote: true, acquireMissingRemote: false });
    const needs = deriveAcquisitionNeeds([group], [profile()]);
    expect(needs).toHaveLength(1);
    expect(needs[0].status).toBe("ACQUISITION_ELIGIBLE");
    expect(deriveAcquisitionNeeds([group], [{ ...profile(), enabled: false }])).toHaveLength(0);
  });

  test("blocks fallback, uncertain, conflict and missing IDs", () => {
    const statuses = ["fallback", "uncertain", "conflict"] as const;
    for (const resolutionStatus of statuses) {
      const versions = fingerprintTorrent(torrent(`Example.${resolutionStatus}.2025.2160p.mkv`), "test");
      versions[0].fingerprint.identity = { ...versions[0].fingerprint.identity, tmdbId: "123", resolutionStatus, confidence: 0.5, conflicts: resolutionStatus === "conflict" ? [{ code: "CROSS_PROVIDER_DISAGREEMENT", field: "tmdbId", values: [] }] : undefined };
      const [group] = evaluateVersionGroups(versions, [profile()], { enableRemote: true, acquireMissingRemote: false });
      const [need] = deriveAcquisitionNeeds([group], [profile()]);
      expect(need.status).toBe("ACQUISITION_BLOCKED");
    }
  });

  test("revalidation turns a stale missing need into profile satisfied", () => {
    const oldVersions = fingerprintTorrent(torrent("Example.2025.2160p.WEB-DL.H265.mkv"), "test");
    oldVersions[0].fingerprint.identity = { ...oldVersions[0].fingerprint.identity, tmdbId: "123", resolutionStatus: "resolved", confidence: 1 };
    const oldGroup = evaluateVersionGroups(oldVersions, [profile()], { enableRemote: true })[0];
    const [need] = deriveAcquisitionNeeds([oldGroup], [profile()]);
    const newVersions = [...oldVersions, ...fingerprintTorrent(torrent("Example.2025.1080p.WEB-DL.H264.mkv"), "test")];
    newVersions[1].fingerprint.identity = { ...newVersions[1].fingerprint.identity, tmdbId: "123", resolutionStatus: "resolved", confidence: 1 };
    const newGroup = evaluateVersionGroups(newVersions, [profile()], { enableRemote: true })[0];
    expect(revalidateAcquisitionNeed(need, [newGroup], [profile()]).status).toBe("PROFILE_SATISFIED");
  });

  test("deduplicates equivalent content/profile needs", () => {
    const versions = fingerprintTorrent(torrent("Example.2025.2160p.WEB-DL.H265.mkv"), "test");
    versions[0].fingerprint.identity = { ...versions[0].fingerprint.identity, tmdbId: "123", resolutionStatus: "resolved", confidence: 1 };
    const [group] = evaluateVersionGroups(versions, [profile()], { enableRemote: true });
    const [need] = deriveAcquisitionNeeds([group], [profile()]);
    expect(deduplicateAcquisitionNeeds([need, { ...need, id: `${need.id}:duplicate` }])).toHaveLength(1);
  });
});

describe("Seerr acquisition safety contract", () => {
  test("normalizes service-root and API-root URLs without duplicating /api/v1", () => {
    expect(seerrApiBaseUrl("http://seerr:5055")).toBe("http://seerr:5055/api/v1");
    expect(seerrApiBaseUrl("http://seerr:5055/api/v1")).toBe("http://seerr:5055/api/v1");
    expect(seerrApiBaseUrl("http://seerr:5055/api/v1/")).toBe("http://seerr:5055/api/v1");
  });

  test("keeps requests disabled unless explicitly enabled", async () => {
    const adapter = new SeerrAcquisitionAdapter();
    expect((await adapter.capabilities()).canRequest).toBe(false);
    await expect(adapter.request({} as any)).rejects.toThrow("disabled");
  });

  test("sends one revalidated movie request only when explicitly enabled", async () => {
    const adapter = new SeerrAcquisitionAdapter();
    const originalGet = axios.get;
    const originalPost = axios.post;
    const original = { overseerrUrl: config.overseerrUrl, overseerrApiKey: config.overseerrApiKey, overseerrAuth: config.overseerrAuth, acquisitionRequestsEnabled: config.acquisitionRequestsEnabled };
    config.overseerrUrl = "http://seerr.test";
    config.overseerrApiKey = "test-only";
    config.overseerrAuth = "";
    config.acquisitionRequestsEnabled = true;
    const need: any = { id: "need:movie:123:remote", status: "ACQUISITION_ELIGIBLE", acquisitionEligibility: { eligible: true }, contentIdentity: { tmdbId: "123" }, mediaType: "movie" };
    let posted: any;
    try {
      axios.get = (async () => ({ data: {} })) as typeof axios.get;
      axios.post = (async (_url: string, body: any) => { posted = body; return { data: { id: 77 } }; }) as typeof axios.post;
      const result = await adapter.request(need);
      expect(posted).toEqual({ mediaType: "movie", mediaId: 123 });
      expect(result).toEqual({ providerRequestId: "77", status: "REQUESTED", detail: "Single movie request accepted by Seerr" });
    } finally {
      axios.get = originalGet;
      axios.post = originalPost;
      Object.assign(config, original);
    }
  });

  test("blocks a duplicate request when Seerr already reports requested", async () => {
    const adapter = new SeerrAcquisitionAdapter();
    const originalGet = axios.get;
    const original = { overseerrUrl: config.overseerrUrl, overseerrApiKey: config.overseerrApiKey, overseerrAuth: config.overseerrAuth, acquisitionRequestsEnabled: config.acquisitionRequestsEnabled };
    config.overseerrUrl = "http://seerr.test";
    config.overseerrApiKey = "test-only";
    config.overseerrAuth = "";
    config.acquisitionRequestsEnabled = true;
    try {
      axios.get = (async () => ({ data: { status: "requested", request: { id: 77 } } })) as typeof axios.get;
      await expect(adapter.request({ status: "ACQUISITION_ELIGIBLE", acquisitionEligibility: { eligible: true }, contentIdentity: { tmdbId: "123" }, mediaType: "movie" } as any)).rejects.toThrow("REQUESTED");
    } finally {
      axios.get = originalGet;
      Object.assign(config, original);
    }
  });

  test("blocks when media status is empty but request lookup contains the same TMDb movie", async () => {
    const adapter = new SeerrAcquisitionAdapter();
    const originalGet = axios.get;
    const original = { overseerrUrl: config.overseerrUrl, overseerrApiKey: config.overseerrApiKey, overseerrAuth: config.overseerrAuth, acquisitionRequestsEnabled: config.acquisitionRequestsEnabled };
    config.overseerrUrl = "http://seerr.test";
    config.overseerrApiKey = "test-only";
    config.overseerrAuth = "";
    config.acquisitionRequestsEnabled = true;
    try {
      axios.get = (async (url: string) => url.endsWith("/request") ? ({ data: { results: [{ id: 94, status: 5, media: { mediaType: "movie", tmdbId: 1084244 } }] } }) : ({ data: {} })) as typeof axios.get;
      const result = await adapter.status({ contentIdentity: { tmdbId: "1084244" }, mediaType: "movie" } as any);
      expect(result.status).toBe("REQUESTED");
      expect(result.providerRequestId).toBe("94");
    } finally {
      axios.get = originalGet;
      Object.assign(config, original);
    }
  });

  test("maps TV episode needs to an existing season request", async () => {
    const adapter = new SeerrAcquisitionAdapter();
    const originalGet = axios.get;
    const original = { overseerrUrl: config.overseerrUrl, overseerrApiKey: config.overseerrApiKey, overseerrAuth: config.overseerrAuth };
    config.overseerrUrl = "http://seerr.test";
    config.overseerrApiKey = "test-only";
    config.overseerrAuth = "";
    try {
      axios.get = (async (url: string) => url.endsWith("/request") ? ({ data: { results: [{ id: 12, status: "approved", media: { mediaType: "tv", tmdbId: 999, seasons: [{ seasonNumber: 2 }] } }] } }) : ({ data: {} })) as typeof axios.get;
      const result = await adapter.status({ contentIdentity: { tmdbId: "999" }, mediaType: "tv", season: 2, episode: 3 } as any);
      expect(result.status).toBe("REQUESTED");
      expect(result.providerRequestId).toBe("12");
    } finally {
      axios.get = originalGet;
      Object.assign(config, original);
    }
  });

  test("maps Seerr read-only media states without collapsing partial availability", async () => {
    const adapter = new SeerrAcquisitionAdapter();
    const originalGet = axios.get;
    const original = { overseerrUrl: config.overseerrUrl, overseerrApiKey: config.overseerrApiKey, overseerrAuth: config.overseerrAuth };
    config.overseerrUrl = "http://seerr.test";
    config.overseerrApiKey = "test-only";
    config.overseerrAuth = "";
    const need: any = { contentIdentity: { tmdbId: "10" }, mediaType: "movie" };
    try {
      for (const [payload, expected] of [[{ status: "available" }, "AVAILABLE"], [{ status: "partially_available" }, "PARTIALLY_AVAILABLE"], [{ status: "requested" }, "REQUESTED"], [{ status: "pending" }, "PENDING"], [{ status: "processing" }, "PROCESSING"], [{}, "NOT_REQUESTED"], [{ status: "error" }, "ERROR"]] as const) {
        axios.get = (async () => ({ data: payload })) as typeof axios.get;
        expect((await adapter.status(need)).status).toBe(expected);
      }
      axios.get = (async () => { const error: any = new Error("server"); error.response = { status: 503 }; throw error; }) as typeof axios.get;
      expect((await adapter.status(need)).status).toBe("ERROR");
      axios.get = (async () => { const error: any = new Error("missing"); error.response = { status: 404 }; throw error; }) as typeof axios.get;
      expect((await adapter.status(need)).status).toBe("MEDIA_NOT_FOUND");
    } finally {
      axios.get = originalGet;
      Object.assign(config, original);
    }
  });
});
