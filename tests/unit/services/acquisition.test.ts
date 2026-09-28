import { describe, expect, test } from "bun:test";
import { deriveAcquisitionNeeds, deduplicateAcquisitionNeeds, revalidateAcquisitionNeed } from "../../../src/services/acquisition";
import { evaluateVersionGroups, fingerprintTorrent, type VersionProfile } from "../../../src/services/versionManager";
import { SeerrAcquisitionAdapter } from "../../../src/services/seerrAcquisitionAdapter";
import { seerrApiBaseUrl } from "../../../src/services/seerrUrl";

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

  test("does not enable or send requests in this milestone", async () => {
    const adapter = new SeerrAcquisitionAdapter();
    expect((await adapter.capabilities()).canRequest).toBe(false);
    await expect(adapter.request({} as any)).rejects.toThrow("disabled");
  });
});
