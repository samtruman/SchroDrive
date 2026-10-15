import path from "node:path";

/**
 * Shared library-path construction for the Organizer and the Arr bridge.
 *
 * Titles are presentation data; the caller must resolve them from TMDb before
 * calling this module. Keeping the path construction in one place prevents
 * Radarr/Sonarr symlinks and Organizer symlinks from drifting apart because
 * they used different filename parsers.
 */
export interface CanonicalMediaPathInput {
  category: "Movies" | "TV" | "Anime";
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
  sourceFilename: string;
}

export function safeLibrarySegment(value: string): string {
  return String(value || "Unknown")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]$/, "") || "Unknown";
}

export function canonicalLibraryDirectory(root: string, input: Omit<CanonicalMediaPathInput, "sourceFilename">): string {
  const title = safeLibrarySegment(input.title);
  const folder = input.year ? `${title} (${input.year})` : title;
  if (input.category === "Movies") return path.join(root, "Movies", folder);
  if (input.category === "Anime") return path.join(root, "Anime", folder);
  return path.join(root, "TV", folder, `Season ${String(input.season ?? 1).padStart(2, "0")}`);
}

export function canonicalLibraryPath(root: string, input: CanonicalMediaPathInput): string {
  return path.join(canonicalLibraryDirectory(root, input), path.basename(input.sourceFilename));
}
