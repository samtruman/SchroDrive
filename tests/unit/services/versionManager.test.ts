import { describe, expect, test } from "bun:test";
import type { TorrentInfo } from "../../../src/providers";
import { evaluateRule, evaluateVersionGroups, fingerprintTorrent, validateRule, validateScoringRules, versionManagerPolicyHash, type VersionManagerPolicy, type VersionProfile } from "../../../src/services/versionManager";
import { applyManualIdentityOverrides, clearManualIdentityOverride, saveManualIdentityOverride } from "../../../src/services/manualIdentity";

const profile = (overrides: Partial<VersionProfile> = {}): VersionProfile => ({
  id: "primary", name: "PRIMARY", enabled: true, target: "QUALITY", preferredResolution: "2160p",
  languagePolicy: { required: { values: ["ita"], mode: "ALL" }, preferred: [], original: false },
  sourceOrder: ["REMUX", "WEB-DL"], codecOrder: ["HEVC", "H264"], audioOrder: ["TRUEHD", "DDP"], ...overrides,
});
const remotePolicy: VersionManagerPolicy = { enableRemote: true, acquireMissingRemote: false };

function torrent(name: string, size: number): TorrentInfo {
  return { id: name, name, status: "finished", progress: 100, bytes: size, files: [{ id: "0", name, path: name, size, selected: true }] };
}

describe("version manager", () => {
  test("hashes the complete decision configuration deterministically", () => {
    const base = profile({
      priority: 10,
      hardRequirements: { op: "AND", children: [
        { op: "COMPARE", field: "resolution", operator: "eq", value: "2160p" },
        { op: "IN", field: "source", values: ["REMUX", "WEB-DL"] },
      ] },
      scoringRules: [{ op: "COMPARE", field: "resolution", operator: "equals", value: "2160p", weight: 100 }],
      languagePolicy: { required: { values: ["ENG", "ITA"], mode: "ALL" }, preferred: ["ita"], original: true, scope: "AUDIO" },
    });
    const policy: VersionManagerPolicy = { enableRemote: false, acquireMissingRemote: false, policyVersion: "1" };
    const sameSemantics = { ...base, name: "Renamed", description: "UI-only" };
    expect(versionManagerPolicyHash(policy, [base])).toBe(versionManagerPolicyHash(policy, [sameSemantics]));
    expect(versionManagerPolicyHash(policy, [base])).toBe(versionManagerPolicyHash(policy, [{ ...base, hardRequirements: { op: "AND", children: [...(base.hardRequirements as any).children].reverse() } as any, scoringRules: [...base.scoringRules!].reverse(), languagePolicy: { ...base.languagePolicy, required: { ...base.languagePolicy.required, values: ["ita", "eng"] } } }]));
    expect(versionManagerPolicyHash(policy, [base])).not.toBe(versionManagerPolicyHash(policy, [{ ...base, scoringRules: [{ ...base.scoringRules![0], weight: 1 }] }]));
    expect(versionManagerPolicyHash(policy, [base])).not.toBe(versionManagerPolicyHash(policy, [{ ...base, scoringRules: [{ ...base.scoringRules![0], field: "source" }] }]));
    expect(versionManagerPolicyHash(policy, [base])).not.toBe(versionManagerPolicyHash(policy, [{ ...base, enabled: false }]));
    expect(versionManagerPolicyHash(policy, [base])).not.toBe(versionManagerPolicyHash(policy, [{ ...base, priority: 11 }]));
    expect(versionManagerPolicyHash(policy, [base])).not.toBe(versionManagerPolicyHash(policy, [{ ...base, hardRequirements: { op: "COMPARE", field: "hdr", operator: "equals", value: true } }]));
    expect(versionManagerPolicyHash(policy, [base])).not.toBe(versionManagerPolicyHash(policy, [{ ...base, languagePolicy: { ...base.languagePolicy, required: { values: ["ita"], mode: "ANY" } } }]));
    expect(versionManagerPolicyHash(policy, [base])).not.toBe(versionManagerPolicyHash({ ...policy, enableRemote: true }, [base]));
    expect(versionManagerPolicyHash(policy, [base])).not.toBe(versionManagerPolicyHash({ ...policy, safety: { ...policy.safety, requireRecoverableBeforeDelete: false } }, [base]));
    expect(versionManagerPolicyHash(policy, [base])).toBe(versionManagerPolicyHash({ ...policy, policyVersion: "999" }, [base]));
  });

  test("normalizes provider/file data into a fingerprint without probing or deleting", () => {
    const [version] = fingerprintTorrent(torrent("Example.Movie.2025.2160p.REMUX.ITA.ENG.TRUEHD.Atmos.mkv", 75_000_000_000), "alldebrid");
    expect(version.id).toBe("alldebrid:Example.Movie.2025.2160p.REMUX.ITA.ENG.TRUEHD.Atmos.mkv:0");
    expect(version.fingerprint.identity.title).toBe("Example Movie");
    expect(version.fingerprint.identity.year).toBe(2025);
    expect(version.fingerprint.video.resolution).toBe("2160p");
    expect(version.fingerprint.release.source).toBe("REMUX");
    expect(version.fingerprint.audio[0].language).toBe("ita");
    expect(version.fingerprint.probe.status).toBe("not_requested");
  });

  test("uses a single media file inside an extensionless provider item", () => {
    const item = torrent("Movie.Release", 10_000);
    item.files = [{ id: "movie", name: "Movie.Release.2025.2160p.WEB-DL.mkv", path: "Movie.Release/Movie.Release.2025.2160p.WEB-DL.mkv", size: 10_000, selected: true }];
    const versions = fingerprintTorrent(item, "alldebrid");
    expect(versions).toHaveLength(1);
    expect(versions[0].fingerprint.storage.torrentId).toBe(item.id);
    expect(versions[0].fingerprint.storage.path).toContain("Movie.Release.2025");
  });

  test("ignores folders, samples, artwork and subtitles while fingerprinting packs", () => {
    const item = torrent("Season.Pack", 20_000);
    item.files = [
      { id: "e1", name: "Show.S01E01.1080p.mkv", path: "Season/Show.S01E01.1080p.mkv", size: 10_000, selected: true },
      { id: "e2", name: "Show.S01E02.1080p.mp4", path: "Season/Show.S01E02.1080p.mp4", size: 9_000, selected: true },
      { id: "sample", name: "sample.mkv", path: "Season/sample/sample.mkv", size: 1, selected: true },
      { id: "poster", name: "poster.jpg", path: "Season/poster.jpg", size: 1, selected: true },
      { id: "sub", name: "Show.S01E01.eng.srt", path: "Season/Show.S01E01.eng.srt", size: 1, selected: true },
    ];
    const versions = fingerprintTorrent(item, "alldebrid");
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.fingerprint.storage.fileId)).toEqual(["e1", "e2"]);
  });

  test("does not fabricate a fingerprint for an extensionless item without a file tree", () => {
    expect(fingerprintTorrent(torrent("Movie.Release", 10_000), "alldebrid")).toHaveLength(0);
  });

  test("keeps separate profile winners for quality and remote objectives", () => {
    const quality = profile();
    const remote = profile({ id: "remote", name: "REMOTE", target: "DIRECT_PLAY", preferredResolution: "1080p", sourceOrder: ["WEB-DL", "REMUX"], codecOrder: ["H264", "HEVC"] });
    const versions = [
      ...fingerprintTorrent(torrent("Example.Movie.2025.2160p.REMUX.ITA.ENG.TRUEHD.mkv", 75_000_000_000), "alldebrid"),
      ...fingerprintTorrent(torrent("Example.Movie.2025.1080p.WEB-DL.ITA.DDP.mkv", 9_000_000_000), "alldebrid"),
    ];
    const [group] = evaluateVersionGroups(versions, [quality, remote], remotePolicy);
    expect(group.versions.filter((version) => version.decision === "KEEP")).toHaveLength(2);
    expect(group.versions.some((version) => version.evaluations.some((evaluation) => evaluation.profileId === "remote" && evaluation.eligible))).toBe(true);
  });

  test("does not assign automatic deletion when identity confidence is low", () => {
    const [version] = fingerprintTorrent(torrent("unknown-release.mkv", 1_000), "alldebrid");
    const [group] = evaluateVersionGroups(version ? [version] : [], [profile({ languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false } })]);
    expect(group.versions[0].decision).toBe("REVIEW");
    expect(group.versions[0].reasons[0].code).toBe("identity_uncertain");
  });

  test("keeps all required languages and reviews hard-requirement failures", () => {
    const versions = fingerprintTorrent(torrent("Example.Movie.2025.2160p.WEB-DL.ENG.mkv", 10_000), "alldebrid");
    const [group] = evaluateVersionGroups(versions, [profile()]);
    expect(group.versions[0].fingerprint.audio.map((stream) => stream.language)).toEqual(["eng"]);
    expect(group.versions[0].decision).toBe("REVIEW");
    expect(group.versions[0].reasons.some((reason) => reason.code === "hard_requirement_failed")).toBe(true);
  });

  test("validates and evaluates nested AND/OR/NOT rules", () => {
    const [version] = fingerprintTorrent(torrent("Example.Movie.2025.2160p.WEB-DL.ITA.mkv", 10_000), "alldebrid");
    const rule = validateRule({ op: "AND", children: [
      { op: "HAS", field: "audioLanguage", value: "ita" },
      { op: "OR", children: [{ op: "COMPARE", field: "resolution", operator: "eq", value: "2160p" }, { op: "NOT", child: { op: "COMPARE", field: "source", operator: "eq", value: "REMUX" } }] },
    ] });
    expect(evaluateRule(rule, version)).toBe(true);
    expect(() => validateRule({ op: "COMPARE", field: "unknown", operator: "eq", value: 1 })).toThrow();
  });

  test("does not create a REMOTE slot when the optional policy is disabled", () => {
    const quality = profile();
    const remote = profile({ id: "remote", name: "REMOTE", target: "DIRECT_PLAY", preferredResolution: "1080p" });
    const versions = [
      ...fingerprintTorrent(torrent("Example.Movie.2025.2160p.REMUX.ITA.mkv", 75_000_000_000), "alldebrid"),
      ...fingerprintTorrent(torrent("Example.Movie.2025.1080p.WEB-DL.ITA.mkv", 9_000_000_000), "alldebrid"),
    ];
    const [group] = evaluateVersionGroups(versions, [quality, remote]);
    expect(group.remote).toBeUndefined();
    expect(group.versions.filter((version) => version.decision === "KEEP")).toHaveLength(1);
  });

  test("requires verified 1080p for REMOTE and reports missing remote without acquisition", () => {
    const quality = profile();
    const remote = profile({ id: "remote", name: "REMOTE", target: "DIRECT_PLAY", preferredResolution: "1080p" });
    const versions = fingerprintTorrent(torrent("Example.Movie.2025.2160p.REMUX.ITA.mkv", 75_000_000_000), "alldebrid");
    const [group] = evaluateVersionGroups(versions, [quality, remote], remotePolicy);
    expect(group.remote?.status).toBe("REMOTE_MISSING");
    expect(group.remote?.acquisition).toBeUndefined();
    expect(group.versions[0].evaluations.find((evaluation) => evaluation.profileId === "remote")?.eligible).toBe(false);
    expect(group.versions[0].evaluations.find((evaluation) => evaluation.profileId === "remote")?.reasons.some((reason) => reason.code === "remote_requires_1080p")).toBe(true);
  });

  test("can create acquisition intent only for a certain identity with an ID", () => {
    const quality = profile();
    const remote = profile({ id: "remote", name: "REMOTE", target: "DIRECT_PLAY", preferredResolution: "1080p" });
    const [version] = fingerprintTorrent(torrent("Example.Movie.2025.2160p.REMUX.ITA.mkv", 75_000_000_000), "alldebrid");
    version.fingerprint.identity.tmdbId = "123";
    const [group] = evaluateVersionGroups([version], [quality, remote], { enableRemote: true, acquireMissingRemote: true });
    expect(group.remote?.acquisition?.status).toBe("ACQUISITION_NEEDED");
    expect(group.remote?.acquisition?.requirement).toBe("1080p");
  });

  test("uses profile targets rather than reserved ids for future quality slots", () => {
    const quality = profile({ id: "quality-v2", name: "Cinema quality" });
    const remote = profile({ id: "remote-v2", name: "Remote", target: "DIRECT_PLAY", preferredResolution: "1080p" });
    const [version] = fingerprintTorrent(torrent("Example.Movie.2025.2160p.REMUX.ITA.mkv", 75_000_000_000), "alldebrid");
    version.fingerprint.identity.tmdbId = "123";
    const [group] = evaluateVersionGroups([version], [quality, remote], remotePolicy);
    expect(group.remote?.status).toBe("REMOTE_MISSING");
  });

  test("keeps audio and subtitle requirements distinct and supports extended operators", () => {
    const [version] = fingerprintTorrent(torrent("Example.Movie.2025.1080p.WEB-DL.ITA.mkv", 10_000), "alldebrid");
    version.fingerprint.subtitles = [{ language: "eng" }];
    const audioRule = validateRule({ op: "COMPARE", field: "audioLanguage", operator: "contains", value: "ita" });
    const subtitleRule = validateRule({ op: "COMPARE", field: "subtitleLanguage", operator: "contains", value: "eng" });
    expect(evaluateRule(audioRule, version)).toBe(true);
    expect(evaluateRule(subtitleRule, version)).toBe(true);
    const audioPolicy = profile({ languagePolicy: { required: { values: ["eng"], mode: "ALL" }, preferred: [], original: false, scope: "AUDIO" } });
    const subtitlePolicy = profile({ languagePolicy: { required: { values: ["eng"], mode: "ALL" }, preferred: [], original: false, scope: "SUBTITLE" } });
    expect(evaluateVersionGroups([version], [audioPolicy])[0].versions[0].decision).toBe("REVIEW");
    expect(evaluateVersionGroups([version], [subtitlePolicy])[0].versions[0].decision).toBe("KEEP");
  });

  test("does not let a hard requirement failure be compensated by scoring", () => {
    const [version] = fingerprintTorrent(torrent("Example.Movie.2025.2160p.WEB-DL.ITA.mkv", 10_000), "alldebrid");
    const configured = profile({ scoring: { resolution: 10000 }, hardRequirements: { op: "COMPARE", field: "resolution", operator: "equals", value: "1080p" } });
    const evaluation = evaluateVersionGroups([version], [configured])[0].versions[0];
    expect(evaluation.decision).toBe("REVIEW");
    expect(evaluation.evaluations[0].score).toBeUndefined();
  });

  test("validates and evaluates structured scoring field/operator/value/weight rules", () => {
    const [version] = fingerprintTorrent(torrent("Example.Movie.2025.2160p.WEB-DL.ITA.mkv", 10_000), "alldebrid");
    const scoringRules = validateScoringRules([
      { op: "COMPARE", field: "resolution", operator: "equals", value: "2160p", weight: 100 },
      { op: "HAS", field: "hdr", value: false, weight: -10 },
    ]);
    const evaluation = evaluateVersionGroups([version], [profile({ scoringRules })])[0].versions[0].evaluations[0];
    expect(evaluation.breakdown["rule:0"]).toBe(100);
    expect(evaluation.breakdown["rule:1"]).toBe(-10);
    expect(() => validateScoringRules([{ field: "resolution", operator: "equals", value: "2160p", weight: "not-a-number" }])).toThrow();
  });

  test("requires recoverability before DELETE_CANDIDATE", () => {
    const first = fingerprintTorrent(torrent("Example.Movie.2025.2160p.REMUX.ITA.mkv", 10_000), "alldebrid")[0];
    const second = fingerprintTorrent(torrent("Example.Movie.2025.1080p.WEB-DL.ITA.mkv", 8_000), "alldebrid")[0];
    first.fingerprint.storage.infoHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const group = evaluateVersionGroups([first, second], [profile()], { enableRemote: false, acquireMissingRemote: false })[0];
    expect(group.versions.some((version) => version.decision === "DELETE_CANDIDATE")).toBe(false);
    expect(group.versions.find((version) => version.fingerprint.storage.infoHash)?.reasons.some((reason) => reason.code.startsWith("recoverability_"))).toBe(false);
    expect(group.versions.some((version) => version.reasons.some((reason) => reason.code === "recoverability_unknown"))).toBe(true);
  });

  test("distinguishes known non-recoverable from unknown while keeping both fail-closed", () => {
    const winner = fingerprintTorrent(torrent("Known.2024.2160p.REMUX.mkv", 20_000), "alldebrid")[0];
    const known = fingerprintTorrent(torrent("Known.2024.1080p.WEB-DL.mkv", 10_000), "alldebrid")[0];
    const unknown = fingerprintTorrent(torrent("Known.2024.720p.WEB-DL.mkv", 8_000), "alldebrid")[0];
    winner.fingerprint.storage.infoHash = "b".repeat(40);
    known.fingerprint.storage.recoverability = { status: "NOT_RECOVERABLE", source: "PROVIDER_CAPABILITY", reason: "fixture" };
    const group = evaluateVersionGroups([winner, known, unknown], [profile({ languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false } })])[0];
    expect(group.versions.some((version) => version.reasons.some((reason) => reason.code === "recoverability_required"))).toBe(true);
    expect(group.versions.some((version) => version.reasons.some((reason) => reason.code === "recoverability_unknown"))).toBe(true);
    expect(group.versions.some((version) => version.decision === "DELETE_CANDIDATE")).toBe(false);
  });

  test("records profile ownership when one version wins multiple profiles", () => {
    const primary = profile({ languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false } });
    const remote = profile({ id: "remote", name: "REMOTE", target: "DIRECT_PLAY", preferredResolution: "1080p", languagePolicy: { required: { values: [], mode: "ALL" }, preferred: [], original: false } });
    const [group] = evaluateVersionGroups(fingerprintTorrent(torrent("Example.Movie.2025.1080p.WEB-DL.ITA.mkv", 10_000), "alldebrid"), [primary, remote], remotePolicy);
    const kept = group.versions.find((version) => version.decision === "KEEP");
    expect(kept?.satisfiesProfiles).toEqual(["primary", "remote"]);
  });

  test("applies the exact manual TMDb identity before grouping and preserves safety blockers", () => {
    const versions = fingerprintTorrent(torrent("Ambiguous.Release.2024.1080p.WEB-DL.ITA.mkv", 10_000), "alldebrid");
    const original = versions[0].fingerprint.identity;
    saveManualIdentityOverride(original, { tmdbId: "4242", title: "Canonical Film", originalTitle: "Canonical Original", year: 2024, kind: "movie", originalLanguage: "ita" });
    const applied = applyManualIdentityOverrides(versions);
    expect(applied[0].fingerprint.identity.tmdbId).toBe("4242");
    expect(applied[0].fingerprint.identity.title).toBe("Canonical Film");
    expect(applied[0].fingerprint.identity.originalTitle).toBe("Canonical Original");
    expect(applied[0].fingerprint.identity.source).toBe("manual");
    expect(applied[0].fingerprint.identity.provenance?.tmdbId).toBe("MANUAL");
    clearManualIdentityOverride(original);
  });
});
