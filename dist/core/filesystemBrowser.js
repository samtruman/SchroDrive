"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FilesystemBrowserError = void 0;
exports.browseMountedFilesystem = browseMountedFilesystem;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class FilesystemBrowserError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
exports.FilesystemBrowserError = FilesystemBrowserError;
function withTimeout(operation, label, timeoutMs) {
    return Promise.race([
        operation,
        new Promise((_resolve, reject) => setTimeout(() => reject(new FilesystemBrowserError(504, `Filesystem ${label} timed out`)), timeoutMs)),
    ]);
}
/**
 * Reads a mounted filesystem without blocking Node's event loop. This matters
 * for FUSE/WebDAV mounts, where a cold or unavailable remote directory can
 * take a long time to answer a stat or readdir operation.
 */
async function browseMountedFilesystem(mountBase, requestedPath, timeoutMs = 15000) {
    const safePath = path_1.default.normalize(requestedPath || "/");
    const fullPath = path_1.default.resolve(mountBase, `.${safePath.startsWith("/") ? safePath : `/${safePath}`}`);
    const relativePath = path_1.default.relative(mountBase, fullPath);
    if (relativePath.startsWith("..") || path_1.default.isAbsolute(relativePath)) {
        throw new FilesystemBrowserError(403, "Access denied");
    }
    let stat;
    try {
        stat = await withTimeout(fs_1.default.promises.stat(fullPath), "lookup", timeoutMs);
    }
    catch (err) {
        if (err?.code === "ENOENT") {
            throw new FilesystemBrowserError(404, "Path not found");
        }
        throw err;
    }
    if (stat.isFile()) {
        return {
            type: "file",
            path: safePath,
            name: path_1.default.basename(fullPath),
            size: stat.size,
            modified: stat.mtime,
        };
    }
    const entries = await withTimeout(fs_1.default.promises.readdir(fullPath, { withFileTypes: true }), "directory listing", timeoutMs);
    const items = [];
    for (const entry of entries) {
        const itemPath = path_1.default.join(fullPath, entry.name);
        try {
            const itemStat = await fs_1.default.promises.stat(itemPath);
            items.push({
                name: entry.name,
                path: path_1.default.join(safePath, entry.name),
                type: entry.isDirectory() ? "directory" : "file",
                size: entry.isFile() ? itemStat.size : undefined,
                modified: itemStat.mtime,
            });
        }
        catch {
            items.push({
                name: entry.name,
                path: path_1.default.join(safePath, entry.name),
                type: entry.isDirectory() ? "directory" : "file",
            });
        }
    }
    items.sort((a, b) => {
        if (a.type !== b.type)
            return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return { type: "directory", path: safePath, items };
}
