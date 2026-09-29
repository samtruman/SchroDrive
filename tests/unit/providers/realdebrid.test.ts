import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { axiosIPv4 } from "../../../src/core/httpClient";
import { config } from "../../../src/core/config";
import { rateLimiter } from "../../../src/core/rateLimiter";
import { RealDebridProvider } from "../../../src/providers/realdebrid";

describe("Real-Debrid file tree capability", () => {
  const originalGet = axiosIPv4.get;

  beforeEach(() => {
    config.rdAccessToken = "unit-test-token";
    rateLimiter.setThrottleDelay("realdebrid", 0);
  });

  afterEach(() => {
    axiosIPv4.get = originalGet;
    config.rdAccessToken = "";
  });

  test("normalizes files from the torrent detail response", async () => {
    axiosIPv4.get = async () => ({ data: {
      id: "NVTY3EO4Z2HQ2",
      status: "downloaded",
      hash: "f6ad95a9f7395c5a2aa5ec2fad09880dd4d99724",
      files: [
        { id: 1, path: "Alien/Alien.mkv", bytes: 100, selected: 1 },
        { id: 2, path: "Alien/Alien.srt", bytes: 10, selected: 0 },
      ],
      links: ["redacted-link"],
    } } as any);

    const files = await new RealDebridProvider().getTorrentFileTree("NVTY3EO4Z2HQ2");
    expect(files).toEqual([
      { id: "1", name: "Alien.mkv", path: "Alien/Alien.mkv", size: 100, selected: true },
      { id: "2", name: "Alien.srt", path: "Alien/Alien.srt", size: 10, selected: false },
    ]);
  });

  test("waits through an existing rate-limit window instead of returning an empty tree", async () => {
    axiosIPv4.get = async () => ({ data: { files: [{ id: 1, path: "Alien.mkv", bytes: 100, selected: 1 }] } } as any);
    rateLimiter.recordRateLimit("realdebrid", "fixture", 0.001);
    const files = await new RealDebridProvider().getTorrentFileTree("NVTY3EO4Z2HQ2");
    expect(files).toHaveLength(1);
  });
});
