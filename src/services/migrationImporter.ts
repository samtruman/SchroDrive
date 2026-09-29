import type { TorrentInfo } from "../providers";
import { canonicalInfoHash } from "./migrationExporter";
import { base32ToHex } from "../core/utils";

export type ImportPlanStatus =
  | "ALREADY_PRESENT"
  | "ALREADY_PRESENT_EQUIVALENT_HASH"
  | "READY_TO_IMPORT"
  | "INVALID_MAGNET"
  | "MISSING_HASH"
  | "UNSUPPORTED"
  | "CONFLICT"
  | "REVIEW";

export interface ImportPlanItem {
  source: "MANIFEST" | "MAGNETS";
  index: number;
  status: ImportPlanStatus;
  providerItemId?: string;
  infoHash?: string;
  originalName?: string;
  reason: string;
}

export interface ImportPlan {
  readOnly: true;
  sourceFormat: "MANIFEST" | "MAGNETS" | "MANIFEST_AND_MAGNETS";
  schemaVersion?: string;
  items: ImportPlanItem[];
  counts: Record<ImportPlanStatus, number>;
  errors: string[];
}

export interface MigrationImportInput {
  manifest?: unknown;
  magnetsText?: string;
}

function emptyCounts(): Record<ImportPlanStatus, number> {
  return {
    ALREADY_PRESENT: 0, ALREADY_PRESENT_EQUIVALENT_HASH: 0, READY_TO_IMPORT: 0,
    INVALID_MAGNET: 0, MISSING_HASH: 0, UNSUPPORTED: 0, CONFLICT: 0, REVIEW: 0,
  };
}

function hashFromMagnet(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim().toLowerCase().startsWith("magnet:?")) return undefined;
  const match = value.match(/[?&]xt=urn:btih:([^&]+)/i);
  if (!match) return undefined;
  const raw = match[1];
  const hex = canonicalInfoHash(raw);
  if (hex) return hex;
  if (!/^[a-z2-7]{32}$/i.test(raw)) return undefined;
  return canonicalInfoHash(base32ToHex(raw) || undefined);
}

function manifestHash(item: any): { hash?: string; invalid: boolean } {
  const explicit = item?.canonicalInfohash ?? item?.infoHash;
  if (explicit !== undefined) return { hash: canonicalInfoHash(String(explicit)), invalid: true };
  const magnet = item?.canonicalMagnet ?? item?.magnetUri;
  if (magnet === undefined) return { invalid: false };
  return { hash: hashFromMagnet(magnet), invalid: true };
}

function inventoryHashes(inventory: TorrentInfo[]): Map<string, TorrentInfo[]> {
  const result = new Map<string, TorrentInfo[]>();
  for (const item of inventory) {
    const hash = canonicalInfoHash(item.infoHash) || hashFromMagnet(item.magnetUri);
    if (!hash) continue;
    const entries = result.get(hash) || [];
    entries.push(item);
    result.set(hash, entries);
  }
  return result;
}

function classify(source: ImportPlanItem["source"], index: number, hash: string | undefined, providerItemId: string | undefined, originalName: string | undefined, inventoryByHash: Map<string, TorrentInfo[]>): ImportPlanItem {
  if (!hash) return { source, index, status: "MISSING_HASH", providerItemId, originalName, reason: "No canonical infohash is available" };
  const matches = inventoryByHash.get(hash) || [];
  if (providerItemId && matches.some((item) => String(item.id) === providerItemId)) return { source, index, status: "ALREADY_PRESENT", providerItemId, infoHash: hash, originalName, reason: "Provider item and infohash already exist" };
  if (matches.length) return { source, index, status: "ALREADY_PRESENT_EQUIVALENT_HASH", providerItemId, infoHash: hash, originalName, reason: "An existing provider item has the same infohash" };
  return { source, index, status: "READY_TO_IMPORT", providerItemId, infoHash: hash, originalName, reason: "No matching infohash exists in the current inventory" };
}

export function analyzeMigrationImport(input: MigrationImportInput, inventory: TorrentInfo[] = []): ImportPlan {
  const hasManifest = input.manifest !== undefined;
  const hasMagnets = typeof input.magnetsText === "string";
  const sourceFormat = hasManifest && hasMagnets ? "MANIFEST_AND_MAGNETS" : hasManifest ? "MANIFEST" : "MAGNETS";
  const plan: ImportPlan = { readOnly: true, sourceFormat, items: [], counts: emptyCounts(), errors: [] };
  const byHash = inventoryHashes(inventory);
  if (hasManifest) {
    const manifest = input.manifest as any;
    plan.schemaVersion = typeof manifest?.schemaVersion === "string" ? manifest.schemaVersion : undefined;
    if (!manifest || !Array.isArray(manifest.items)) plan.errors.push("Manifest must contain an items array");
    else if (manifest.schemaVersion !== "1.0") plan.errors.push("Unsupported manifest schema version");
    else manifest.items.forEach((item: any, index: number) => {
      const extracted = manifestHash(item);
      const row = extracted.invalid && !extracted.hash
        ? { source: "MANIFEST" as const, index, status: "INVALID_MAGNET" as const, providerItemId: typeof item?.providerItemId === "string" ? item.providerItemId : undefined, originalName: typeof item?.originalName === "string" ? item.originalName : undefined, reason: "Manifest magnet or infohash is invalid" }
        : classify("MANIFEST", index, extracted.hash, typeof item?.providerItemId === "string" ? item.providerItemId : undefined, typeof item?.originalName === "string" ? item.originalName : undefined, byHash);
      plan.items.push(row);
    });
  }
  if (hasMagnets) {
    const seen = new Set<string>();
    for (const [index, line] of input.magnetsText!.split(/\r?\n/).map((value, i) => [i, value.trim()] as const)) {
      if (!line) continue;
      const hash = hashFromMagnet(line);
      if (hash && seen.has(hash)) continue;
      if (hash) seen.add(hash);
      plan.items.push(hash ? classify("MAGNETS", index, hash, undefined, undefined, byHash) : { source: "MAGNETS", index, status: "INVALID_MAGNET", reason: "Line is not a valid magnet with a supported btih" });
    }
  }
  for (const item of plan.items) plan.counts[item.status]++;
  return plan;
}
