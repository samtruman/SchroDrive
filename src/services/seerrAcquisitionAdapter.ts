import axios from "axios";
import { config } from "../core/config";
import { seerrApiBaseUrl } from "./seerrUrl";
import type {
  AcquisitionAdapter,
  AcquisitionAdapterCapabilities,
  AcquisitionNeed,
  AcquisitionPreview,
  AcquisitionProviderStatus,
} from "./acquisition";

type ProviderStatus = AcquisitionProviderStatus;

const inFlightRequests = new Set<string>();

function configured(): boolean {
  return Boolean(config.overseerrUrl && (config.overseerrApiKey || config.overseerrAuth));
}

function headers(): Record<string, string> {
  const result: Record<string, string> = {};
  if (config.overseerrApiKey) result["X-Api-Key"] = config.overseerrApiKey;
  if (config.overseerrAuth) result.Authorization = config.overseerrAuth.startsWith("Bearer ") ? config.overseerrAuth : `Bearer ${config.overseerrAuth}`;
  return result;
}

function baseUrl(): string {
  return seerrApiBaseUrl(config.overseerrUrl);
}

function providerId(need: AcquisitionNeed): string | undefined {
  // The current Seerr media endpoints are TMDb keyed. Other canonical IDs
  // remain valid for the generic core but require an explicit future mapping.
  return need.contentIdentity.tmdbId;
}

function requestScope(need: AcquisitionNeed): string {
  return need.mediaType === "tv"
    ? `tv:${providerId(need) || "unknown"}:season:${need.season ?? "unknown"}`
    : `movie:${providerId(need) || "unknown"}`;
}

function requestIsActive(status: unknown): boolean {
  const value = String(status ?? "").toLowerCase();
  if (["failed", "declined", "cancelled", "canceled", "deleted", "rejected"].some((item) => value.includes(item))) return false;
  if (/^\d+$/.test(value)) return true;
  return ["pending", "approved", "requested", "processing", "available", "partially", "completed"].some((item) => value.includes(item));
}

function requestStatus(status: unknown): ProviderStatus {
  const value = String(status ?? "").toLowerCase();
  if (value.includes("partial")) return "PARTIALLY_AVAILABLE";
  if (value.includes("process") || value.includes("downloading")) return "PROCESSING";
  if (value.includes("pending")) return "PENDING";
  return "REQUESTED";
}

function mediaStatus(data: any): ProviderStatus {
  if (!data) return "MEDIA_NOT_FOUND";
  const status = String(data.status || data.mediaInfo?.status || data.media?.status || "").toLowerCase();
  if (status.includes("error") || status.includes("failed")) return "ERROR";
  if (status.includes("partial")) return "PARTIALLY_AVAILABLE";
  if (status.includes("available") || data.mediaInfo?.mediaFiles?.length || data.mediaFiles?.length) return "AVAILABLE";
  if (status.includes("processing") || status.includes("downloading")) return "PROCESSING";
  if (status.includes("pending") || status.includes("approve")) return "PENDING";
  if (status.includes("request")) return "REQUESTED";
  return "NOT_REQUESTED";
}

export class SeerrAcquisitionAdapter implements AcquisitionAdapter {
  async capabilities(): Promise<AcquisitionAdapterCapabilities> {
    return {
      adapterId: "seerr",
      enabled: configured(),
      supportsMovie: true,
      supportsTv: true,
      // Seerr exposes media/request state for TV, but a request is normally
      // scoped to a season/series. We never hide that limitation as episode support.
      tvScope: "season",
      canRequest: config.acquisitionRequestsEnabled,
    };
  }

  async status(need: AcquisitionNeed): Promise<{ status: ProviderStatus; providerRequestId?: string; detail?: string }> {
    if (!configured()) return { status: "CONFIGURATION_UNAVAILABLE", detail: "Seerr URL or authentication is not configured" };
    const id = providerId(need);
    if (!id) return { status: "MEDIA_NOT_FOUND", detail: "Current Seerr adapter requires a TMDb ID mapping" };
    const mediaType = need.mediaType === "movie" ? "movie" : "tv";
    try {
      const response = await axios.get(`${baseUrl()}/${mediaType}/${encodeURIComponent(id)}`, { headers: headers(), timeout: 15000 });
      const media = mediaStatus(response.data);
      const requests: any[] = [];
      for (let skip = 0; skip < 2000; skip += 100) {
        const requestResponse = await axios.get(`${baseUrl()}/request`, {
          params: { take: 100, skip, sort: "modified" },
          headers: headers(),
          timeout: 15000,
        });
        const page = Array.isArray(requestResponse.data?.results) ? requestResponse.data.results : [];
        requests.push(...page);
        if (page.length < 100) break;
      }
      const matching = requests.filter((item: any) => {
        const requestMediaType = String(item?.media?.mediaType || item?.media?.type || "").toLowerCase();
        const requestMediaId = String(item?.media?.tmdbId ?? item?.mediaId ?? "");
        if (requestMediaType && requestMediaType !== mediaType) return false;
        if (requestMediaId !== String(id)) return false;
        if (mediaType !== "tv") return true;
        const requestedSeason = need.season;
        const seasons = item?.media?.seasons || item?.seasons || [];
        if (requestedSeason === undefined || !Array.isArray(seasons) || seasons.length === 0) return true;
        return seasons.some((season: any) => Number(season.seasonNumber ?? season.season ?? season) === requestedSeason);
      });
      const active = matching.find((item: any) => requestIsActive(item?.status));
      if (active) {
        const status = media === "AVAILABLE" || media === "PARTIALLY_AVAILABLE" ? media : requestStatus(active.status);
        return { status, providerRequestId: active?.id !== undefined ? String(active.id) : undefined, detail: "Equivalent active Seerr request detected via request lookup" };
      }
      return { status: media, providerRequestId: response.data?.request?.id ? String(response.data.request.id) : undefined };
    } catch (error: any) {
      const status = Number(error?.response?.status);
      if (status === 404) return { status: "MEDIA_NOT_FOUND", detail: "Seerr media record was not found" };
      if (status >= 400) return { status: "ERROR", detail: `Seerr GET failed with HTTP ${status}` };
      return { status: "UNAVAILABLE", detail: status ? `Seerr GET failed with HTTP ${status}` : "Seerr GET failed" };
    }
  }

  async preview(need: AcquisitionNeed): Promise<AcquisitionPreview> {
    const capabilities = await this.capabilities();
    if (need.status !== "ACQUISITION_ELIGIBLE") {
      return {
        needId: need.id,
        status: "ACQUISITION_BLOCKED",
        adapterId: "seerr",
        contentIdentity: need.contentIdentity,
        mediaType: need.mediaType,
        requestedProfileId: need.missingProfileId,
        requestedProfileName: need.missingProfileName,
        providerStatus: capabilities.enabled ? "configured" : "configuration_unavailable",
        safe: true,
      };
    }
    const current = await this.status(need);
    const alreadySatisfied = current.status === "AVAILABLE";
    const mappingWarning = need.mediaType === "tv" && need.episode !== undefined
      ? "Seerr request scope is season-level; preview does not imply an episode-only request."
      : "The Version Profile is more precise than the provider quality mapping; Seerr/Radarr/Sonarr may not guarantee the requested fingerprint.";
    return {
      needId: need.id,
      status: alreadySatisfied ? "ACQUISITION_AVAILABLE" : current.status === "REQUESTED" || current.status === "PENDING" || current.status === "PROCESSING" || current.status === "PARTIALLY_AVAILABLE" ? "ACQUISITION_ALREADY_EXISTS" : current.status === "CONFIGURATION_UNAVAILABLE" || current.status === "UNAVAILABLE" || current.status === "ERROR" ? "ACQUISITION_BLOCKED" : "ACQUISITION_ELIGIBLE",
      adapterId: "seerr",
      contentIdentity: need.contentIdentity,
      mediaType: need.mediaType,
      requestedProfileId: need.missingProfileId,
      requestedProfileName: need.missingProfileName,
      providerStatus: current.status,
      providerMediaStatus: current.status,
      tvScope: need.mediaType === "tv" ? capabilities.tvScope : undefined,
      mappingWarning,
      safe: true,
    };
  }

  async request(need: AcquisitionNeed): Promise<{ providerRequestId?: string; status: string; detail?: string }> {
    if (!config.acquisitionRequestsEnabled) throw new Error("Seerr acquisition requests are disabled");
    if (!configured()) throw new Error("Seerr is not configured");
    if (need.mediaType !== "movie") throw new Error("Controlled single-request path currently supports movies only");
    if (need.status !== "ACQUISITION_ELIGIBLE" || !need.acquisitionEligibility.eligible) {
      throw new Error("Acquisition need is not eligible");
    }
    const id = providerId(need);
    if (!id) throw new Error("Acquisition need has no TMDb ID");

    const scope = requestScope(need);
    if (inFlightRequests.has(scope)) throw new Error("Equivalent Seerr request is already in flight");
    inFlightRequests.add(scope);
    try {

      // Revalidate immediately before the only mutating call. Any existing
      // media state or active request blocks the request and provides duplicate protection.
      const current = await this.status(need);
      if (current.status !== "NOT_REQUESTED") {
        throw new Error(`Equivalent Seerr request/status detected: ${current.status}${current.providerRequestId ? ` (${current.providerRequestId})` : ""}`);
      }

      const response = await axios.post(`${baseUrl()}/request`, {
        mediaType: "movie",
        mediaId: Number(id),
      }, { headers: { ...headers(), "Content-Type": "application/json" }, timeout: 30000 });
      const requestId = response.data?.id || response.data?.request?.id;
      return {
        providerRequestId: requestId !== undefined ? String(requestId) : undefined,
        status: "REQUESTED",
        detail: "Single movie request accepted by Seerr",
      };
    } finally {
      inFlightRequests.delete(scope);
    }
  }
}

export function seerrConfigurationStatus(): "available" | "configuration_unavailable" {
  return configured() ? "available" : "configuration_unavailable";
}
