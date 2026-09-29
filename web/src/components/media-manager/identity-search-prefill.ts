export interface IdentitySearchPrefill {
  query: string;
  year?: number;
}

/**
 * Improves only the initial TMDb search fields. It never changes the parsed
 * title, Organizer review, ContentIdentity, or persisted manual identity.
 */
export function normalizeIdentitySearchPrefill(title?: string, separateYear?: number): IdentitySearchPrefill {
  const query = (title || "").trim();
  if (separateYear !== undefined) return { query, year: separateYear };
  if (!query) return { query };

  const match = query.match(/^(.*?)[\s([{]+(\d{4})[\s)\]}]*$/);
  if (!match) return { query };

  const candidateYear = Number(match[2]);
  const currentYear = new Date().getFullYear();
  if (candidateYear < 1850 || candidateYear > currentYear + 1) return { query };

  const normalizedTitle = match[1].trim().replace(/[([{]$/, "").trim();
  if (!normalizedTitle) return { query };
  return { query: normalizedTitle, year: candidateYear };
}
