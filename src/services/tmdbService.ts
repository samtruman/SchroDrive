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

/** Shared read-only TMDb lookup used by Organizer and Version Manager. */
export async function searchTmdb(title: string, kind: TmdbSearchKind, year?: number): Promise<TmdbLookupResult> {
  if (!config.tmdbApiKey) return { status: "configuration_unavailable", reason: "TMDB_API_KEY is not configured" };
  try {
    const params: Record<string, string | number | boolean> = { api_key: config.tmdbApiKey, query: title, include_adult: false };
    if (year) params[kind === "movie" ? "year" : "first_air_date_year"] = year;
    const searchUrl = `https://api.themoviedb.org/3/search/${kind}`;
    const response = await axios.get(searchUrl, { params, timeout: 10000 });
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
      axios.get(`https://api.themoviedb.org/3/${kind === "movie" ? "movie" : "tv"}/${hit.id}/external_ids`, { params: { api_key: config.tmdbApiKey }, timeout: 10000 }),
      axios.get(`https://api.themoviedb.org/3/${kind === "movie" ? "movie" : "tv"}/${hit.id}`, { params: { api_key: config.tmdbApiKey }, timeout: 10000 }),
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
