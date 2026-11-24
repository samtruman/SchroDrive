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
  response: unknown;
};

function routeFor(mediaType: ArrMediaType): { baseUrl: string; apiKey: string; name: string } {
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

function asNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normaliseRelease(
  release: ArrReleaseInput | undefined,
  magnet: string,
  name: string | undefined,
  identity: ArrIdentityInput,
): Record<string, unknown> {
  const title = String(release?.title || name || identity.title || "").trim();
  if (!title) throw new Error("ARR release push requires a release title");

  const infoHash = String(release?.infoHash || "").trim() || undefined;
  const guid = String(release?.guid || (infoHash ? `schrodrive:${infoHash}` : `schrodrive:${title}`)).trim();
  const payload: Record<string, unknown> = {
    guid,
    title,
    size: asNumber(release?.size) || 0,
    indexerId: asNumber(release?.indexerId) || 0,
    indexer: String(release?.indexer || "SchroDrive").trim(),
    publishDate: release?.publishDate || new Date().toISOString(),
    infoUrl: release?.infoUrl || undefined,
    downloadUrl: release?.downloadUrl || undefined,
    magnetUrl: magnet,
    infoHash,
    seeders: asNumber(release?.seeders),
    leechers: asNumber(release?.leechers),
    protocol: "torrent",
    tmdbId: asNumber(identity.tmdbId),
  };

  // Radarr/Sonarr validate that at least one of downloadUrl or magnetUrl is
  // present. Remove undefined values so the request matches their resource
  // contract instead of sending a misleading null field.
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

export async function pushReleaseToArr(
  mediaType: ArrMediaType,
  input: { magnet: string; name?: string; release?: ArrReleaseInput; identity: ArrIdentityInput },
): Promise<ArrReleasePushResult> {
  const route = routeFor(mediaType);
  if (!route.baseUrl || !route.apiKey) {
    throw new Error(`${route.name} API is not configured for ARR release push`);
  }

  const endpoint = `${route.baseUrl.replace(/\/$/, "")}/api/v3/release/push`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-Api-Key": route.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(normaliseRelease(input.release, input.magnet, input.name, input.identity)),
  });

  const text = await response.text();
  let body: unknown = undefined;
  if (text.trim()) {
    try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
  }
  if (!response.ok) {
    throw new Error(`${route.name} release push failed: HTTP ${response.status}`);
  }

  return { mediaType, endpoint, response: body };
}
