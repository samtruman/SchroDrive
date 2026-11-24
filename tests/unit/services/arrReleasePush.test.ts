import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../../src/core/config";
import { pushReleaseToArr } from "../../../src/services/arrReleasePush";

describe("ARR manual release grab", () => {
  const original = {
    radarrUrl: config.providerReconciliationRadarrUrl,
    radarrKey: config.providerReconciliationRadarrApiKey,
    sonarrUrl: config.providerReconciliationSonarrUrl,
    sonarrKey: config.providerReconciliationSonarrApiKey,
    fetch: globalThis.fetch,
  };

  afterEach(() => {
    config.providerReconciliationRadarrUrl = original.radarrUrl;
    config.providerReconciliationRadarrApiKey = original.radarrKey;
    config.providerReconciliationSonarrUrl = original.sonarrUrl;
    config.providerReconciliationSonarrApiKey = original.sonarrKey;
    globalThis.fetch = original.fetch;
  });

  test("uses Radarr manual search then grabs the matching cached release", async () => {
    config.providerReconciliationRadarrUrl = "http://radarr.test/";
    config.providerReconciliationRadarrApiKey = "fixture-key";

    const candidate = {
      guid: "radarr-guid",
      title: "The Odyssey (2026) 2160p",
      infoHash: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      indexerId: 12,
      protocol: "torrent",
      movieId: 42,
    };
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(String(input), init);
      requests.push(request);
      if (request.url.endsWith("/api/v3/movie")) {
        return new Response(JSON.stringify([{ id: 42, tmdbId: 1368337, title: "The Odyssey" }]), { status: 200 });
      }
      if (request.url.includes("/api/v3/release?movieId=42")) {
        return new Response(JSON.stringify([candidate]), { status: 200 });
      }
      return new Response(JSON.stringify(candidate), { status: 200 });
    }) as typeof fetch;

    const result = await pushReleaseToArr("movie", {
      magnet: "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      identity: { tmdbId: 1368337, title: "The Odyssey", year: 2026 },
      release: { title: candidate.title, infoHash: candidate.infoHash },
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://radarr.test/api/v3/movie",
      "http://radarr.test/api/v3/release?movieId=42",
      "http://radarr.test/api/v3/release",
    ]);
    expect(requests[2].method).toBe("POST");
    expect(await requests[2].json()).toEqual(candidate);
    expect(result.endpoint).toBe("http://radarr.test/api/v3/release");
    expect(result.arrEntityCreated).toBe(false);
  });

  test("creates a missing Radarr movie from TMDB before grabbing the release", async () => {
    config.providerReconciliationRadarrUrl = "http://radarr.test";
    config.providerReconciliationRadarrApiKey = "fixture-key";

    const candidate = {
      guid: "radarr-new-guid",
      title: "One Last Shot 2026 2160p",
      infoHash: "FEDCBA0987654321FEDCBA0987654321FEDCBA09",
      indexerId: 12,
      protocol: "torrent",
      movieId: 77,
    };
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(String(input), init);
      requests.push(request);
      if (request.url.endsWith("/api/v3/movie") && request.method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (request.url.includes("/api/v3/movie/lookup?term=tmdb%3A1607127")) {
        return new Response(JSON.stringify([{ tmdbId: 1607127, title: "One Last Shot", year: 2026 }]), { status: 200 });
      }
      if (request.url.endsWith("/api/v3/qualityprofile")) {
        return new Response(JSON.stringify([{ id: 6, name: "Any" }]), { status: 200 });
      }
      if (request.url.endsWith("/api/v3/rootfolder")) {
        return new Response(JSON.stringify([{ id: 1, path: "/movies", accessible: true }]), { status: 200 });
      }
      if (request.url.endsWith("/api/v3/movie") && request.method === "POST") {
        return new Response(JSON.stringify({ id: 77, tmdbId: 1607127, title: "One Last Shot", year: 2026 }), { status: 201 });
      }
      if (request.url.includes("/api/v3/release?movieId=77")) {
        return new Response(JSON.stringify([candidate]), { status: 200 });
      }
      return new Response(JSON.stringify(candidate), { status: 200 });
    }) as typeof fetch;

    const result = await pushReleaseToArr("movie", {
      magnet: "magnet:?xt=urn:btih:FEDCBA0987654321FEDCBA0987654321FEDCBA09",
      identity: { tmdbId: 1607127, title: "One Last Shot", year: 2026 },
      release: { title: candidate.title, infoHash: candidate.infoHash },
    });

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET http://radarr.test/api/v3/movie",
      "GET http://radarr.test/api/v3/movie/lookup?term=tmdb%3A1607127",
      "GET http://radarr.test/api/v3/qualityprofile",
      "GET http://radarr.test/api/v3/rootfolder",
      "POST http://radarr.test/api/v3/movie",
      "GET http://radarr.test/api/v3/release?movieId=77",
      "POST http://radarr.test/api/v3/release",
    ]);
    expect(await requests[4].json()).toEqual(expect.objectContaining({
      tmdbId: 1607127,
      qualityProfileId: 6,
      rootFolderPath: "/movies",
      monitored: true,
      addOptions: { searchForMovie: false },
    }));
    expect(result.arrEntityCreated).toBe(true);
  });

  test("uses Sonarr season search then grabs the matching cached release", async () => {
    config.providerReconciliationSonarrUrl = "http://sonarr.test";
    config.providerReconciliationSonarrApiKey = "sonarr-key";

    const candidate = {
      guid: "sonarr-guid",
      title: "Slow Horses S05E01 1080p",
      infoHash: "1234567890ABCDEF1234567890ABCDEF12345678",
      indexerId: 7,
      protocol: "torrent",
      seriesId: 9,
    };
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(String(input), init);
      requests.push(request);
      if (request.url.endsWith("/api/v3/series")) {
        return new Response(JSON.stringify([{ id: 9, tmdbId: 95396, title: "Slow Horses" }]), { status: 200 });
      }
      if (request.url.includes("/api/v3/release?seriesId=9&seasonNumber=5")) {
        return new Response(JSON.stringify([candidate]), { status: 200 });
      }
      return new Response(JSON.stringify(candidate), { status: 200 });
    }) as typeof fetch;

    await pushReleaseToArr("tv", {
      magnet: "magnet:?xt=urn:btih:1234567890ABCDEF1234567890ABCDEF12345678",
      identity: { tmdbId: 95396, title: "Slow Horses" },
      release: { title: candidate.title, infoHash: candidate.infoHash },
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://sonarr.test/api/v3/series",
      "http://sonarr.test/api/v3/release?seriesId=9&seasonNumber=5",
      "http://sonarr.test/api/v3/release",
    ]);
  });

  test("creates a missing Sonarr series from TMDB before grabbing the season release", async () => {
    config.providerReconciliationSonarrUrl = "http://sonarr.test";
    config.providerReconciliationSonarrApiKey = "sonarr-key";

    const candidate = {
      guid: "sonarr-new-guid",
      title: "Slow Horses S05E01 1080p",
      infoHash: "1111222233334444555566667777888899990000",
      indexerId: 7,
      protocol: "torrent",
      seriesId: 9,
    };
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(String(input), init);
      requests.push(request);
      if (request.url.endsWith("/api/v3/series") && request.method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (request.url.includes("/api/v3/series/lookup?term=tmdb%3A95396")) {
        return new Response(JSON.stringify([{ tmdbId: 95396, tvdbId: 81189, title: "Slow Horses", year: 2022 }]), { status: 200 });
      }
      if (request.url.endsWith("/api/v3/qualityprofile")) {
        return new Response(JSON.stringify([{ id: 8, name: "TV" }]), { status: 200 });
      }
      if (request.url.endsWith("/api/v3/rootfolder")) {
        return new Response(JSON.stringify([{ id: 2, path: "/tv", accessible: true }]), { status: 200 });
      }
      if (request.url.endsWith("/api/v3/series") && request.method === "POST") {
        return new Response(JSON.stringify({ id: 9, tmdbId: 95396, tvdbId: 81189, title: "Slow Horses" }), { status: 201 });
      }
      if (request.url.includes("/api/v3/release?seriesId=9&seasonNumber=5")) {
        return new Response(JSON.stringify([candidate]), { status: 200 });
      }
      return new Response(JSON.stringify(candidate), { status: 200 });
    }) as typeof fetch;

    const result = await pushReleaseToArr("tv", {
      magnet: "magnet:?xt=urn:btih:1111222233334444555566667777888899990000",
      identity: { tmdbId: 95396, title: "Slow Horses" },
      release: { title: candidate.title, infoHash: candidate.infoHash },
    });

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET http://sonarr.test/api/v3/series",
      "GET http://sonarr.test/api/v3/series/lookup?term=tmdb%3A95396",
      "GET http://sonarr.test/api/v3/qualityprofile",
      "GET http://sonarr.test/api/v3/rootfolder",
      "POST http://sonarr.test/api/v3/series",
      "GET http://sonarr.test/api/v3/release?seriesId=9&seasonNumber=5",
      "POST http://sonarr.test/api/v3/release",
    ]);
    expect(await requests[4].json()).toEqual(expect.objectContaining({
      tmdbId: 95396,
      tvdbId: 81189,
      qualityProfileId: 8,
      rootFolderPath: "/tv",
      monitored: true,
      seasonFolder: true,
      addOptions: { searchForMissingEpisodes: false },
    }));
    expect(result.arrEntityCreated).toBe(true);
  });

  test("does not fall back to the RSS push path when the ARR release is not found", async () => {
    config.providerReconciliationRadarrUrl = "http://radarr.test";
    config.providerReconciliationRadarrApiKey = "fixture-key";

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v3/movie")) {
        return new Response(JSON.stringify([{ id: 42, tmdbId: 1368337 }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    await expect(pushReleaseToArr("movie", {
      magnet: "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      identity: { tmdbId: 1368337, title: "The Odyssey" },
      release: { title: "Missing release", infoHash: "ABCDEF1234567890ABCDEF1234567890ABCDEF12" },
    })).rejects.toThrow("Radarr non ha restituito la release selezionata");
  });

  test("fails clearly when the target ARR API is not configured", async () => {
    config.providerReconciliationRadarrUrl = "";
    config.providerReconciliationRadarrApiKey = "";

    await expect(pushReleaseToArr("movie", {
      magnet: "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      identity: { tmdbId: 1368337, title: "The Odyssey" },
    })).rejects.toThrow("Radarr API is not configured for manual ARR grab");
  });
});
