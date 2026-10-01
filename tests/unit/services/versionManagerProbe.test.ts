import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../../../src/core/config";
import { mergeCachedProbeFingerprint, resolveVersionProbePath } from "../../../src/services/versionManagerProbe";

const originalMountBase = config.mountBase;
const temporaryRoots: string[] = [];
afterEach(async () => {
  config.mountBase = originalMountBase;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("version manager probe cache", () => {
  test("keeps current parsed identity and storage while reusing technical stream data", () => {
    const current = {
      identity: {
        title: "Chernobyl",
        normalizedTitle: "chernobyl",
        kind: "episode",
        season: 1,
        episode: 1,
        confidence: 0.96,
        source: "filename",
        provenance: { title: "FILENAME", kind: "FILENAME", season: "FILENAME", episode: "FILENAME" },
      },
      video: { resolution: "1080p", codec: "HEVC" },
      audio: [{ language: "ita" }],
      subtitles: [],
      release: { source: "WEB-DL" },
      storage: { provider: "alldebrid", torrentId: "new", path: "new-path", size: 100 },
      probe: { status: "not_requested", tool: "filename" },
    } as any;
    const cached = {
      ...current,
      identity: {
        title: "Chernobyl 1x01 1-23-45",
        normalizedTitle: "chernobyl1x0112345",
        kind: "movie",
        year: 2019,
        confidence: 0.98,
        source: "filename",
        tmdbId: "87108",
        provenance: { title: "FILENAME", kind: "FILENAME", tmdbId: "FFPROBE" },
      },
      video: { resolution: "1080p", codec: "HEVC", bitrate: 3_000_000 },
      audio: [{ language: "ita", codec: "AC3", channels: 6 }],
      subtitles: [{ language: "eng", codec: "ass" }],
      storage: { provider: "alldebrid", torrentId: "old", path: "old-path", size: 100 },
      probe: { status: "complete", tool: "ffprobe" },
    } as any;

    const merged = mergeCachedProbeFingerprint(current, cached);

    expect(merged.identity).toMatchObject({ title: "Chernobyl", kind: "episode", season: 1, episode: 1, tmdbId: "87108" });
    expect(merged.storage).toEqual(current.storage);
    expect(merged.release).toEqual(current.release);
    expect(merged.video.bitrate).toBe(3_000_000);
    expect(merged.audio[0]).toMatchObject({ language: "ita", codec: "AC3", channels: 6 });
    expect(merged.subtitles[0]).toMatchObject({ language: "eng", codec: "ass" });
    expect(merged.probe).toEqual({ status: "complete", tool: "ffprobe" });
  });

  test("never resolves a provider file through another provider mount", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "schrodrive-provider-probe-"));
    temporaryRoots.push(root);
    config.mountBase = root;
    const filename = "Ghosted.2023.2160p.mkv";
    const allDebridFile = path.join(root, "alldebrid", "__all__", filename, filename);
    await mkdir(path.dirname(allDebridFile), { recursive: true });
    await writeFile(allDebridFile, "fixture");
    const realDebridFile = path.join(root, "realdebrid", "__all__", filename, filename);
    await mkdir(path.dirname(realDebridFile), { recursive: true });
    await writeFile(realDebridFile, "fixture");

    const foreignAbsolute = { fingerprint: { storage: { provider: "realdebrid", path: allDebridFile } } } as any;
    expect(await resolveVersionProbePath(foreignAbsolute)).toBeUndefined();

    const version = { fingerprint: { storage: { provider: "realdebrid", path: filename } } } as any;
    expect(await resolveVersionProbePath(version)).toBe(realDebridFile);
  });
});
