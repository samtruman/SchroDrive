import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../../src/core/config";
import { pushReleaseToArr } from "../../../src/services/arrReleasePush";

describe("ARR release push", () => {
  const originalUrl = config.providerReconciliationRadarrUrl;
  const originalKey = config.providerReconciliationRadarrApiKey;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    config.providerReconciliationRadarrUrl = originalUrl;
    config.providerReconciliationRadarrApiKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  test("forwards the selected indexer release to Radarr's release push endpoint", async () => {
    config.providerReconciliationRadarrUrl = "http://radarr.test/";
    config.providerReconciliationRadarrApiKey = "fixture-key";

    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(String(input), init);
      return new Response(JSON.stringify([{ id: 42, title: "The Odyssey" }]), { status: 200 });
    }) as typeof fetch;

    const result = await pushReleaseToArr("movie", {
      magnet: "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      identity: { tmdbId: 1368337, title: "The Odyssey", year: 2026 },
      release: {
        guid: "prowlarr-guid",
        title: "The Odyssey (2026) 2160p",
        size: 6400000000,
        indexerId: 12,
        indexer: "LimeTorrents",
        infoHash: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
        seeders: 101,
        leechers: 3,
        publishDate: "2026-11-19T18:00:00.000Z",
      },
    });

    expect(result.response).toEqual([{ id: 42, title: "The Odyssey" }]);
    expect(request?.url).toBe("http://radarr.test/api/v3/release/push");
    expect(request?.headers.get("X-Api-Key")).toBe("fixture-key");
    const body = await request!.json();
    expect(body).toMatchObject({
      guid: "prowlarr-guid",
      title: "The Odyssey (2026) 2160p",
      magnetUrl: "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      protocol: "torrent",
      tmdbId: 1368337,
      indexerId: 12,
      indexer: "LimeTorrents",
      infoHash: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
    });
  });

  test("fails clearly when the target Arr API is not configured", async () => {
    config.providerReconciliationRadarrUrl = "";
    config.providerReconciliationRadarrApiKey = "";

    await expect(pushReleaseToArr("movie", {
      magnet: "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      identity: { tmdbId: 1368337, title: "The Odyssey" },
    })).rejects.toThrow("Radarr API is not configured");
  });
});

