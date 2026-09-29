"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeVersionRecords = probeVersionRecords;
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const db_1 = require("../core/db");
const config_1 = require("../core/config");
const DEFAULT_PROBE_CONCURRENCY = 4;
function number(value) {
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
}
function parseRate(value) {
    if (typeof value === "number")
        return value;
    if (typeof value !== "string")
        return undefined;
    const parts = value.split("/").map(Number);
    if (parts.length === 2 && parts[1])
        return parts[0] / parts[1];
    return number(value);
}
function language(value) {
    if (typeof value !== "string" || !value)
        return undefined;
    const normalized = value.toLowerCase().slice(0, 3);
    return { ita: "ita", eng: "eng", en: "eng", it: "ita", spa: "spa", es: "spa", fra: "fra", fr: "fra", deu: "deu", de: "deu" }[normalized] || normalized;
}
function isAtmos(stream) {
    const text = `${stream.codec_name || ""} ${stream.codec_long_name || ""} ${stream.profile || ""} ${stream.tags ? JSON.stringify(stream.tags) : ""}`.toLowerCase();
    return text.includes("atmos");
}
function streamAudio(stream) {
    const tags = (stream.tags || {});
    return {
        language: language(tags.language) || "und",
        codec: typeof stream.codec_name === "string" ? stream.codec_name.toUpperCase() : undefined,
        channels: number(stream.channels),
        bitrate: number(stream.bit_rate),
        atmos: isAtmos(stream),
        provenance: { language: "FFPROBE", codec: "FFPROBE", channels: "FFPROBE", bitrate: "FFPROBE", atmos: "FFPROBE" },
    };
}
function streamSubtitle(stream) {
    const tags = (stream.tags || {});
    return {
        language: language(tags.language) || "und",
        codec: typeof stream.codec_name === "string" ? stream.codec_name : undefined,
        forced: String(tags.forced || "").toLowerCase() === "1" || String(tags.title || "").toLowerCase().includes("forced"),
        provenance: { language: "FFPROBE", codec: "FFPROBE", forced: "FFPROBE" },
    };
}
function applyProbe(version, payload, ffprobeVersion) {
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const format = (payload.format || {});
    const tags = (format.tags || {});
    if (video) {
        const width = number(video.width);
        const height = number(video.height);
        const resolution = height ? `${height}p` : undefined;
        const sideData = Array.isArray(video.side_data_list) ? JSON.stringify(video.side_data_list) : "";
        const text = `${video.codec_name || ""} ${video.codec_long_name || ""} ${video.profile || ""} ${sideData} ${JSON.stringify(video.tags || {})}`.toLowerCase();
        version.fingerprint.video = {
            ...version.fingerprint.video,
            resolution: width && (width >= 3500 || (height || 0) >= 2000) ? "2160p" : width && (width >= 1800 || (height || 0) >= 1000) ? "1080p" : resolution || version.fingerprint.video.resolution,
            width,
            height,
            codec: typeof video.codec_name === "string" ? video.codec_name.toUpperCase() : version.fingerprint.video.codec,
            bitrate: number(video.bit_rate) || number(format.bit_rate),
            bitDepth: number(video.bits_per_raw_sample) || number(video.bits_per_sample),
            hdr10: text.includes("hdr10") || text.includes("smpte2084"),
            hdr10Plus: text.includes("hdr10+") || text.includes("hdr10plus"),
            dolbyVision: text.includes("dolby vision") || text.includes("dovi") || text.includes("dvhe") || text.includes("dvh1"),
            hdrFormat: text.includes("dolby") || text.includes("dovi") ? "Dolby Vision" : text.includes("hdr") || text.includes("smpte2084") ? "HDR" : undefined,
            container: typeof format.format_name === "string" ? format.format_name.split(",")[0] : undefined,
            provenance: { resolution: "FFPROBE", codec: "FFPROBE", bitrate: "FFPROBE", bitDepth: "FFPROBE", hdr10: "FFPROBE", hdr10Plus: "FFPROBE", dolbyVision: "FFPROBE", hdrFormat: "FFPROBE", container: "FFPROBE" },
        };
    }
    const audio = streams.filter((stream) => stream.codec_type === "audio").map(streamAudio);
    const subtitles = streams.filter((stream) => stream.codec_type === "subtitle").map(streamSubtitle);
    if (audio.length)
        version.fingerprint.audio = audio;
    version.fingerprint.subtitles = subtitles;
    version.fingerprint.probe = { status: "complete", tool: "ffprobe", version: ffprobeVersion };
    if (typeof tags.TMDB === "string" || typeof tags.tmdb_id === "string") {
        version.fingerprint.identity.tmdbId = String(tags.TMDB || tags.tmdb_id);
        version.fingerprint.identity.provenance = { ...version.fingerprint.identity.provenance, tmdbId: "FFPROBE" };
    }
}
async function runProbe(filePath) {
    const child = Bun.spawn({ cmd: [process.env.FFPROBE_BIN || "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0)
        return { error: stderr.trim() || `ffprobe exited ${exitCode}` };
    try {
        const payload = JSON.parse(stdout);
        return { payload, version: typeof payload.program_version === "string" ? payload.program_version : undefined };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : "Invalid ffprobe JSON" };
    }
}
let mountFileIndex;
async function buildMountFileIndex() {
    const index = new Map();
    const root = node_path_1.default.join(config_1.config.mountBase, "alldebrid", "__all__");
    try {
        const glob = new Bun.Glob("**/*.{mkv,mp4,m4v,avi,ts}");
        for await (const relative of glob.scan({ cwd: root, onlyFiles: true })) {
            const absolute = node_path_1.default.join(root, relative);
            index.set(node_path_1.default.basename(relative).toLowerCase(), absolute);
        }
    }
    catch { /* provider may not expose a local filesystem */ }
    return index;
}
async function resolvePath(version) {
    const raw = version.fingerprint.storage.path;
    const mount = config_1.config.mountBase;
    const candidates = [raw, node_path_1.default.join(mount, raw), node_path_1.default.join(mount, version.fingerprint.storage.provider, raw), node_path_1.default.join(mount, version.fingerprint.storage.provider, "__all__", raw)];
    for (const candidate of candidates) {
        try {
            if ((await (0, promises_1.stat)(candidate)).isFile())
                return candidate;
        }
        catch { /* try next candidate */ }
    }
    mountFileIndex || (mountFileIndex = buildMountFileIndex());
    const indexed = (await mountFileIndex).get(node_path_1.default.basename(raw).toLowerCase());
    if (indexed)
        return indexed;
    return undefined;
}
async function probeVersionRecords(versions, options = {}) {
    const stats = { requested: versions.length, probed: 0, cacheHits: 0, cacheMisses: 0, unavailable: 0, errors: 0 };
    const database = (0, db_1.getDb)();
    const memo = new Map();
    const probeOne = async (version) => {
        const filePath = await resolvePath(version);
        if (!filePath) {
            version.fingerprint.probe = { status: "unavailable", tool: "filename", error: "media path not accessible from configured mount" };
            stats.unavailable++;
            return;
        }
        const fileStat = await (0, promises_1.stat)(filePath);
        // Remote/VFS mounts can report a fresh mtime on every metadata read even
        // when the provider object and byte size are unchanged. Size + canonical
        // path is therefore the stable identity for this read-only probe cache.
        const cacheKey = `${filePath}:${fileStat.size}`;
        let work = memo.get(cacheKey);
        if (!work) {
            work = (async () => {
                const cached = database.prepare("SELECT fingerprint_json, ffprobe_version, status FROM version_manager_probe_cache WHERE cache_key = ?").get(cacheKey);
                if (cached?.status === "complete")
                    return { status: "complete", fingerprint: JSON.parse(cached.fingerprint_json), cacheHit: true };
                stats.cacheMisses++;
                const result = await runProbe(filePath);
                if (!result.payload)
                    return { status: "error", error: result.error };
                const fingerprint = structuredClone(version.fingerprint);
                applyProbe({ ...version, fingerprint }, result.payload, result.version);
                database.prepare("INSERT OR REPLACE INTO version_manager_probe_cache (cache_key, path, fingerprint_json, ffprobe_version, probed_at, status) VALUES (?, ?, ?, ?, ?, ?)").run(cacheKey, filePath, JSON.stringify(fingerprint), result.version || null, new Date().toISOString(), "complete");
                stats.probed++;
                return { status: "complete", fingerprint };
            })();
            memo.set(cacheKey, work);
        }
        const result = await work;
        if (result.cacheHit)
            stats.cacheHits++;
        if (result.status === "complete" && result.fingerprint)
            version.fingerprint = structuredClone(result.fingerprint);
        else {
            version.fingerprint.probe = { status: "error", tool: "ffprobe", error: result.error };
            stats.errors++;
        }
    };
    let next = 0;
    const worker = async () => { while (true) {
        const index = next++;
        if (index >= versions.length)
            return;
        await probeOne(versions[index]);
    } };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency || DEFAULT_PROBE_CONCURRENCY), versions.length || 1) }, worker));
    return stats;
}
