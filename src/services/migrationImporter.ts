import type { DebridProvider, TorrentInfo } from "../providers";
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

export interface BulkImportProgress {
  total: number;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  retrying: number;
  remaining: number;
  elapsedMs: number;
  currentInfoHash?: string;
}

export interface BulkImportResult {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  results: Array<{ infoHash?: string; status: "IMPORTED" | "SKIPPED_ALREADY_PRESENT" | "SKIPPED_NOT_READY" | "FAILED"; providerItemId?: string; reason?: string; attempts?: number }>;
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

export function getRecoverableManifestItem(item: unknown): { infoHash: string; magnetUri: string } | undefined {
  const extracted = manifestHash(item as any);
  if (!extracted.hash) return undefined;
  return { infoHash: extracted.hash, magnetUri: `magnet:?xt=urn:btih:${extracted.hash}` };
}

export async function executeMigrationImportItem(item: unknown, provider: DebridProvider): Promise<{ providerItemId: string; infoHash: string; magnetUri: string }> {
  const recoverable = getRecoverableManifestItem(item);
  if (!recoverable) throw new Error("Migration item is not recoverable");
  const result = await provider.addMagnet(recoverable.magnetUri, typeof (item as any)?.originalName === "string" ? (item as any).originalName : undefined);
  return { providerItemId: String(result.id || ""), ...recoverable };
}

function retryableImportError(error: unknown): boolean {
  const message = String((error as any)?.message || error || "").toLowerCase();
  return /429|rate.?limit|timeout|timed out|network|econn|5\d\d|temporar/.test(message);
}

function retryDelayMs(error: unknown, attempt: number): number {
  const message = String((error as any)?.message || error || "");
  const seconds = message.match(/retry in\s+(\d+(?:\.\d+)?)s/i)?.[1];
  if (seconds) return Math.min(60000, Math.max(1000, Math.ceil(Number(seconds) * 1000)));
  return Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Executes only the READY items supplied by the current ImportPlan. The
 * target inventory is refreshed immediately before every item, so rerunning
 * after interruption is naturally idempotent and resumable.
 */
export async function executeMigrationImportBulk(
  items: ImportPlanItem[],
  provider: DebridProvider,
  options: {
    targetInventory: () => Promise<TorrentInfo[]>;
    onProgress?: (progress: BulkImportProgress) => void;
    maxAttempts?: number;
  },
): Promise<BulkImportResult> {
  const started = Date.now();
  const ready = items.filter((item) => item.status === "READY_TO_IMPORT");
  const result: BulkImportResult = { total: ready.length, imported: 0, skipped: 0, failed: 0, results: [] };
  let processed = 0;
  let retrying = 0;
  const emit = (currentInfoHash?: string) => options.onProgress?.({ total: result.total, processed, imported: result.imported, skipped: result.skipped, failed: result.failed, retrying, remaining: result.total - processed, elapsedMs: Date.now() - started, currentInfoHash });

  for (const item of ready) {
    const currentInfoHash = item.infoHash;
    emit(currentInfoHash);
    if (!provider.isConfigured()) throw new Error("Target provider became unavailable during bulk import");
    const currentPlan = analyzeMigrationImport({ manifest: { schemaVersion: "1.0", items: [item] } }, await options.targetInventory());
    const current = currentPlan.items[0];
    if (!current || current.status !== "READY_TO_IMPORT") {
      result.skipped++;
      result.results.push({ infoHash: currentInfoHash, status: current?.status === "ALREADY_PRESENT" || current?.status === "ALREADY_PRESENT_EQUIVALENT_HASH" ? "SKIPPED_ALREADY_PRESENT" : "SKIPPED_NOT_READY", reason: current?.reason || "Item is no longer READY_TO_IMPORT" });
      processed++;
      emit(currentInfoHash);
      continue;
    }

    const maxAttempts = options.maxAttempts ?? 3;
    let succeeded = false;
    let lastError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const added = await executeMigrationImportItem(item, provider);
        result.imported++;
        result.results.push({ infoHash: added.infoHash, status: "IMPORTED", providerItemId: added.providerItemId, attempts: attempt });
        succeeded = true;
        break;
      } catch (error: any) {
        lastError = error?.message || String(error);
        if (!retryableImportError(error) || attempt >= maxAttempts) break;
        retrying++;
        emit(currentInfoHash);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error, attempt)));
        retrying--;
      }
    }
    if (!succeeded) {
      result.failed++;
      result.results.push({ infoHash: currentInfoHash, status: "FAILED", reason: lastError, attempts: maxAttempts });
    }
    processed++;
    emit(currentInfoHash);
  }
  return result;
}

function inventoryHashes(inventory: TorrentInfo[]): Map<string, TorrentInfo[]> {
  const result = new Map<string, TorrentInfo[]>();
  for (const item of inventory) {
    const hash = torrentInfoHash(item);
    if (!hash) continue;
    const entries = result.get(hash) || [];
    entries.push(item);
    result.set(hash, entries);
  }
  return result;
}

function torrentInfoHash(item: TorrentInfo): string | undefined {
  const direct = canonicalInfoHash(item.infoHash) || hashFromMagnet(item.magnetUri);
  if (direct) return direct;
  const find = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    for (const [key, nested] of Object.entries(value)) {
      if (/^(infohash|info_hash|hash|hashString)$/i.test(key) && typeof nested === "string") {
        const hash = canonicalInfoHash(nested) || hashFromMagnet(nested);
        if (hash) return hash;
      }
      const child = find(nested);
      if (child) return child;
    }
    return undefined;
  };
  return find(item.raw);
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
  const manifestHashes = new Set<string>();
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
      if (extracted.hash) manifestHashes.add(extracted.hash);
    });
  }
  if (hasMagnets) {
    const seen = new Set<string>();
    for (const [index, line] of input.magnetsText!.split(/\r?\n/).map((value, i) => [i, value.trim()] as const)) {
      if (!line) continue;
      const hash = hashFromMagnet(line);
      // When both formats are supplied, manifest records are authoritative
      // item records and magnets.txt is only their portable fallback. Do not
      // count the same ProviderItem/hash twice.
      if (hash && manifestHashes.has(hash)) continue;
      if (hash && seen.has(hash)) continue;
      if (hash) seen.add(hash);
      plan.items.push(hash ? classify("MAGNETS", index, hash, undefined, undefined, byHash) : { source: "MAGNETS", index, status: "INVALID_MAGNET", reason: "Line is not a valid magnet with a supported btih" });
    }
  }
  for (const item of plan.items) plan.counts[item.status]++;
  return plan;
}
