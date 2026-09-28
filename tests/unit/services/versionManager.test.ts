import { describe, expect, test } from "bun:test";
import type { TorrentInfo } from "../../../src/providers";
import { evaluateRule, evaluateVersionGroups, fingerprintTorrent, validateRule, type VersionProfile } from "../../../src/services/versionManager";

const profile = (overrides: Partial<VersionProfile> = {}): VersionProfile => ({
  id: "primary", name: "PRIMARY", enabled: true, target: "QUALITY", preferredResolution: "2160p",
  languagePolicy: { required: { values: ["ita"], mode: "ALL" }, preferred: [], original: false },
  sourceOrder: ["REMUX", "WEB-DL"], codecOrder: ["HEVC", "H264"], audioOrder: ["TRUEHD", "DDP"], ...overrides,
});

function torrent(name: string, size: number): TorrentInfo {
  return { id: name, name, status: "finished", progress: 100, bytes: size, files: [{ id: "0", name, path: name, size, selected: true }] };
}

describe("version manager", () => {
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

  test("keeps separate profile winners for quality and remote objectives", () => {
    const quality = profile();
    const remote = profile({ id: "remote", name: "REMOTE", target: "DIRECT_PLAY", preferredResolution: "1080p", sourceOrder: ["WEB-DL", "REMUX"], codecOrder: ["H264", "HEVC"] });
    const versions = [
      ...fingerprintTorrent(torrent("Example.Movie.2025.2160p.REMUX.ITA.ENG.TRUEHD.mkv", 75_000_000_000), "alldebrid"),
      ...fingerprintTorrent(torrent("Example.Movie.2025.1080p.WEB-DL.ITA.DDP.mkv", 9_000_000_000), "alldebrid"),
    ];
    const [group] = evaluateVersionGroups(versions, [quality, remote]);
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
});
