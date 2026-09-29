import type { DebridProvider, RecoverabilityEvidence, TorrentInfo } from "../providers";
import type { VersionGroup, VersionRecord } from "./versionManager";
import { base32ToHex } from "../core/utils";

export type MigrationExportMode = "FULL_LIBRARY" | "KEEP_ONLY" | "PRIMARY_ONLY" | "REMOTE_ONLY" | "PRIMARY_REMOTE" | "SELECTED";

export interface MigrationExportOptions {
  mode?: MigrationExportMode;
  selectedProviderItemIds?: string[];
  sourceProvider?: string;
}

export function normalizeMigrationExportMode(value?: string): MigrationExportMode {
  switch (String(value || "FULL").toUpperCase()) {
    case "FULL": case "FULL_LIBRARY": return "FULL_LIBRARY";
    case "KEEP": case "KEEP_ONLY": return "KEEP_ONLY";
    case "PRIMARY": case "PRIMARY_ONLY": return "PRIMARY_ONLY";
    case "REMOTE": case "REMOTE_ONLY": return "REMOTE_ONLY";
    case "PRIMARY+REMOTE": case "PRIMARY_REMOTE": case "PRIMARY_REMOTE_ONLY": return "PRIMARY_REMOTE";
    case "SELECTED": return "SELECTED";
    default: return "FULL_LIBRARY";
  }
}

export interface MigrationExportItem {
  provider: string;
  providerItemId: string;
  exportable: boolean;
  exportReason?: "MAGNET_AVAILABLE" | "INFOHASH_AVAILABLE" | "MAGNET_OR_INFOHASH_MISSING";
  recoverability: { recoverable: boolean; status: RecoverabilityEvidence["status"]; basis: "MAGNET" | "INFOHASH" | "NONE" };
  recoverabilityStatus?: RecoverabilityEvidence["status"];
  recoverabilitySource?: RecoverabilityEvidence["source"];
  magnetUri?: string;
  infoHash?: string;
  originalName: string;
  status: string;
  completed: boolean;
  addedAt?: string;
  /** Provider-relative media metadata only; local mount paths are intentionally omitted. */
  mediaFiles: Array<{ id?: string; name: string; size: number }>;
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
  sourceProvider: string;
}

export interface MigrationExportResult {
  magnetsText: string;
  manifest: MigrationManifest;
}

export function canonicalInfoHash(value?: string): string | undefined {
  const hash = value?.trim().replace(/^0x/i, "");
  return hash && /^[a-f0-9]{40}$/i.test(hash) ? hash.toLowerCase() : undefined;
}

export function evaluateRecoverability(item: TorrentInfo): RecoverabilityEvidence {
  if (item.recoverability) return item.recoverability;
  const directHash = canonicalInfoHash(item.infoHash || item.raw?.infoHash || item.raw?.infohash || item.raw?.hash || item.raw?.hashString || item.raw?.data?.hash || item.raw?.data?.hashString);
  if (directHash) return { status: "RECOVERABLE", source: "INFOHASH", infoHash: directHash };
  const magnet = item.magnetUri || rawString(item, ["magnet", "magnetUri", "uri", "url"]);
  if (magnet?.startsWith("magnet:?") && /btih:[^&]+/i.test(magnet)) return { status: "RECOVERABLE", source: "MAGNET" };
  if (item.raw?.recoverable === false || item.raw?.recoverability === "NOT_RECOVERABLE") return { status: "NOT_RECOVERABLE", source: "PROVIDER_CAPABILITY", reason: "Provider item explicitly marked non-recoverable" };
  return { status: "UNKNOWN", source: "PROVIDER_CAPABILITY", reason: "No canonical hash or magnet evidence available" };
}

export async function resolveProviderItemRecoverability(item: TorrentInfo, provider: DebridProvider, cache = new Map<string, RecoverabilityEvidence>()): Promise<RecoverabilityEvidence> {
  const key = `${provider.id}:${item.id}`;
  const cached = cache.get(key);
  if (cached) { item.recoverability = cached; return cached; }
  let evidence = evaluateRecoverability(item);
  if (evidence.status === "UNKNOWN" && provider.getInfoHash) {
    const infoHash = canonicalInfoHash(await provider.getInfoHash(item.id) || undefined);
    if (infoHash) evidence = { status: "RECOVERABLE", source: "PROVIDER_LOOKUP", infoHash };
    else evidence = { status: "UNKNOWN", source: "PROVIDER_LOOKUP", reason: "Provider lookup returned no canonical hash" };
  }
  cache.set(key, evidence);
  item.recoverability = evidence;
  if (evidence.infoHash && !item.infoHash) item.infoHash = evidence.infoHash;
  return evidence;
}

function rawString(item: TorrentInfo, keys: string[]): string | undefined {
  const raw = item.raw && typeof item.raw === "object" ? item.raw : {};
  for (const key of keys) {
    const value = raw[key] ?? (raw.data && typeof raw.data === "object" ? raw.data[key] : undefined);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeHash(value?: string): string | undefined { return canonicalInfoHash(value); }

function extractMagnet(item: TorrentInfo): { magnetUri?: string; infoHash?: string; reason: MigrationExportItem["exportReason"] } {
  const magnetUri = item.magnetUri || rawString(item, ["magnet", "magnetUri", "uri", "url"]);
  if (magnetUri?.startsWith("magnet:?")) {
    const rawHash = magnetUri.match(/btih:([^&]+)/i)?.[1];
    const infoHash = normalizeHash(rawHash) || canonicalInfoHash(base32ToHex(rawHash || "") || undefined);
    return infoHash ? { magnetUri: `magnet:?xt=urn:btih:${infoHash}`, infoHash, reason: "MAGNET_AVAILABLE" } : { magnetUri, reason: "MAGNET_AVAILABLE" };
  }
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
    const recoverability = evaluateRecoverability(item);
    const linked = [...byVersion.values()].filter(({ version }) => version.fingerprint.storage.torrentId === String(item.id));
    return {
      provider: item.raw?.provider || options.sourceProvider || "unknown",
      providerItemId: String(item.id),
      exportable: Boolean(extracted.magnetUri),
      exportReason: extracted.reason,
      recoverability: { recoverable: recoverability.status === "RECOVERABLE", status: recoverability.status, basis: extracted.infoHash ? "INFOHASH" : extracted.magnetUri ? "MAGNET" : "NONE" },
      recoverabilityStatus: recoverability.status,
      recoverabilitySource: recoverability.source,
      magnetUri: extracted.magnetUri,
      infoHash: extracted.infoHash,
      originalName: item.filename || item.name,
      status: item.status,
      completed: item.status === "finished" && item.progress === 100,
      addedAt: item.addedAt?.toISOString(),
      mediaFiles: (item.files || []).map((file) => ({ id: file.id, name: file.name, size: file.size })),
      fingerprints: linked.map(({ version, group }) => safeFingerprint(version, group, slots)),
    };
  });
  const uniqueMagnets = [...new Map(manifests.filter((item) => item.magnetUri).map((item) => [item.infoHash || item.magnetUri, item.magnetUri!])).values()];
  const providers = [...new Set(manifests.map((item) => item.provider).filter(Boolean))];
  const manifest: MigrationManifest = { schemaVersion: "1.0", exportMode: mode, generatedAt: new Date().toISOString(), sourceProvider: providers.length === 1 ? providers[0] : "multi-provider", readOnly: true, items: manifests, exportableItemCount: manifests.filter((item) => item.exportable).length, magnetCount: uniqueMagnets.length };
  return { magnetsText: uniqueMagnets.length ? `${uniqueMagnets.join("\n")}\n` : "", manifest };
}

export function isRecoverable(providerItem: TorrentInfo): boolean {
  return evaluateRecoverability(providerItem).status === "RECOVERABLE";
}
