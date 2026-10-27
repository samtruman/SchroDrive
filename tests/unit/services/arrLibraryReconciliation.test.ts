import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, symlink, writeFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { config } from "../../../src/core/config";
import { reconcileOrganizedLibraryWithArr, resolveAuthoritativeArrLibraryPath } from "../../../src/services/arrLibraryReconciliation";

const originalFetch = globalThis.fetch;
const original = {
  organizedBase: config.organizedBase,
  radarrUrl: config.providerReconciliationRadarrUrl,
  radarrKey: config.providerReconciliationRadarrApiKey,
  sonarrUrl: config.providerReconciliationSonarrUrl,
  sonarrKey: config.providerReconciliationSonarrApiKey,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.organizedBase = original.organizedBase;
  config.providerReconciliationRadarrUrl = original.radarrUrl;
  config.providerReconciliationRadarrApiKey = original.radarrKey;
  config.providerReconciliationSonarrUrl = original.sonarrUrl;
  config.providerReconciliationSonarrApiKey = original.sonarrKey;
});

describe("Arr library path reconciliation", () => {
  test("moves an existing AllDebrid organizer symlink to Radarr's authoritative path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arr-path-reconcile-"));
    try {
      const source = path.join(root, "provider", "The.Godfather.1972.mkv");
      const oldDir = path.join(root, "organized", "Movies", "The Godfather (1972)");
      const arrDir = path.join(root, "organized", "Movies", "Il Padrino (1972)");
      const oldLink = path.join(oldDir, path.basename(source));
      const newLink = path.join(arrDir, path.basename(source));
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(oldDir, { recursive: true });
      await writeFile(source, "fixture");
      await symlink(path.relative(oldDir, source), oldLink);

      config.organizedBase = path.join(root, "organized");
      config.providerReconciliationRadarrUrl = "http://radarr.fixture";
      config.providerReconciliationRadarrApiKey = "fixture-key";
      config.providerReconciliationSonarrUrl = "";
      config.providerReconciliationSonarrApiKey = "";

      const requests: Array<{ url: string; body?: any }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (String(input).endsWith("/api/v3/movie")) {
          return new Response(JSON.stringify([{ id: 42, title: "The Godfather", tmdbId: 238, path: arrDir }]), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 1, status: "queued" }), { status: 201 });
      }) as typeof fetch;

      const result = await reconcileOrganizedLibraryWithArr();
      expect(result.moved).toBe(1);
      expect((await lstat(newLink)).isSymbolicLink()).toBe(true);
      expect(path.resolve(path.dirname(newLink), await readlink(newLink))).toBe(source);
      await expect(lstat(oldLink)).rejects.toThrow();
      expect(requests.some((request) => request.body?.name === "RescanMovie" && request.body?.movieId === 42)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not rescan ARR when the organized symlink is already authoritative", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arr-path-reconcile-noop-"));
    try {
      const source = path.join(root, "provider", "The.Godfather.1972.mkv");
      const arrDir = path.join(root, "organized", "Movies", "The Godfather (1972)");
      const link = path.join(arrDir, path.basename(source));
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(arrDir, { recursive: true });
      await writeFile(source, "fixture");
      await symlink(path.relative(arrDir, source), link);

      config.organizedBase = path.join(root, "organized");
      config.providerReconciliationRadarrUrl = "http://radarr.fixture";
      config.providerReconciliationRadarrApiKey = "fixture-key";
      config.providerReconciliationSonarrUrl = "";
      config.providerReconciliationSonarrApiKey = "";

      const requests: Array<{ url: string; body?: any }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (String(input).endsWith("/api/v3/movie")) {
          return new Response(JSON.stringify([{ id: 42, title: "The Godfather", tmdbId: 238, path: arrDir }]), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 1, status: "queued" }), { status: 201 });
      }) as typeof fetch;

      const result = await reconcileOrganizedLibraryWithArr();
      expect(result.moved).toBe(0);
      expect(requests.some((request) => request.body?.name === "RescanMovie")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repairs a release-like Radarr path from the verified library directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arr-path-repair-"));
    try {
      const source = path.join(root, "provider", "Gunner.2024.1080p.mkv");
      const libraryDir = path.join(root, "organized", "Movies", "Gunner (2024)");
      const link = path.join(libraryDir, path.basename(source));
      const badArrPath = path.join(root, "organized", "Movies", "Gunner H265 iTA ENG 1080p mkv");
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(libraryDir, { recursive: true });
      await writeFile(source, "fixture");
      await symlink(path.relative(libraryDir, source), link);

      config.organizedBase = path.join(root, "organized");
      config.providerReconciliationRadarrUrl = "http://radarr.fixture";
      config.providerReconciliationRadarrApiKey = "fixture-key";
      config.providerReconciliationSonarrUrl = "";
      config.providerReconciliationSonarrApiKey = "";

      const requests: Array<{ url: string; method?: string; body?: any }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/api/v3/movie")) {
          return new Response(JSON.stringify([{ id: 157, title: "Gunner", tmdbId: 123, path: badArrPath }]), { status: 200 });
        }
        if (url.endsWith("/api/v3/movie/157")) {
          if (init?.method === "PUT") return new Response(JSON.stringify({ id: 157, path: libraryDir }), { status: 200 });
          return new Response(JSON.stringify({ id: 157, title: "Gunner", tmdbId: 123, path: badArrPath }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 1, status: "queued" }), { status: 201 });
      }) as typeof fetch;

      const result = await reconcileOrganizedLibraryWithArr();
      expect(result.unresolved).toBe(0);
      expect(requests.some((request) => request.method === "PUT" && request.body?.path === libraryDir)).toBe(true);
      expect(requests.some((request) => request.body?.name === "RescanMovie" && request.body?.movieId === 157)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reconciles a numeric movie release folder using the filename identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arr-numeric-movie-"));
    try {
      const source = path.join(root, "provider", "1917.(2019).2160p.mkv");
      const badDir = path.join(root, "organized", "Movies", "2019 4K HDR 2160p mkv (1917)");
      const arrDir = path.join(root, "organized", "Movies", "1917 (2019)");
      const link = path.join(badDir, path.basename(source));
      const newLink = path.join(arrDir, path.basename(source));
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(badDir, { recursive: true });
      await writeFile(source, "fixture");
      await symlink(path.relative(badDir, source), link);

      config.organizedBase = path.join(root, "organized");
      config.providerReconciliationRadarrUrl = "http://radarr.fixture";
      config.providerReconciliationRadarrApiKey = "fixture-key";
      config.providerReconciliationSonarrUrl = "";
      config.providerReconciliationSonarrApiKey = "";

      const requests: Array<{ url: string; body?: any }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/api/v3/movie")) {
          return new Response(JSON.stringify([{ id: 1917, title: "1917", year: 2019, tmdbId: 143, path: arrDir }]), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 1, status: "queued" }), { status: 201 });
      }) as typeof fetch;

      const result = await reconcileOrganizedLibraryWithArr();
      expect(result.moved).toBe(1);
      expect((await lstat(newLink)).isSymbolicLink()).toBe(true);
      await expect(lstat(link)).rejects.toThrow();
      expect(requests.some((request) => request.body?.name === "RescanMovie" && request.body?.movieId === 1917)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  test("matches Sonarr regional title aliases such as Ghosts and Ghosts (US)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arr-series-alias-"));
    try {
      const source = path.join(root, "provider", "Ghosts.2x16.Il.Libro.Di.Isaac.mkv");
      const oldDir = path.join(root, "organized", "TV", "Ghosts", "Season 02");
      const arrDir = path.join(root, "organized", "TV", "Ghosts (US)");
      const oldLink = path.join(oldDir, path.basename(source));
      const newLink = path.join(arrDir, "Season 02", path.basename(source));
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(oldDir, { recursive: true });
      await writeFile(source, "fixture");
      await symlink(path.relative(oldDir, source), oldLink);

      config.organizedBase = path.join(root, "organized");
      config.providerReconciliationRadarrUrl = "";
      config.providerReconciliationRadarrApiKey = "";
      config.providerReconciliationSonarrUrl = "http://sonarr.fixture";
      config.providerReconciliationSonarrApiKey = "fixture-key";

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v3/series")) {
          return new Response(JSON.stringify([{ id: 61, title: "Ghosts (US)", tmdbId: 95396, path: arrDir }]), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 1, status: "queued" }), { status: 201 });
      }) as typeof fetch;

      const result = await reconcileOrganizedLibraryWithArr();
      expect(result.moved).toBe(1);
      expect(result.unresolved).toBe(0);
      expect((await lstat(newLink)).isSymbolicLink()).toBe(true);
      await expect(lstat(oldLink)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses a unique Sonarr title before TMDb even when the episode year differs from the series year", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arr-series-year-"));
    try {
      const source = path.join(root, "provider", "Brothers.2026.S01E05.mkv");
      const oldDir = path.join(root, "organized", "TV", "Brothers", "Season 01");
      const arrDir = path.join(root, "organized", "TV", "Brothers (2025)");
      const oldLink = path.join(oldDir, path.basename(source));
      const newLink = path.join(arrDir, "Season 01", path.basename(source));
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(oldDir, { recursive: true });
      await writeFile(source, "fixture");
      await symlink(path.relative(oldDir, source), oldLink);

      config.organizedBase = path.join(root, "organized");
      config.providerReconciliationRadarrUrl = "";
      config.providerReconciliationRadarrApiKey = "";
      config.providerReconciliationSonarrUrl = "http://sonarr.fixture";
      config.providerReconciliationSonarrApiKey = "fixture-key";

      let tmdbCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v3/series")) return new Response(JSON.stringify([{ id: 72, title: "Brothers (2026)", year: 2026, tmdbId: 250203, path: arrDir }]), { status: 200 });
        if (url.includes("api.themoviedb.org")) tmdbCalls++;
        return new Response(JSON.stringify({ id: 1, status: "queued" }), { status: 201 });
      }) as typeof fetch;

      const result = await reconcileOrganizedLibraryWithArr();
      expect(result).toMatchObject({ moved: 1, unresolved: 0 });
      expect(tmdbCalls).toBe(0);
      expect((await lstat(newLink)).isSymbolicLink()).toBe(true);
      await expect(lstat(oldLink)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });



  test("resolves the ARR library path before an organizer symlink is created", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arr-path-before-organize-"));
    try {
      const organizedBase = path.join(root, "organized");
      const arrDir = path.join(organizedBase, "TV", "Foundation (2021)");
      config.organizedBase = organizedBase;
      config.providerReconciliationRadarrUrl = "";
      config.providerReconciliationRadarrApiKey = "";
      config.providerReconciliationSonarrUrl = "";
      config.providerReconciliationSonarrApiKey = "";

      const resolved = await resolveAuthoritativeArrLibraryPath(
        {
          source: "/mnt/provider/Foundation.S01E01.mkv",
          currentLink: "/mnt/provider/Foundation.S01E01.mkv",
          category: "series",
          title: "Foundation",
          titleCandidates: ["Foundation"],
          year: 2021,
          season: 1,
        },
        "/mnt/provider/Foundation.S01E01.mkv",
        { movies: [], series: [{ id: 17, title: "Foundation (2021)", year: 2021, path: arrDir }] },
      );

      expect(resolved).toBe(arrDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
