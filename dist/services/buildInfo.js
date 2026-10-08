"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBuildInfo = getBuildInfo;
const node_fs_1 = __importDefault(require("node:fs"));
function readManifest() {
    const file = process.env.SCHRODRIVE_BUILD_INFO_FILE || "/config/validation-runtime/BUILD_INFO.json";
    try {
        return JSON.parse(node_fs_1.default.readFileSync(file, "utf8"));
    }
    catch {
        return {};
    }
}
function getBuildInfo() {
    const manifest = readManifest();
    return {
        version: process.env.SCHRODRIVE_VERSION || "0.11.5",
        commit: process.env.SCHRODRIVE_BUILD_COMMIT || manifest.commit || "unknown",
        builtAt: process.env.SCHRODRIVE_BUILD_TIME || manifest.builtAt || null,
        image: process.env.SCHRODRIVE_IMAGE || manifest.image || null,
        runtimeCommit: process.env.SCHRODRIVE_RUNTIME_COMMIT || manifest.runtimeCommit || null,
        frontendCommit: process.env.SCHRODRIVE_FRONTEND_COMMIT || manifest.frontendCommit || null,
    };
}
