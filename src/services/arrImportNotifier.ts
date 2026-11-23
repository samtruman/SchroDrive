import { config } from "../core/config";

export type ArrImportTarget = "radarr" | "sonarr";

export type ArrImportCommand = {
  commandId: string;
  status: string;
  result?: string;
};

/**
 * Resolve the Arr instance from the qBittorrent category assigned by Arr.
 * Custom categories are deliberately not guessed: sending a movie to Sonarr
 * (or a series to Radarr) is worse than deferring the notification.
 */
export function arrImportTargetForCategory(category: string): ArrImportTarget | undefined {
  const value = category.trim().toLowerCase();
  if (["radarr", "radarr-movies", "movies", "movie"].includes(value)) return "radarr";
  if (["sonarr", "sonarr-tv", "shows", "series", "tv"].includes(value)) return "sonarr";
  return undefined;
}

function routeFor(target: ArrImportTarget): { baseUrl: string; apiKey: string; commandName: string } {
  if (target === "radarr") {
    return {
      baseUrl: config.providerReconciliationRadarrUrl,
      apiKey: config.providerReconciliationRadarrApiKey,
      commandName: "DownloadedMoviesScan",
    };
  }
  return {
    baseUrl: config.providerReconciliationSonarrUrl,
    apiKey: config.providerReconciliationSonarrApiKey,
    commandName: "DownloadedEpisodesScan",
  };
}

/** Ask Arr to scan/import one completed qBittorrent content path. */
export async function requestArrDownloadedScan(
  target: ArrImportTarget,
  contentPath: string,
): Promise<ArrImportCommand> {
  const route = routeFor(target);
  if (!route.baseUrl || !route.apiKey) {
    throw new Error(`${target} API is not configured for targeted import`);
  }
  if (!contentPath || !contentPath.startsWith("/")) {
    throw new Error("Arr targeted import requires an absolute content path");
  }

  const response = await fetch(`${route.baseUrl.replace(/\/$/, "")}/api/v3/command`, {
    method: "POST",
    headers: {
      "X-Api-Key": route.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name: route.commandName,
      path: contentPath,
      importMode: "Copy",
    }),
  });

  const text = await response.text();
  let body: { id?: number | string; status?: string; result?: string } = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`${target} targeted import returned invalid JSON`);
    }
  }
  if (!response.ok) throw new Error(`${target} targeted import failed: HTTP ${response.status}`);
  if (body.id === undefined || body.id === null || String(body.id).trim() === "") {
    throw new Error(`${target} targeted import response did not include a command id`);
  }

  return { commandId: String(body.id), status: body.status || "queued", result: body.result };
}
