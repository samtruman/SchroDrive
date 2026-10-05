/**
 * DavDebrid-compatible filename classification seam.
 *
 * The historical MediaBridge contract (`src/media_parser.py` with its
 * `plex_parser_v2` fallback) is conservative: episode patterns win, then a
 * year-bearing release is a movie. This ports that boundary without bringing
 * the Python/Plex runtime into SchröDrive or changing provider/filesystem I/O.
 */

export interface DavParsedMedia {
  type: "movie" | "episode" | "unknown";
  title?: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeEnd?: number;
}

function clean(value: string): string {
  return value
    .replace(/[._]+/g, " ")
    .replace(/[\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\-–—]+\s*$/, "")
    .trim();
}

function parseYear(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return parsed >= 1800 && parsed <= 2199 ? parsed : undefined;
}

/** Parse the historical DavDebrid/Plex classification subset. */
export function parseDavDebridFilename(filename: string): DavParsedMedia {
  const stem = filename.replace(/\.[^.]+$/, "");
  const normalized = clean(stem);

  // Proven Plex episode forms are checked before movie fallback.
  const episode = normalized.match(
    /^(.*?)(?:\s+|-)?S(\d{1,3})E(\d{1,3})(?:-?E?(\d{1,3}))?\b/i,
  );
  if (episode && clean(episode[1])) {
    return {
      type: "episode",
      title: clean(episode[1]),
      season: Number(episode[2]),
      episode: Number(episode[3]),
      episodeEnd: episode[4] ? Number(episode[4]) : undefined,
    };
  }

  const alternateEpisode = normalized.match(
    /^(.*?)(?:\s+|-)?(\d{1,2})x(\d{1,3})(?:-?(\d{1,3}))?\b/i,
  );
  if (alternateEpisode && clean(alternateEpisode[1])) {
    return {
      type: "episode",
      title: clean(alternateEpisode[1]),
      season: Number(alternateEpisode[2]),
      episode: Number(alternateEpisode[3]),
      episodeEnd: alternateEpisode[4] ? Number(alternateEpisode[4]) : undefined,
    };
  }

  // Critical regression boundary: `Title - 2024` is a film year, not an
  // absolute TV episode. The old SchröDrive absolute-number rule ran first.
  const movieYear = normalized.match(/^(.*?)(?:\s*\(((?:19|20|21)\d{2})\)|(?:\s|[.-])((?:19|20|21)\d{2}))(?:\s|$)/);
  if (movieYear && clean(movieYear[1])) {
    return { type: "movie", title: clean(movieYear[1]), year: parseYear(movieYear[2] || movieYear[3]) };
  }

  return { type: "unknown" };
}
