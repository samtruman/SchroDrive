import { config } from "../core/config";
import { normalizeMediaTitle } from "./mediaParser";
import type { Provenance } from "./versionManager";

export type MediaServerStatus = "matched" | "not_matched" | "ambiguous" | "unavailable" | "configuration_unavailable" | "authentication_failed";

export interface MediaStreamEvidence {
  type: "video" | "audio" | "subtitle";
  codec?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  bitDepth?: number;
  hdr?: string;
  language?: string;
  channels?: number;
  forced?: boolean;
  atmos?: boolean;
  container?: string;
  runtimeSeconds?: number;
}

export interface MediaServerItem {
  title?: string;
  year?: number;
  kind?: "movie" | "episode" | "show";
  season?: number;
  episode?: number;
  path?: string;
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
  originalLanguage?: string;
  streams?: MediaStreamEvidence[];
  source: Provenance;
}

export interface MediaServerCatalog {
  source: "PLEX" | "JELLYFIN";
  status: MediaServerStatus;
  items: MediaServerItem[];
  error?: string;
}

export interface MediaServerCapabilities {
  identity: boolean;
  externalIds: boolean;
  pathMapping: boolean;
  mediaMetadata: boolean;
  mediaStreams: boolean;
}

export interface MediaServerProvider {
  readonly id: "PLEX" | "JELLYFIN";
  capabilities(): MediaServerCapabilities;
  catalog(): Promise<MediaServerCatalog>;
}

async function requestJson(url: string, init?: RequestInit): Promise<{ status: number; data?: any }> {
  try {
    const response = await fetch(url, init);
    if (response.status === 401 || response.status === 403) return { status: response.status };
    return { status: response.status, data: response.ok ? await response.json() : undefined };
  } catch {
    return { status: 0 };
  }
}

function idsFromGuids(guids: Array<{ id?: string }> = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (const guid of guids) {
    const value = guid.id || "";
    const match = value.match(/(?:tmdb|themoviedb|imdb|tvdb):\/\/?(.+)/i);
    if (!match) continue;
    const type = value.split(":")[0].toLowerCase();
    if (type.includes("tmdb")) result.tmdbId = match[1];
    if (type.includes("imdb")) result.imdbId = match[1];
    if (type.includes("tvdb")) result.tvdbId = match[1];
  }
  return result;
}

function streamFromPlex(stream: any): MediaStreamEvidence | undefined {
  const type = stream.streamType === 1 ? "video" : stream.streamType === 2 ? "audio" : stream.streamType === 3 ? "subtitle" : undefined;
  if (!type) return undefined;
  return { type, codec: stream.codec, width: stream.width, height: stream.height, bitrate: stream.bitrate, language: stream.language, channels: stream.channels, forced: Boolean(stream.forced), atmos: /atmos/i.test(`${stream.title || ""} ${stream.displayTitle || ""}`) };
}

function streamFromJellyfin(stream: any, container?: string, runtimeSeconds?: number): MediaStreamEvidence | undefined {
  const type = String(stream.Type || "").toLowerCase();
  if (type !== "video" && type !== "audio" && type !== "subtitle") return undefined;
  const hdr = stream.VideoRangeType || stream.VideoRange;
  return {
    type,
    codec: stream.Codec,
    width: stream.Width,
    height: stream.Height,
    bitrate: stream.BitRate,
    bitDepth: stream.BitDepth,
    hdr,
    language: stream.Language,
    channels: stream.Channels,
    forced: Boolean(stream.IsForced),
    atmos: /atmos/i.test(`${stream.DisplayTitle || ""} ${stream.Title || ""}`),
    container,
    runtimeSeconds,
  };
}

function catalogStatus(response: { status: number; data?: any }): MediaServerStatus {
  if (response.status === 401 || response.status === 403) return "authentication_failed";
  return response.data ? "matched" : "unavailable";
}

export class PlexMediaServerProvider implements MediaServerProvider {
  readonly id = "PLEX" as const;
  capabilities(): MediaServerCapabilities { return { identity: true, externalIds: true, pathMapping: true, mediaMetadata: true, mediaStreams: true }; }

  async catalog(): Promise<MediaServerCatalog> {
    if (!config.plexUrl || !config.plexToken) return { source: this.id, status: "configuration_unavailable", items: [], error: "Plex URL/token not configured" };
    const headers = { Accept: "application/json", "X-Plex-Token": config.plexToken };
    const base = config.plexUrl.replace(/\/$/, "");
    const sections = await requestJson(`${base}/library/sections`, { headers });
    const status = catalogStatus(sections);
    if (!sections.data) return { source: this.id, status, items: [], error: "Plex library sections request failed" };
    const items: MediaServerItem[] = [];
    for (const section of sections.data?.MediaContainer?.Directory || []) {
      const data = await requestJson(`${base}/library/sections/${section.key}/all?includeGuids=1&includeExtras=0&X-Plex-Container-Size=100000`, { headers });
      for (const item of data.data?.MediaContainer?.Metadata || []) {
        const part = item.Media?.[0]?.Part?.[0];
        const streams = (part?.Stream || []).map(streamFromPlex).filter(Boolean) as MediaStreamEvidence[];
        items.push({ title: item.title, year: item.year, kind: item.type === "episode" ? "episode" : item.type === "show" ? "show" : "movie", season: item.parentIndex, episode: item.index, path: part?.file, ...idsFromGuids(item.Guid), streams, source: this.id });
      }
    }
    return { source: this.id, status: "matched", items };
  }
}

export class JellyfinMediaServerProvider implements MediaServerProvider {
  readonly id = "JELLYFIN" as const;
  capabilities(): MediaServerCapabilities { return { identity: true, externalIds: true, pathMapping: true, mediaMetadata: true, mediaStreams: true }; }

  async catalog(): Promise<MediaServerCatalog> {
    if (!config.jellyfinUrl || !config.jellyfinApiKey) return { source: this.id, status: "configuration_unavailable", items: [], error: "Jellyfin URL/API key not configured" };
    const url = `${config.jellyfinUrl.replace(/\/$/, "")}/Items?Recursive=true&IncludeItemTypes=Movie,Series,Episode&Fields=ProviderIds,Path,ProductionYear,ParentIndexNumber,IndexNumber,OriginalLanguage,MediaSources&Limit=100000`;
    const response = await requestJson(url, { headers: { Authorization: `MediaBrowser Token="${config.jellyfinApiKey}"` } });
    const status = catalogStatus(response);
    if (!response.data) return { source: this.id, status, items: [], error: "Jellyfin library request failed" };
    const items = (response.data.Items || []).map((item: any): MediaServerItem => {
      const source = item.MediaSources?.[0];
      const runtimeSeconds = item.RunTimeTicks ? Number(item.RunTimeTicks) / 10_000_000 : undefined;
      const streams = (source?.MediaStreams || []).map((stream: any) => streamFromJellyfin(stream, source?.Container, runtimeSeconds)).filter(Boolean) as MediaStreamEvidence[];
      return { title: item.Name, year: item.ProductionYear, kind: item.Type === "Episode" ? "episode" : item.Type === "Series" ? "show" : "movie", season: item.ParentIndexNumber, episode: item.IndexNumber, path: item.Path, tmdbId: item.ProviderIds?.Tmdb, imdbId: item.ProviderIds?.Imdb, tvdbId: item.ProviderIds?.Tvdb, originalLanguage: item.OriginalLanguage, streams, source: this.id };
    });
    return { source: this.id, status: "matched", items };
  }
}

export const mediaServerProviders: MediaServerProvider[] = [new PlexMediaServerProvider(), new JellyfinMediaServerProvider()];

export function normalizeMediaServerTitle(value?: string): string {
  return normalizeMediaTitle(value || "");
}
