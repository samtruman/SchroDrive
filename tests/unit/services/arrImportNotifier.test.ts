import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../../src/core/config";
import { arrImportTargetForCategory, requestArrDownloadedScan } from "../../../src/services/arrImportNotifier";

describe("targeted Arr import notification", () => {
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

  test("maps only known Arr categories", () => {
    expect(arrImportTargetForCategory("radarr")).toBe("radarr");
    expect(arrImportTargetForCategory("sonarr")).toBe("sonarr");
    expect(arrImportTargetForCategory("custom-downloads")).toBeUndefined();
  });

  test("submits a targeted Radarr movie scan for the completed staging path", async () => {
    config.providerReconciliationRadarrUrl = "http://radarr.test/";
    config.providerReconciliationRadarrApiKey = "fixture-key";
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(String(input), init);
      return new Response(JSON.stringify({ id: 42, status: "queued" }), { status: 200 });
    }) as typeof fetch;

    await expect(requestArrDownloadedScan("radarr", "/downloads/radarr/The.Movie")).resolves.toEqual({
      commandId: "42",
      status: "queued",
      result: undefined,
    });
    expect(request?.url).toBe("http://radarr.test/api/v3/command");
    expect(request?.headers.get("X-Api-Key")).toBe("fixture-key");
    expect(await request!.json()).toEqual({
      name: "DownloadedMoviesScan",
      path: "/downloads/radarr/The.Movie",
      importMode: "Copy",
    });
  });

  test("uses Sonarr's episode scan command", async () => {
    config.providerReconciliationSonarrUrl = "http://sonarr.test";
    config.providerReconciliationSonarrApiKey = "fixture-key";
    let body: any;
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 7, status: "queued" }), { status: 200 });
    }) as typeof fetch;

    await requestArrDownloadedScan("sonarr", "/downloads/sonarr/Slow.Horses");
    expect(body).toEqual({
      name: "DownloadedEpisodesScan",
      path: "/downloads/sonarr/Slow.Horses",
      importMode: "Copy",
    });
  });
});
