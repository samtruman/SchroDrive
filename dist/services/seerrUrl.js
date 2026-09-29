"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seerrApiBaseUrl = seerrApiBaseUrl;
/**
 * Normalises the configured Seerr service URL to its API root.
 * Both the service root and an already-entered /api/v1 URL are accepted.
 */
function seerrApiBaseUrl(value) {
    const base = value.replace(/\/+$/, "");
    return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}
