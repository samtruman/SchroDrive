import axios from "axios";
import { afterEach, describe, expect, test } from "bun:test";
import { searchTmdb } from "../../../src/services/tmdbService";

const originalGet = axios.get;

afterEach(() => {
  axios.get = originalGet;
});

describe("shared TMDb service", () => {
  test("uses the shared TMDB_API_KEY configuration and reports it unavailable without credentials", async () => {
    if (process.env.TMDB_API_KEY) return;
    const result = await searchTmdb("Spirited Away", "movie", 2001);
    expect(result.status).toBe("configuration_unavailable");
    expect(result.metadata).toBeUndefined();
  });

  test("accepts an injected API key for non-Media-Manager callers", async () => {
    const requests: Array<{ url: string; apiKey?: string }> = [];
    axios.get = (async (url: string, options?: any) => {
      requests.push({ url, apiKey: options?.params?.api_key });
      if (url.endsWith("/search/movie")) return { data: { results: [{ id: 123, title: "Fixture Film", release_date: "2024-01-01", original_language: "en" }] } } as any;
      if (url.endsWith("/external_ids")) return { data: { imdb_id: "tt1234567", tvdb_id: 456 } } as any;
      return { data: { original_language: "en" } } as any;
    }) as typeof axios.get;

    const result = await searchTmdb("Fixture Film", "movie", 2024, { apiKey: "injected-fixture-key" });

    expect(result.status).toBe("matched");
    expect(result.metadata).toMatchObject({ tmdbId: "123", imdbId: "tt1234567", tvdbId: "456" });
    expect(requests.length).toBe(3);
    expect(requests.every((request) => request.apiKey === "injected-fixture-key")).toBe(true);
  });
});
