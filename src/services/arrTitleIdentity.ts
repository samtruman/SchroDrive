export type ArrTitleRecord = {
  title?: string;
  originalTitle?: string;
  alternateTitles?: Array<string | { title?: string }>;
};

/** Normalizes Arr display-title suffixes that are not part of release names. */
export function normalizeArrTitle(value: string): string {
  return value
    .replace(/\s*\((?:US|UK|AU|CA|IE|NZ)\)\s*$/i, "")
    .replace(/\s*\((?:19|20|21)\d{2}\)\s*$/i, "")
    .replace(/\s+(?:US|UK|AU|CA|IE|NZ)\s*$/i, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function arrTitleAliases(record: ArrTitleRecord): string[] {
  return [record.title, record.originalTitle, ...(record.alternateTitles || []).map((value) => typeof value === "string" ? value : value.title)]
    .filter((value): value is string => Boolean(value))
    .map(normalizeArrTitle);
}
