import { registry, type DebridProvider, type TorrentFile, type TorrentInfo, type VirtualDirectory } from "../providers";
import { resolveProviderItemRecoverability, type RecoverabilityResolutionMetrics } from "./migrationExporter";
import { fingerprintTorrent, type VersionRecord } from "./versionManager";

export type InventoryFileTreeSource = "PROVIDER_FILE_TREE" | "INLINE_PROVIDER_FILES" | "ITEM_NAME_FALLBACK";

export interface MediaManagerInventoryStats {
  durationMs: number;
  providers: number;
  providerListCalls: number;
  fileTreeFetches: number;
  providerItems: number;
  fileTreeItems: number;
  inlineFileItems: number;
  nameFallbackItems: number;
  mediaFiles: number;
  versions: number;
  recoverability: RecoverabilityResolutionMetrics;
}

function fileKey(file: Pick<TorrentFile, "path" | "name" | "size">): string {
  return `${String(file.path || file.name).trim().toLowerCase()}\u0000${file.size || 0}`;
}

function dedupeFiles(files: TorrentFile[]): TorrentFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = fileKey(file);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeDirectoryFiles(directory: VirtualDirectory | undefined): TorrentFile[] {
  if (!directory?.files?.length) return [];
  return dedupeFiles(directory.files.map((file) => ({
    id: String(file.id || file.name),
    name: file.name,
    path: file.name,
    size: file.size,
    selected: true,
  })));
}

function providerItemWithFiles(item: TorrentInfo, files: TorrentFile[], source: InventoryFileTreeSource): TorrentInfo {
  return {
    ...item,
    files,
    raw: item.raw && typeof item.raw === "object"
      ? { ...item.raw, mediaManagerFileTreeSource: source }
      : { mediaManagerFileTreeSource: source },
  };
}

/**
 * Builds the Media Manager inventory from ProviderItems and their actual media
 * files. File-tree resolution is performed once per provider per scan and the
 * result is reused for every derived fingerprint/version.
 */
export async function loadMediaManagerInventory(providers: DebridProvider[] = registry.configured(), stats?: MediaManagerInventoryStats): Promise<VersionRecord[]> {
  const startedAt = Date.now();
  const metrics = stats?.recoverability || { requested: 0, cacheHits: 0, providerLookups: 0, resolved: 0, unknown: 0 };
  if (stats) {
    stats.providers = providers.length;
    stats.recoverability = metrics;
  }
  const resolved: VersionRecord[] = [];
  const recoverabilityCache = new Map<string, Awaited<ReturnType<typeof resolveProviderItemRecoverability>>>();

  for (const provider of providers) {
    if (stats) stats.providerListCalls++;
    const items = await provider.listTorrents();
    if (stats) stats.providerItems += items.length;
    if (stats) stats.fileTreeFetches++;
    const directories = await provider.fetchDirectories();
    const directoriesByItem = new Map<string, VirtualDirectory>();
    for (const directory of directories) {
      const key = String(directory.id);
      if (!directoriesByItem.has(key)) directoriesByItem.set(key, directory);
    }

    for (const item of items) {
      await resolveProviderItemRecoverability(item, provider, recoverabilityCache, metrics);

      const treeFiles = normalizeDirectoryFiles(directoriesByItem.get(String(item.id)));
      if (treeFiles.length > 0) {
        if (stats) { stats.fileTreeItems++; stats.mediaFiles += treeFiles.length; }
        resolved.push(...fingerprintTorrent(providerItemWithFiles(item, treeFiles, "PROVIDER_FILE_TREE"), provider.id));
        continue;
      }

      const inlineFiles = dedupeFiles(Array.isArray(item.files) ? item.files : []);
      if (inlineFiles.length > 0) {
        if (stats) { stats.inlineFileItems++; stats.mediaFiles += inlineFiles.length; }
        resolved.push(...fingerprintTorrent(providerItemWithFiles(item, inlineFiles, "INLINE_PROVIDER_FILES"), provider.id));
        continue;
      }

      if (stats) stats.nameFallbackItems++;
      resolved.push(...fingerprintTorrent(providerItemWithFiles(item, [], "ITEM_NAME_FALLBACK"), provider.id));
    }
  }

  if (stats) { stats.versions = resolved.length; stats.durationMs = Date.now() - startedAt; }
  return resolved;
}
