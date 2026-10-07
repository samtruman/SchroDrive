import { afterEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../src/core/db";
import { applyManualIdentityOverride, applyManualIdentityOverrides, clearManualIdentityOverride, clearManualIdentityOverrideForVersion, saveManualIdentityOverride, saveManualIdentityOverrideForVersion } from "../../../src/services/manualIdentity";
import { evaluateVersionGroups, fingerprintTorrent, type ContentIdentity } from "../../../src/services/versionManager";

function version(name: string, size: number) {
  return fingerprintTorrent({ id: name, name, status: "finished", progress: 100, bytes: size, files: [{ id: "file", name, path: name, size, selected: true }] }, "alldebrid")[0];
}

afterEach(() => {
  getDb().exec("DELETE FROM version_manager_identity_overrides");
});

describe("manual identity overrides", () => {
  test("uses the selected TMDb identity exactly and preserves automatic provenance", () => {
    const identity = version("Ambiguous.Title.2024.1080p.WEB-DL.ITA.mkv", 10_000).fingerprint.identity;
    saveManualIdentityOverride(identity, { tmdbId: "4242", title: "Canonical Film", originalTitle: "Original Film", year: 2024, kind: "movie", originalLanguage: "ita" });
    const applied = applyManualIdentityOverrides([version("Ambiguous.Title.2024.1080p.WEB-DL.ITA.mkv", 10_000)])[0].fingerprint.identity;
    expect(applied.tmdbId).toBe("4242");
    expect(applied.title).toBe("Canonical Film");
    expect(applied.originalTitle).toBe("Original Film");
    expect(applied.source).toBe("manual");
    expect(applied.provenance?.tmdbId).toBe("MANUAL");
  });

  test("clear restores automatic identity lookup without deleting automatic evidence", () => {
    const identity = version("Legacy.Title.2024.1080p.WEB-DL.mkv", 10_000).fingerprint.identity;
    saveManualIdentityOverride(identity, { tmdbId: "99", title: "Manual Title", kind: "movie" });
    expect(applyManualIdentityOverrides([version("Legacy.Title.2024.1080p.WEB-DL.mkv", 10_000)])[0].fingerprint.identity.tmdbId).toBe("99");
    clearManualIdentityOverride({ ...identity, tmdbId: "99", title: "Manual Title" });
    const restored = applyManualIdentityOverrides([version("Legacy.Title.2024.1080p.WEB-DL.mkv", 10_000)])[0].fingerprint.identity;
    expect(restored.tmdbId).toBeUndefined();
    expect(restored.title).toBe("Legacy Title");
  });

  test("manual identity changes grouping but does not bypass recoverability safety", () => {
    const keep = version("Unknown.Title.2024.2160p.REMUX.mkv", 20_000);
    const candidate = version("Unknown.Title.2024.1080p.WEB-DL.mkv", 10_000);
    keep.fingerprint.storage.infoHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const before = keep.fingerprint.identity;
    saveManualIdentityOverride(before, { tmdbId: "7", title: "Resolved Title", kind: "movie" });
    const evaluated = evaluateVersionGroups(applyManualIdentityOverrides([keep, candidate]));
    const group = evaluated.find((item) => item.identity.tmdbId === "7");
    expect(group).toBeDefined();
    expect(group!.versions.some((item) => item.reasons.some((reason) => reason.code === "recoverability_unknown"))).toBe(true);
    expect(group!.versions.find((item) => item.fingerprint.storage.infoHash === undefined)?.decision).toBe("REVIEW");
  });

  test("targets unresolved media by version ID without changing every unknown item", () => {
    const first = version("1917.(2019).4K.HDR.DV.mkv", 20_000);
    const second = version("Other.Unresolved.File.mkv", 10_000);
    first.fingerprint.identity = { kind: "unknown", confidence: 0, source: "unknown" };
    second.fingerprint.identity = { kind: "unknown", confidence: 0, source: "unknown" };
    saveManualIdentityOverrideForVersion(first.id, { tmdbId: "530915", title: "1917", year: 2019, kind: "movie" });
    const applied = applyManualIdentityOverrides([first, second]);
    expect(applied[0].fingerprint.identity).toMatchObject({ tmdbId: "530915", title: "1917", source: "manual" });
    expect(applied[1].fingerprint.identity.tmdbId).toBeUndefined();
    clearManualIdentityOverrideForVersion(first.id);
    expect(applyManualIdentityOverrides([first])[0].fingerprint.identity.tmdbId).toBeUndefined();
  });

  test("legacy identity override without TMDb ID remains a valid compatibility path", () => {
    const identity: ContentIdentity = { title: "Legacy", normalizedTitle: "legacy", year: 2024, kind: "movie", confidence: 0.4, source: "unknown" };
    const applied = applyManualIdentityOverride(identity, { title: "Legacy Match", year: 2024, kind: "movie" });
    expect(applied.tmdbId).toBeUndefined();
    expect(applied.title).toBe("Legacy Match");
    expect(applied.source).toBe("manual");
  });
});
