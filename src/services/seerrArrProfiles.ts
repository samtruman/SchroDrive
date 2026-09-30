import axios from "axios";
import { config } from "../core/config";
import { seerrApiBaseUrl } from "./seerrUrl";

export type ArrKind = "radarr" | "sonarr";

export interface SeerrArrQualityProfile {
  kind: ArrKind;
  serverId: string;
  serverName: string;
  qualityProfileId: string;
  qualityProfileName: string;
  serverUrl?: string;
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

async function discoverKind(kind: ArrKind): Promise<SeerrArrQualityProfile[]> {
  const response = await axios.get(`${seerrApiBaseUrl(config.overseerrUrl)}/settings/${kind}`, { headers: headers(), timeout: 15000 });
  const servers = listPayload(response.data);
  return servers.flatMap((server: any) => profilePayload(server).map((profile: any) => ({
    kind,
    serverId: String(server.id ?? server.serverId ?? ""),
    serverName: String(server.name ?? server.hostname ?? `${kind} server`),
    qualityProfileId: String(profile.id ?? profile.qualityProfileId ?? ""),
    qualityProfileName: String(profile.name ?? profile.label ?? `Profile ${profile.id ?? "unknown"}`),
    serverUrl: typeof server.url === "string" ? server.url : undefined,
  })).filter((profile: SeerrArrQualityProfile) => profile.serverId && profile.qualityProfileId));
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
