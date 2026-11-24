import { config } from "../core/config";

export type ArrMediaType = "movie" | "tv";

export type ArrReleaseInput = {
  guid?: string;
  title?: string;
  size?: number;
  indexerId?: number | string;
  indexer?: string;
  publishDate?: string;
  downloadUrl?: string;
  infoUrl?: string;
  magnetUrl?: string;
  infoHash?: string;
  seeders?: number;
  leechers?: number;
};

export type ArrIdentityInput = {
  tmdbId?: number | string;
  title?: string;
  year?: number;
};

export type ArrReleasePushResult = {
  mediaType: ArrMediaType;
  endpoint: string;
  searchEndpoint: string;
  response: unknown;
};

type ArrRoute = { baseUrl: string; apiKey: string; name: string };

function routeFor(mediaType: ArrMediaType): ArrRoute {
  if (mediaType === "movie") {
    return {
      baseUrl: config.providerReconciliationRadarrUrl,
      apiKey: config.providerReconciliationRadarrApiKey,
      name: "Radarr",
    };
  }
  return {
    baseUrl: config.providerReconciliationSonarrUrl,
    apiKey: config.providerReconciliationSonarrApiKey,
    name: "Sonarr",
  };
}

/** Whether the ARR target for this media type is configured. */
export function isArrConfigured(mediaType: ArrMediaType): boolean {
  const route = routeFor(mediaType);
  return Boolean(route.baseUrl && route.apiKey);
}

function normaliseBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    "X-Api-Key": apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function readJson(response: Response, context: string): Promise<any> {
  const text = await response.text();
  let body: any = undefined;
  if (text.trim()) {
    try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
  }
  if (!response.ok) {
    const detail = typeof body === "string" ? `: ${body}` : "";
    throw new Error(`${context} failed: HTTP ${response.status}${detail}`);
  }
  return body;
}

async function arrGet(route: ArrRoute, path: string): Promise<any> {
  const endpoint = `${normaliseBaseUrl(route.baseUrl)}${path}`;
  const response = await fetch(endpoint, { headers: apiHeaders(route.apiKey) });
  return readJson(response, `${route.name} GET ${path}`);
}

function normaliseHash(value: unknown): string {
  return String(value || "").replace(/[^a-f0-9]/gi, "").toLowerCase();
}

function hashFromMagnet(magnet: string): string {
  try {
    const xt = new URL(magnet).searchParams.get("xt") || "";
    return normaliseHash(xt.replace(/^urn:btih:/i, ""));
  } catch {
    return "";
  }
}

function normaliseTitle(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function releaseMatches(candidate: any, input: ArrReleaseInput | undefined, magnet: string): boolean {
  const selectedHash = normaliseHash(input?.infoHash) || hashFromMagnet(magnet);
  const candidateHash = normaliseHash(candidate?.infoHash || candidate?.releaseHash);
  if (selectedHash && candidateHash) return selectedHash === candidateHash;

  const selectedTitle = normaliseTitle(input?.title);
  const candidateTitle = normaliseTitle(candidate?.title);
  if (!selectedTitle || !candidateTitle || selectedTitle !== candidateTitle) return false;

  const selectedSize = Number(input?.size || 0);
  const candidateSize = Number(candidate?.size || 0);
  if (!selectedSize || !candidateSize) return true;
  return Math.abs(selectedSize - candidateSize) / Math.max(selectedSize, candidateSize) < 0.03;
}

function findByTmdbId(items: any[], tmdbId: string, label: string): any {
  const match = (Array.isArray(items) ? items : []).find((item) => String(item?.tmdbId || "") === tmdbId);
  if (!match) throw new Error(`${label} non contiene il titolo TMDB ${tmdbId}; aggiungilo prima a ${label}`);
  return match;
}

function seasonFromTitle(title: string): number | undefined {
  const match = title.match(/\bS0*(\d{1,3})(?:E\d{1,3})*\b/i)
    || title.match(/\bSeason\s*0*(\d{1,3})\b/i);
  return match ? Number(match[1]) : undefined;
}

async function findArrRelease(
  route: ArrRoute,
  mediaType: ArrMediaType,
  identity: ArrIdentityInput,
  input: ArrReleaseInput | undefined,
  magnet: string,
): Promise<{ candidate: any; searchEndpoint: string }> {
  const tmdbId = String(identity.tmdbId || "").trim();
  const title = String(input?.title || identity.title || "").trim();
  if (!tmdbId) throw new Error(`Identità TMDB mancante per ${route.name}`);

  if (mediaType === "movie") {
    const movies = await arrGet(route, "/api/v3/movie");
    const movie = findByTmdbId(movies, tmdbId, "Radarr");
    const searchEndpoint = `/api/v3/release?movieId=${encodeURIComponent(String(movie.id))}`;
    const releases = await arrGet(route, searchEndpoint);
    const candidate = (Array.isArray(releases) ? releases : []).find((release) => releaseMatches(release, input, magnet));
    if (!candidate) {
      throw new Error(`Radarr non ha restituito la release selezionata per "${title || identity.title}"; ripeti la ricerca manuale in Radarr`);
    }
    return { candidate, searchEndpoint };
  }

  const seriesList = await arrGet(route, "/api/v3/series");
  const series = findByTmdbId(seriesList, tmdbId, "Sonarr");
  const season = seasonFromTitle(title);
  if (!season) {
    throw new Error("Sonarr richiede stagione/episodio nel titolo della release per eseguire il grab manuale");
  }

  const searchEndpoint = `/api/v3/release?seriesId=${encodeURIComponent(String(series.id))}&seasonNumber=${encodeURIComponent(String(season))}`;
  const releases = await arrGet(route, searchEndpoint);
  const candidate = (Array.isArray(releases) ? releases : []).find((release) => releaseMatches(release, input, magnet));
  if (!candidate) {
    throw new Error(`Sonarr non ha restituito la release selezionata per "${title || identity.title}"; ripeti la ricerca manuale in Sonarr`);
  }
  return { candidate, searchEndpoint };
}

/**
 * Grab a release through the same cached manual-search path used by ARR UI.
 *
 * `/api/v3/release/push` is the RSS path and can silently reject a release
 * (notably when the movie/series is unmonitored). The manual path must first
 * search the ARR indexers, then POST the exact cached ReleaseResource returned
 * by that search to `/api/v3/release`.
 */
export async function pushReleaseToArr(
  mediaType: ArrMediaType,
  input: { magnet: string; name?: string; release?: ArrReleaseInput; identity: ArrIdentityInput },
): Promise<ArrReleasePushResult> {
  const route = routeFor(mediaType);
  if (!route.baseUrl || !route.apiKey) {
    throw new Error(`${route.name} API is not configured for manual ARR grab`);
  }

  const { candidate, searchEndpoint } = await findArrRelease(route, mediaType, input.identity, input.release, input.magnet);
  const endpoint = `${normaliseBaseUrl(route.baseUrl)}/api/v3/release`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: apiHeaders(route.apiKey),
    body: JSON.stringify(candidate),
  });
  const body = await readJson(response, `${route.name} manual grab`);
  return { mediaType, endpoint, searchEndpoint, response: body };
}
