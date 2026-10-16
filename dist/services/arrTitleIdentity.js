"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeArrTitle = normalizeArrTitle;
exports.arrTitleAliases = arrTitleAliases;
/** Normalizes Arr display-title suffixes that are not part of release names. */
function normalizeArrTitle(value) {
    return value
        .replace(/\s*\((?:US|UK|AU|CA|IE|NZ)\)\s*$/i, "")
        .replace(/\s*\((?:19|20|21)\d{2}\)\s*$/i, "")
        .replace(/\s+(?:US|UK|AU|CA|IE|NZ)\s*$/i, "")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
}
function arrTitleAliases(record) {
    return [record.title, record.originalTitle, ...(record.alternateTitles || []).map((value) => typeof value === "string" ? value : value.title)]
        .filter((value) => Boolean(value))
        .map(normalizeArrTitle);
}
