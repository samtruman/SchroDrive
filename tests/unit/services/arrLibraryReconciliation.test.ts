import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, symlink, writeFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { config } from "../../../src/core/config";
import { reconcileOrganizedLibraryWithArr } from "../../../src/services/arrLibraryReconciliation";

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
});
