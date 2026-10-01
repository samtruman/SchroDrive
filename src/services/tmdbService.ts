import axios from "axios";
import { config } from "../core/config";
import { selectMediaCandidate } from "./mediaParser";

export type TmdbSearchKind = "movie" | "tv";
export type TmdbLookupStatus = "matched" | "not_matched" | "ambiguous" | "unavailable" | "configuration_unavailable";

export interface TmdbMetadata {
  tmdbId: string;
  imdbId?: string;
  tvdbId?: string;
  title: string;
  year?: number;
  kind: TmdbSearchKind;
  originalLanguage?: string;
}

export interface TmdbLookupResult {
  status: TmdbLookupStatus;
  metadata?: TmdbMetadata;
  reason: string;
}

export interface TmdbManualCandidate {
  tmdbId: string;
  title: string;
  originalTitle?: string;
  mediaType: TmdbSearchKind;
  releaseDate?: string;
  year?: number;
  originalLanguage?: string;
  imdbId?: string;
  tvdbId?: string;
  overview?: string;
}

export interface TmdbRequestOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

async function requestWithRetry<T>(request: () => Promise<T>, options: TmdbRequestOptions = {}): Promise<T> {
  const timeoutMs = Math.max(250, options.timeoutMs ?? 10000);
  const retries = Math.max(0, options.retries ?? 0);
  const backoffMs = Math.max(0, options.backoffMs ?? 250);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("TMDb request timed out")), timeoutMs);
        request().then(resolve, reject).finally(() => clearTimeout(timer));
      });
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
    }
  }
  throw lastError;
}

/** Read-only candidate search for the manual Media Manager identity picker. */
export async function searchTmdbCandidates(
  query: string,
  kind: TmdbSearchKind,
  year?: number,
  options: TmdbRequestOptions = {},
): Promise<TmdbManualCandidate[]> {
  if (!config.tmdbApiKey) throw new Error("TMDB_API_KEY is not configured");
  const params: Record<string, string | number | boolean> = { api_key: config.tmdbApiKey, query, include_adult: false };
  if (year) params[kind === "movie" ? "year" : "first_air_date_year"] = year;
  const response = await requestWithRetry(
    () => axios.get(`https://api.themoviedb.org/3/search/${kind}`, { params, timeout: options.timeoutMs ?? 10000, family: 4 }),
    options,
  );
  const results = Array.isArray(response.data?.results) ? response.data.results.slice(0, 10) : [];
  return Promise.all(results.map(async (item: any): Promise<TmdbManualCandidate> => {
    const id = String(item.id);
    let external: any = {};
    try {
      const response = await requestWithRetry(
        () => axios.get(`https://api.themoviedb.org/3/${kind}/${id}/external_ids`, { params: { api_key: config.tmdbApiKey }, timeout: options.timeoutMs ?? 10000, family: 4 }),
        options,
      );
      external = response.data || {};
    } catch {
      // Search results remain useful when optional external-ID enrichment fails.
    }
    const releaseDate = String(kind === "movie" ? item.release_date || "" : item.first_air_date || "");
    return {
      tmdbId: id,
      title: String(kind === "movie" ? item.title || item.original_title || "" : item.name || item.original_name || ""),
      originalTitle: (kind === "movie" ? item.original_title : item.original_name) || undefined,
      mediaType: kind,
      releaseDate: releaseDate || undefined,
      year: Number(releaseDate.slice(0, 4)) || undefined,
      originalLanguage: item.original_language || undefined,
      imdbId: external.imdb_id || undefined,
      tvdbId: external.tvdb_id ? String(external.tvdb_id) : undefined,
      overview: item.overview || undefined,
    };
  }));
}

/** Shared read-only TMDb lookup used by Organizer and Version Manager. */
export async function searchTmdb(title: string, kind: TmdbSearchKind, year?: number, options: TmdbRequestOptions = {}): Promise<TmdbLookupResult> {
  if (!config.tmdbApiKey) return { status: "configuration_unavailable", reason: "TMDB_API_KEY is not configured" };
  try {
    const params: Record<string, string | number | boolean> = { api_key: config.tmdbApiKey, query: title, include_adult: false };
    if (year) params[kind === "movie" ? "year" : "first_air_date_year"] = year;
    const searchUrl = `https://api.themoviedb.org/3/search/${kind}`;
    const response = await requestWithRetry(() => axios.get(searchUrl, { params, timeout: options.timeoutMs ?? 10000, family: 4 }), options);
    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    const candidates = results.map((item: any) => ({
      id: String(item.id),
      title: kind === "movie" ? (item.title || item.original_title || "") : (item.name || item.original_name || ""),
      kind: kind === "movie" ? "movie" as const : "show" as const,
      year: Number(String(kind === "movie" ? item.release_date : item.first_air_date || "").slice(0, 4)) || undefined,
    }));
    const selection = selectMediaCandidate({ title, year, kind: kind === "movie" ? "movie" : "episode" }, candidates);
    if (selection.status === "ambiguous") return { status: "ambiguous", reason: "TMDb candidates are too close" };
    if (selection.status !== "matched" || !selection.candidate) return { status: "not_matched", reason: "TMDb returned no reliable candidate" };
    const hit = results.find((item: any) => String(item.id) === String(selection.candidate?.id));
    if (!hit) return { status: "not_matched", reason: "TMDb candidate disappeared before enrichment" };
    const [external, details] = await Promise.all([
      requestWithRetry(() => axios.get(`https://api.themoviedb.org/3/${kind === "movie" ? "movie" : "tv"}/${hit.id}/external_ids`, { params: { api_key: config.tmdbApiKey }, timeout: options.timeoutMs ?? 10000, family: 4 }), options),
      requestWithRetry(() => axios.get(`https://api.themoviedb.org/3/${kind === "movie" ? "movie" : "tv"}/${hit.id}`, { params: { api_key: config.tmdbApiKey }, timeout: options.timeoutMs ?? 10000, family: 4 }), options),
    ]);
    const releaseDate = kind === "movie" ? hit.release_date : hit.first_air_date;
    return {
      status: "matched",
      reason: "TMDb title/year lookup",
      metadata: {
        tmdbId: String(hit.id),
        imdbId: external.data?.imdb_id || undefined,
        tvdbId: external.data?.tvdb_id ? String(external.data.tvdb_id) : undefined,
        title: kind === "movie" ? (hit.title || hit.original_title || title) : (hit.name || hit.original_name || title),
        year: Number(String(releaseDate || "").slice(0, 4)) || year,
        kind,
        originalLanguage: details.data?.original_language || undefined,
      },
    };
  } catch (error: any) {
    return { status: "unavailable", reason: error?.message || "TMDb request failed" };
  }
}
