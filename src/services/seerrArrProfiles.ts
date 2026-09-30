import axios from "axios";
import { config } from "../core/config";
import { seerrApiBaseUrl } from "./seerrUrl";

export type ArrKind = "radarr" | "sonarr";

export interface SeerrArrQualityProfile {
  kind: ArrKind;
  provider: ArrKind;
  serverId: string;
  serverName: string;
  qualityProfileId: string;
  qualityProfileName: string;
  serverUrl?: string;
  source: "seerr" | "arr-fallback";
}

export interface SeerrArrProfileDiscovery {
  source: "seerr";
  configured: boolean;
  profiles: SeerrArrQualityProfile[];
  errors: Array<{ kind: ArrKind; code: "UNAVAILABLE" | "INVALID_RESPONSE"; message: string }>;
}

function headers(): Record<string, string> {
  const result: Record<string, string> = {};
  if (config.overseerrApiKey) result["X-Api-Key"] = config.overseerrApiKey;
  if (config.overseerrAuth) result.Authorization = config.overseerrAuth.startsWith("Bearer ") ? config.overseerrAuth : `Bearer ${config.overseerrAuth}`;
  return result;
}

function configured(): boolean {
  return Boolean(config.overseerrUrl && (config.overseerrApiKey || config.overseerrAuth));
}

function listPayload(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.servers)) return body.servers;
  return [];
}

function profilePayload(server: any): any[] {
  return Array.isArray(server?.profiles) ? server.profiles : Array.isArray(server?.qualityProfiles) ? server.qualityProfiles : [];
}

function serverUrl(server: any): string | undefined {
  if (typeof server?.externalUrl === "string" && server.externalUrl) return server.externalUrl.replace(/\/$/, "");
  if (typeof server?.url === "string" && server.url) return server.url.replace(/\/$/, "");
  if (!server?.hostname || !server?.port) return undefined;
  return `${server.useSsl ? "https" : "http"}://${server.hostname}:${server.port}${server.baseUrl || ""}`.replace(/\/$/, "");
}

function profileRecords(kind: ArrKind, server: any, profiles: any[], source: "seerr" | "arr-fallback"): SeerrArrQualityProfile[] {
  return profiles.map((profile: any) => ({
    kind,
    provider: kind,
    serverId: String(server.id ?? server.serverId ?? ""),
    serverName: String(server.name ?? server.hostname ?? `${kind} server`),
    qualityProfileId: String(profile.id ?? profile.qualityProfileId ?? ""),
    qualityProfileName: String(profile.name ?? profile.label ?? `Profile ${profile.id ?? "unknown"}`),
    serverUrl: serverUrl(server),
    source,
  })).filter((profile: SeerrArrQualityProfile) => profile.serverId && profile.qualityProfileId);
}

async function discoverKind(kind: ArrKind): Promise<SeerrArrQualityProfile[]> {
  const response = await axios.get(`${seerrApiBaseUrl(config.overseerrUrl)}/settings/${kind}`, { headers: headers(), timeout: 15000 });
  const servers = listPayload(response.data);
  return (await Promise.all(servers.map(async (server: any) => {
    const nested = profilePayload(server);
    if (nested.length > 0) return profileRecords(kind, server, nested, "seerr");
    const serverId = String(server.id ?? server.serverId ?? "");
    try {
      const viaSeerr = await axios.get(`${seerrApiBaseUrl(config.overseerrUrl)}/settings/${kind}/${encodeURIComponent(serverId)}/profiles`, { headers: headers(), timeout: 15000 });
      const profiles = listPayload(viaSeerr.data);
      if (profiles.length > 0) return profileRecords(kind, server, profiles, "seerr");
    } catch {
      // Some Seerr versions do not proxy Sonarr profiles. Use its declared
      // ARR connection read-only below, without inventing a local profile.
    }
    const base = serverUrl(server);
    if (!base || !server.apiKey) return [];
    const direct = await axios.get(`${base}/api/v3/qualityprofile`, { headers: { "X-Api-Key": String(server.apiKey) }, timeout: 15000 });
    return profileRecords(kind, server, listPayload(direct.data), "arr-fallback");
  }))).flat();
}

export async function discoverSeerrArrProfiles(): Promise<SeerrArrProfileDiscovery> {
  if (!configured()) return { source: "seerr", configured: false, profiles: [], errors: [] };
  const results = await Promise.all(([
    ["radarr", () => discoverKind("radarr")],
    ["sonarr", () => discoverKind("sonarr")],
  ] as const).map(async ([kind, request]) => {
    try { return { kind, profiles: await request() }; }
    catch (error: any) {
      const status = Number(error?.response?.status);
      return { kind, profiles: [], error: { kind, code: status >= 400 ? "INVALID_RESPONSE" as const : "UNAVAILABLE" as const, message: status ? `Seerr ${kind} discovery failed with HTTP ${status}` : `Seerr ${kind} discovery unavailable` } };
    }
  }));
  return { source: "seerr", configured: true, profiles: results.flatMap((result) => result.profiles), errors: results.flatMap((result) => result.error ? [result.error] : []) };
}
