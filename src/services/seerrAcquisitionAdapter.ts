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

/**
 * Read-only Seerr adapter. The request method is intentionally unavailable in
 * this milestone; no POST/PUT/DELETE is issued by this module.
 */
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
      canRequest: false,
    };
  }

  async status(need: AcquisitionNeed): Promise<{ status: ProviderStatus; providerRequestId?: string; detail?: string }> {
    if (!configured()) return { status: "CONFIGURATION_UNAVAILABLE", detail: "Seerr URL or authentication is not configured" };
    const id = providerId(need);
    if (!id) return { status: "MEDIA_NOT_FOUND", detail: "Current Seerr adapter requires a TMDb ID mapping" };
    const mediaType = need.mediaType === "movie" ? "movie" : "tv";
    try {
      const response = await axios.get(`${baseUrl()}/${mediaType}/${encodeURIComponent(id)}`, { headers: headers(), timeout: 15000 });
      return { status: mediaStatus(response.data), providerRequestId: response.data?.request?.id ? String(response.data.request.id) : undefined };
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

  async request(_need: AcquisitionNeed): Promise<never> {
    throw new Error("Seerr acquisition requests are disabled in this milestone; preview is read-only");
  }
}

export function seerrConfigurationStatus(): "available" | "configuration_unavailable" {
  return configured() ? "available" : "configuration_unavailable";
}
