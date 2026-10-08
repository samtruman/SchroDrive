"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditOrganizedLibrary = auditOrganizedLibrary;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("../core/config");
function normalizeFolderName(value) {
    return value
        .toLocaleLowerCase()
        .replace(/\s*\((?:19|20|21)\d{2}\)\s*$/, "")
        .replace(/[^\p{L}\p{N}]+/gu, "");
}
function walkLinks(root) {
    if (!node_fs_1.default.existsSync(root))
        return [];
    const result = [];
    const visit = (current) => {
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(current, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = node_path_1.default.join(current, entry.name);
            if (entry.isSymbolicLink())
                result.push(full);
            else if (entry.isDirectory())
                visit(full);
        }
    };
    visit(root);
    return result;
}
function auditOrganizedLibrary() {
    const roots = ["Movies", "TV", "Anime"].map((category) => ({ category, root: node_path_1.default.join(config_1.config.organizedBase, category) }));
    const issues = [];
    const sourceLinks = new Map();
    const folderVariants = new Map();
    let scannedLinks = 0;
    let scannedFolders = 0;
    for (const { category, root } of roots) {
        if (!node_fs_1.default.existsSync(root))
            continue;
        let children;
        try {
            children = node_fs_1.default.readdirSync(root, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const child of children) {
            if (!child.isDirectory())
                continue;
            scannedFolders++;
            const key = category + ":" + normalizeFolderName(child.name);
            const variant = folderVariants.get(key) || { category, folders: [] };
            variant.folders.push(node_path_1.default.join(root, child.name));
            folderVariants.set(key, variant);
        }
        for (const link of walkLinks(root)) {
            scannedLinks++;
            let target;
            try {
                target = node_fs_1.default.realpathSync.native(link);
            }
            catch {
                target = node_fs_1.default.readlinkSync(link);
            }
            const links = sourceLinks.get(target) || [];
            links.push(link);
            sourceLinks.set(target, links);
        }
    }
    for (const [target, links] of sourceLinks) {
        if (links.length < 2)
            continue;
        issues.push({
            type: "DUPLICATE_SOURCE_LINK",
            severity: "warning",
            category: "organized",
            title: node_path_1.default.basename(target),
            paths: links,
            detail: "The same source is exposed by more than one organized symlink.",
            action: "REVIEW",
        });
    }
    for (const [key, variant] of folderVariants) {
        if (variant.folders.length < 2)
            continue;
        issues.push({
            type: "DUPLICATE_FOLDER_VARIANT",
            severity: "warning",
            category: variant.category,
            title: key.split(":").slice(1).join(":"),
            paths: variant.folders,
            detail: "Equivalent organized folders differ only by a trailing year or naming variant.",
            action: "REVIEW",
        });
    }
    return {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        organizedBase: config_1.config.organizedBase,
        summary: {
            issues: issues.length,
            duplicateSourceLinks: issues.filter((issue) => issue.type === "DUPLICATE_SOURCE_LINK").length,
            duplicateFolderVariants: issues.filter((issue) => issue.type === "DUPLICATE_FOLDER_VARIANT").length,
            scannedLinks,
            scannedFolders,
        },
        issues,
    };
}
