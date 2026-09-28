import type { TorrentInfo } from "../providers";
import type { VersionGroup, VersionRecord } from "./versionManager";

export type MigrationExportMode = "FULL_LIBRARY" | "KEEP_ONLY" | "PRIMARY_ONLY" | "REMOTE_ONLY" | "PRIMARY_REMOTE" | "SELECTED";

export interface MigrationExportOptions {
  mode?: MigrationExportMode;
  selectedProviderItemIds?: string[];
}

export interface MigrationExportItem {
  provider: string;
  providerItemId: string;
  exportable: boolean;
  exportReason?: "MAGNET_AVAILABLE" | "INFOHASH_AVAILABLE" | "MAGNET_OR_INFOHASH_MISSING";
  magnetUri?: string;
  infoHash?: string;
  originalName: string;
  status: string;
  completed: boolean;
  addedAt?: string;
  mediaFiles: Array<{ id?: string; path: string; name: string; size: number }>;
  fingerprints: Array<{
    id: string;
    contentIdentity?: VersionRecord["fingerprint"]["identity"];
    groupId?: string;
    decision?: string;
    slots: string[];
  }>;
}

export interface MigrationManifest {
  schemaVersion: "1.0";
  exportMode: MigrationExportMode;
  generatedAt: string;
  readOnly: true;
  items: MigrationExportItem[];
  exportableItemCount: number;
  magnetCount: number;
}

export interface MigrationExportResult {
  magnetsText: string;
  manifest: MigrationManifest;
}

function rawString(item: TorrentInfo, keys: string[]): string | undefined {
  const raw = item.raw && typeof item.raw === "object" ? item.raw : {};
  for (const key of keys) {
    const value = raw[key] ?? (raw.data && typeof raw.data === "object" ? raw.data[key] : undefined);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeHash(value?: string): string | undefined {
  const hash = value?.trim().replace(/^0x/i, "");
  return hash && /^[a-f0-9]{32,64}$/i.test(hash) ? hash.toLowerCase() : undefined;
}

function extractMagnet(item: TorrentInfo): { magnetUri?: string; infoHash?: string; reason: MigrationExportItem["exportReason"] } {
  const magnetUri = item.magnetUri || rawString(item, ["magnet", "magnetUri", "uri", "url"]);
  if (magnetUri?.startsWith("magnet:?")) return { magnetUri, infoHash: normalizeHash(magnetUri.match(/btih:([^&]+)/i)?.[1]), reason: "MAGNET_AVAILABLE" };
  const infoHash = normalizeHash(item.infoHash || rawString(item, ["infoHash", "infohash", "hash", "hashString"]));
  return infoHash ? { magnetUri: `magnet:?xt=urn:btih:${infoHash}`, infoHash, reason: "INFOHASH_AVAILABLE" } : { reason: "MAGNET_OR_INFOHASH_MISSING" };
}

function slotIds(groups: VersionGroup[]): { primary: Set<string>; remote: Set<string> } {
  const primary = new Set<string>();
  const remote = new Set<string>();
  for (const group of groups) {
    for (const profileId of ["primary", "remote"]) {
      const winner = group.versions
        .flatMap((version) => version.evaluations.filter((evaluation) => evaluation.profileId === profileId && evaluation.eligible).map((evaluation) => ({ version, evaluation })))
        .sort((a, b) => (b.evaluation.score ?? -Infinity) - (a.evaluation.score ?? -Infinity))[0];
      if (winner) (profileId === "primary" ? primary : remote).add(winner.version.id);
    }
  }
  return { primary, remote };
}

function safeFingerprint(version: VersionRecord, group: VersionGroup | undefined, slots: { primary: Set<string>; remote: Set<string> }): MigrationExportItem["fingerprints"][number] {
  const assigned: string[] = [];
  if (slots.primary.has(version.id)) assigned.push("PRIMARY");
  if (slots.remote.has(version.id)) assigned.push("REMOTE");
  return { id: version.id, contentIdentity: version.fingerprint.identity, groupId: group?.id, decision: "decision" in version ? (version as VersionRecord & { decision?: string }).decision : undefined, slots: assigned };
}

export function exportMigrationLibrary(inventory: TorrentInfo[], groups: VersionGroup[] = [], options: MigrationExportOptions = {}): MigrationExportResult {
  const mode = options.mode ?? "FULL_LIBRARY";
  const selected = new Set(options.selectedProviderItemIds ?? []);
  const slots = slotIds(groups);
  const byVersion = new Map<string, { version: VersionRecord; group: VersionGroup }>();
  for (const group of groups) for (const version of group.versions) byVersion.set(version.id, { version, group });

  const manifests = inventory.filter((item) => {
    if (mode === "SELECTED") return selected.has(String(item.id));
    if (mode === "FULL_LIBRARY") return true;
    const versions = [...byVersion.values()].filter(({ version }) => version.fingerprint.storage.torrentId === String(item.id));
    if (mode === "KEEP_ONLY") return versions.some(({ version }) => (version as VersionRecord & { decision?: string }).decision === "KEEP");
    if (mode === "PRIMARY_ONLY") return versions.some(({ version }) => slots.primary.has(version.id));
    if (mode === "REMOTE_ONLY") return versions.some(({ version }) => slots.remote.has(version.id));
    return versions.some(({ version }) => slots.primary.has(version.id) || slots.remote.has(version.id));
  }).map((item): MigrationExportItem => {
    const extracted = extractMagnet(item);
    const linked = [...byVersion.values()].filter(({ version }) => version.fingerprint.storage.torrentId === String(item.id));
    return {
      provider: item.raw?.provider || "unknown",
      providerItemId: String(item.id),
      exportable: Boolean(extracted.magnetUri),
      exportReason: extracted.reason,
      magnetUri: extracted.magnetUri,
      infoHash: extracted.infoHash,
      originalName: item.filename || item.name,
      status: item.status,
      completed: item.status === "finished" && item.progress === 100,
      addedAt: item.addedAt?.toISOString(),
      mediaFiles: (item.files || []).map((file) => ({ id: file.id, path: file.path, name: file.name, size: file.size })),
      fingerprints: linked.map(({ version, group }) => safeFingerprint(version, group, slots)),
    };
  });
  const uniqueMagnets = [...new Map(manifests.filter((item) => item.magnetUri).map((item) => [item.infoHash || item.magnetUri, item.magnetUri!])).values()];
  const manifest: MigrationManifest = { schemaVersion: "1.0", exportMode: mode, generatedAt: new Date().toISOString(), readOnly: true, items: manifests, exportableItemCount: manifests.filter((item) => item.exportable).length, magnetCount: uniqueMagnets.length };
  return { magnetsText: uniqueMagnets.length ? `${uniqueMagnets.join("\n")}\n` : "", manifest };
}
