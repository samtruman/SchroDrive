"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverSeerrArrProfiles = discoverSeerrArrProfiles;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../core/config");
const seerrUrl_1 = require("./seerrUrl");
function headers() {
    const result = {};
    if (config_1.config.overseerrApiKey)
        result["X-Api-Key"] = config_1.config.overseerrApiKey;
    if (config_1.config.overseerrAuth)
        result.Authorization = config_1.config.overseerrAuth.startsWith("Bearer ") ? config_1.config.overseerrAuth : `Bearer ${config_1.config.overseerrAuth}`;
    return result;
}
function configured() {
    return Boolean(config_1.config.overseerrUrl && (config_1.config.overseerrApiKey || config_1.config.overseerrAuth));
}
function listPayload(body) {
    if (Array.isArray(body))
        return body;
    if (Array.isArray(body?.results))
        return body.results;
    if (Array.isArray(body?.servers))
        return body.servers;
    return [];
}
function profilePayload(server) {
    return Array.isArray(server?.profiles) ? server.profiles : Array.isArray(server?.qualityProfiles) ? server.qualityProfiles : [];
}
async function discoverKind(kind) {
    const response = await axios_1.default.get(`${(0, seerrUrl_1.seerrApiBaseUrl)(config_1.config.overseerrUrl)}/settings/${kind}`, { headers: headers(), timeout: 15000 });
    const servers = listPayload(response.data);
    return servers.flatMap((server) => profilePayload(server).map((profile) => ({
        kind,
        serverId: String(server.id ?? server.serverId ?? ""),
        serverName: String(server.name ?? server.hostname ?? `${kind} server`),
        qualityProfileId: String(profile.id ?? profile.qualityProfileId ?? ""),
        qualityProfileName: String(profile.name ?? profile.label ?? `Profile ${profile.id ?? "unknown"}`),
        serverUrl: typeof server.url === "string" ? server.url : undefined,
    })).filter((profile) => profile.serverId && profile.qualityProfileId));
}
async function discoverSeerrArrProfiles() {
    if (!configured())
        return { source: "seerr", configured: false, profiles: [], errors: [] };
    const results = await Promise.all([
        ["radarr", () => discoverKind("radarr")],
        ["sonarr", () => discoverKind("sonarr")],
    ].map(async ([kind, request]) => {
        try {
            return { kind, profiles: await request() };
        }
        catch (error) {
            const status = Number(error?.response?.status);
            return { kind, profiles: [], error: { kind, code: status >= 400 ? "INVALID_RESPONSE" : "UNAVAILABLE", message: status ? `Seerr ${kind} discovery failed with HTTP ${status}` : `Seerr ${kind} discovery unavailable` } };
        }
    }));
    return { source: "seerr", configured: true, profiles: results.flatMap((result) => result.profiles), errors: results.flatMap((result) => result.error ? [result.error] : []) };
}
