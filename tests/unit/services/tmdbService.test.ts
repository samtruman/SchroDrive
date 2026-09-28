import { describe, expect, test } from "bun:test";
import { searchTmdb } from "../../../src/services/tmdbService";

describe("shared TMDb service", () => {
  test("uses the shared TMDB_API_KEY configuration and reports it unavailable without credentials", async () => {
    if (process.env.TMDB_API_KEY) return;
    const result = await searchTmdb("Spirited Away", "movie", 2001);
    expect(result.status).toBe("configuration_unavailable");
    expect(result.metadata).toBeUndefined();
  });
});
