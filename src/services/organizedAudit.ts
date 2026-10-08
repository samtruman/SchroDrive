import fs from "node:fs";
import path from "node:path";
import { config } from "../core/config";

export type OrganizedAuditIssue = {
  type: "DUPLICATE_SOURCE_LINK" | "DUPLICATE_FOLDER_VARIANT";
  severity: "warning";
  category: string;
  title: string;
  paths: string[];
  detail: string;
  action: "REVIEW";
};

function normalizeFolderName(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\s*\((?:19|20|21)\d{2}\)\s*$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function walkLinks(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) result.push(full);
      else if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return result;
}

export function auditOrganizedLibrary() {
  const roots = ["Movies", "TV", "Anime"].map((category) => ({ category, root: path.join(config.organizedBase, category) }));
  const issues: OrganizedAuditIssue[] = [];
  const sourceLinks = new Map<string, string[]>();
  const folderVariants = new Map<string, { category: string; folders: string[] }>();
  let scannedLinks = 0;
  let scannedFolders = 0;

  for (const { category, root } of roots) {
    if (!fs.existsSync(root)) continue;
    let children: fs.Dirent[];
    try { children = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      scannedFolders++;
      const key = category + ":" + normalizeFolderName(child.name);
      const variant = folderVariants.get(key) || { category, folders: [] };
      variant.folders.push(path.join(root, child.name));
      folderVariants.set(key, variant);
    }
    for (const link of walkLinks(root)) {
      scannedLinks++;
      let target: string;
      try { target = fs.realpathSync.native(link); } catch { target = fs.readlinkSync(link); }
      const links = sourceLinks.get(target) || [];
      links.push(link);
      sourceLinks.set(target, links);
    }
  }

  for (const [target, links] of sourceLinks) {
    if (links.length < 2) continue;
    issues.push({
      type: "DUPLICATE_SOURCE_LINK",
      severity: "warning",
      category: "organized",
      title: path.basename(target),
      paths: links,
      detail: "The same source is exposed by more than one organized symlink.",
      action: "REVIEW",
    });
  }
  for (const [key, variant] of folderVariants) {
    if (variant.folders.length < 2) continue;
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
    readOnly: true as const,
    organizedBase: config.organizedBase,
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
