"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeLibrarySegment = safeLibrarySegment;
exports.canonicalLibraryDirectory = canonicalLibraryDirectory;
exports.canonicalLibraryPath = canonicalLibraryPath;
const node_path_1 = __importDefault(require("node:path"));
function safeLibrarySegment(value) {
    return String(value || "Unknown")
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.]$/, "") || "Unknown";
}
function canonicalLibraryDirectory(root, input) {
    const title = safeLibrarySegment(input.title);
    const folder = input.year ? `${title} (${input.year})` : title;
    if (input.category === "Movies")
        return node_path_1.default.join(root, "Movies", folder);
    if (input.category === "Anime")
        return node_path_1.default.join(root, "Anime", folder);
    return node_path_1.default.join(root, "TV", folder, `Season ${String(input.season ?? 1).padStart(2, "0")}`);
}
function canonicalLibraryPath(root, input) {
    return node_path_1.default.join(canonicalLibraryDirectory(root, input), node_path_1.default.basename(input.sourceFilename));
}
