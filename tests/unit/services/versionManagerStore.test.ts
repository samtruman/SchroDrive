import { describe, expect, test } from "bun:test";
import { createVersionManagerScanJob, getLatestVersionManagerSnapshot, getVersionProfiles, getVersionManagerPolicy, getVersionManagerScanJob, recoverInterruptedVersionManagerScanJobs, saveVersionManagerPolicy, saveVersionManagerSnapshot, saveVersionProfiles } from "../../../src/services/versionManagerStore";
import { defaultVersionManagerPolicy, versionManagerPolicyHash, type VersionProfile } from "../../../src/services/versionManager";

describe("version manager policy persistence", () => {
  test("round-trips structured hard rules and scoring rules without losing ownership", () => {
    const profile: VersionProfile = {
      id: "fixture-profile",
      name: "Fixture",
      enabled: true,
      target: "QUALITY",
      preferredResolution: "2160p",
      languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false },
      sourceOrder: ["REMUX"],
      codecOrder: ["HEVC"],
      audioOrder: ["TRUEHD"],
      hardRequirements: { op: "AND", children: [{ op: "OR", children: [{ op: "COMPARE", field: "resolution", operator: "equals", value: "2160p" }, { op: "HAS", field: "hdr", value: true }] }] },
      scoringRules: [{ op: "COMPARE", field: "source", operator: "equals", value: "REMUX", weight: 30 }, { op: "IN", field: "codec", values: ["HEVC", "AV1"], weight: 10 }],
    };
    saveVersionProfiles([profile]);
    const reloaded = getVersionProfiles();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe("fixture-profile");
    expect(reloaded[0].hardRequirements).toEqual(profile.hardRequirements);
    expect(reloaded[0].scoringRules).toEqual(profile.scoringRules);
    expect(versionManagerPolicyHash(defaultVersionManagerPolicy, [profile])).toBe(versionManagerPolicyHash(defaultVersionManagerPolicy, reloaded));
  });

  test("persists a valid snapshot atomically and recovers interrupted jobs", () => {
    saveVersionManagerSnapshot([], [], { policyHash: "fixture-hash", status: "VALID" });
    expect(getLatestVersionManagerSnapshot()?.status).toBe("VALID");
    const job = createVersionManagerScanJob();
    recoverInterruptedVersionManagerScanJobs();
    expect(getVersionManagerScanJob(job.id)?.status).toBe("FAILED");
  });

  test("keeps mirrored releases isolated by managed provider", () => {
    const sharedInfohash = "0123456789abcdef0123456789abcdef01234567";
    const groupFor = (provider: string, torrentId: string) => [{
      id: `movie:934866:${provider}`,
      identity: { kind: "movie", title: "Bad Genius", year: 2024, tmdbId: "934866", confidence: 1 },
      versions: [{
        id: `${provider}:${torrentId}:bad-genius.mkv`,
        fingerprint: {
          identity: { kind: "movie", title: "Bad Genius", year: 2024, tmdbId: "934866", confidence: 1 },
          storage: { provider, torrentId, path: "Bad Genius (2024).mkv", size: 2_903_300_815, infohash: sharedInfohash },
        },
        decision: "KEEP",
        reasons: [],
        evaluations: [],
      }],
    }] as any;

    saveVersionManagerSnapshot(groupFor("alldebrid", "642340852"), [], { providerId: "alldebrid", policyHash: "ad", status: "VALID" });
    saveVersionManagerSnapshot(groupFor("realdebrid", "A6TNSNV6ND33Q"), [], { providerId: "realdebrid", policyHash: "rd", status: "VALID" });

    const alldebrid = getLatestVersionManagerSnapshot("alldebrid");
    const realdebrid = getLatestVersionManagerSnapshot("realdebrid");
    expect(alldebrid?.providerId).toBe("alldebrid");
    expect(alldebrid?.groups[0].versions).toHaveLength(1);
    expect(alldebrid?.groups[0].versions[0].fingerprint.storage.provider).toBe("alldebrid");
    expect(realdebrid?.providerId).toBe("realdebrid");
    expect(realdebrid?.groups[0].versions).toHaveLength(1);
    expect(realdebrid?.groups[0].versions[0].fingerprint.storage.provider).toBe("realdebrid");
  });

  test("persists retention preferences used by delete impact evaluation", () => {
    const original = getVersionManagerPolicy();
    try {
      saveVersionManagerPolicy({ ...original, preferCompletePack: true });
      expect(getVersionManagerPolicy().preferCompletePack).toBe(true);
    } finally {
      saveVersionManagerPolicy(original);
    }
  });

  test("persists the delete dry-run safety gate", () => {
    const original = getVersionManagerPolicy();
    try {
      saveVersionManagerPolicy({ ...original, safety: { ...original.safety!, deleteDryRun: false } });
      expect(getVersionManagerPolicy().safety?.deleteDryRun).toBe(false);
    } finally {
      saveVersionManagerPolicy(original);
    }
  });
});
