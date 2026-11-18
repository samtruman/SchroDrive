export function stripTmdbQuery(query: string): string {
  const cleaned = String(query || "").slice(0, 200);
  return cleaned.replace(/\s*TMDB\d+\b/gi, "").replace(/\s{2,}/g, " ").trim();
}

export function buildMagnetFromHash(hash: string, title?: string): string | undefined {
  const trimmed = hash.trim();
  const hex40 = /^[a-fA-F0-9]{40}$/;
  const b32 = /^[A-Z2-7]{32,39}$/i;
  if (!hex40.test(trimmed) && !b32.test(trimmed)) return undefined;

  const hashUpper = trimmed.toUpperCase();
  const dn = title ? `&dn=${encodeURIComponent(title)}` : "";
  return `magnet:?xt=urn:btih:${hashUpper}${dn}`;
}

export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Accept only magnet URIs carrying a BitTorrent content identifier.
 * HTTP Prowlarr/Jackett download links must be resolved by the indexer
 * adapter before they reach provider intake.
 */
export function isValidMagnetUri(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "magnet:") return false;
    return parsed.searchParams.getAll("xt").some((xt) =>
      /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/i.test(xt)
      || /^urn:btmh:[A-Za-z0-9]+$/i.test(xt),
    );
  } catch {
    return false;
  }
}
