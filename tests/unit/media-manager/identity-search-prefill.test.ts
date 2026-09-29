import { describe, expect, test } from "bun:test";
import { normalizeIdentitySearchPrefill } from "../../../web/src/components/media-manager/identity-search-prefill";

describe("TMDb identity search prefill", () => {
  test("normalizes Gunner 2024", () => {
    expect(normalizeIdentitySearchPrefill("Gunner 2024")).toEqual({ query: "Gunner", year: 2024 });
  });

  test("normalizes Green Book 2018", () => {
    expect(normalizeIdentitySearchPrefill("Green Book 2018")).toEqual({ query: "Green Book", year: 2018 });
  });

  test("supports parenthesized and bracketed years", () => {
    expect(normalizeIdentitySearchPrefill("Example (2024)")).toEqual({ query: "Example", year: 2024 });
    expect(normalizeIdentitySearchPrefill("Example [2018]")).toEqual({ query: "Example", year: 2018 });
  });

  test("does not strip title numbers that are not plausible release years", () => {
    expect(normalizeIdentitySearchPrefill("2001: A Space Odyssey")).toEqual({ query: "2001: A Space Odyssey" });
    expect(normalizeIdentitySearchPrefill("Blade Runner 2049")).toEqual({ query: "Blade Runner 2049" });
  });

  test("does not double-normalize a separately supplied year", () => {
    expect(normalizeIdentitySearchPrefill("Gunner 2024", 2024)).toEqual({ query: "Gunner 2024", year: 2024 });
  });
});
