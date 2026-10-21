import { getDb } from "../core/db";
import { normalizeMediaTitle } from "./mediaParser";
import type { ContentIdentity, VersionRecord } from "./versionManager";

export interface ManualIdentityOverride {
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
  title?: string;
  originalTitle?: string;
  year?: number;
  kind?: "movie" | "episode";
  season?: number;
  episode?: number;
  originalLanguage?: string;
}

export type IdentityKeyInput = { kind?: string; title?: string; year?: number; season?: number; episode?: number; tmdbId?: string };

export function identityOverrideKey(identity: IdentityKeyInput): string {
  const kind = identity.kind === "anime-episode" ? "episode" : identity.kind || "unknown";
  return [kind, normalizeMediaTitle(identity.title || ""), identity.year || "", identity.season ?? "", identity.episode ?? ""].join(":");
}

function readOverride(row: any): ManualIdentityOverride | undefined {
  try { return row ? JSON.parse(row.override_json) as ManualIdentityOverride : undefined; }
  catch { return undefined; }
}

function versionOverrideKey(versionId: string): string {
  return `version:${versionId}`;
}

/** Source key uses the full provider-relative path, never a basename or inferred title. */
export function sourceOverrideKey(provider: string, sourcePath: string): string | undefined {
  if (!provider || !sourcePath) return undefined;
  const normalized = sourcePath.replace(/\\/g, "/");
  const marker = `/${provider.toLowerCase()}/`;
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  let relative = markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
  if (markerIndex >= 0) relative = relative.replace(/^(?:__all__|shows|movies)\//i, "");
  else if (relative.startsWith("/")) return undefined;
  if (!relative || relative.split("/").some((part) => part === "..")) return undefined;
  return `source:${provider.toLowerCase()}:${relative}`;
}

export function saveManualIdentityOverrideForSource(provider: string, sourcePath: string, override: ManualIdentityOverride): string {
  const key = sourceOverrideKey(provider, sourcePath);
  if (!key) throw new Error("Provider source path cannot be identified safely");
  return saveOverrideByKey(key, override);
}

export function clearManualIdentityOverrideForSource(provider: string, sourcePath: string): void {
  const key = sourceOverrideKey(provider, sourcePath);
  if (key) getDb().prepare("DELETE FROM version_manager_identity_overrides WHERE identity_key = ?").run(key);
}

function saveOverrideByKey(key: string, override: ManualIdentityOverride): string {
  getDb().prepare("INSERT OR REPLACE INTO version_manager_identity_overrides (identity_key, override_json, updated_at) VALUES (?, ?, ?)")
    .run(key, JSON.stringify(override), new Date().toISOString());
  return key;
}

export function saveManualIdentityOverride(identity: IdentityKeyInput, override: ManualIdentityOverride): string {
  return saveOverrideByKey(identityOverrideKey(identity), override);
}

export function saveManualIdentityOverrideForVersion(versionId: string, override: ManualIdentityOverride): string {
  return saveOverrideByKey(versionOverrideKey(versionId), override);
}

export function clearManualIdentityOverrideForVersion(versionId: string): void {
  getDb().prepare("DELETE FROM version_manager_identity_overrides WHERE identity_key = ?").run(versionOverrideKey(versionId));
}

export function clearManualIdentityOverride(identity: IdentityKeyInput): void {
  const database = getDb();
  const directKey = identityOverrideKey(identity);
  database.prepare("DELETE FROM version_manager_identity_overrides WHERE identity_key = ?").run(directKey);
  const rows = database.prepare("SELECT identity_key, override_json FROM version_manager_identity_overrides").all() as any[];
  for (const row of rows) {
    const override = readOverride(row);
    if ((identity as any).tmdbId && override?.tmdbId === (identity as any).tmdbId) database.prepare("DELETE FROM version_manager_identity_overrides WHERE identity_key = ?").run(row.identity_key);
  }
}

export function getManualIdentityOverride(identity: IdentityKeyInput): ManualIdentityOverride | undefined {
  return readOverride(getDb().prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key = ?").get(identityOverrideKey(identity)));
}

/**
 * Resolves a manual identity for provider reconciliation. Source overrides are
 * authoritative; the unique title-compatible override is only a fallback for
 * release files whose embedded year/title differs from the resolved identity.
 */
export function getManualIdentityOverrideForProviderSource(provider: string, sourcePath: string, identity: IdentityKeyInput): ManualIdentityOverride | undefined {
  const database = getDb();
  const sourceKey = sourceOverrideKey(provider, sourcePath);
  if (sourceKey) {
    const sourceOverride = readOverride(database.prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key = ?").get(sourceKey));
    if (sourceOverride) return sourceOverride;
  }
  const direct = getManualIdentityOverride(identity);
  if (direct) return direct;
  const title = normalizeMediaTitle(identity.title || "");
  if (!title || identity.kind !== "movie") return undefined;
  const candidates = (database.prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key NOT LIKE 'version:%' AND identity_key NOT LIKE 'source:%'").all() as any[])
    .map((row) => readOverride(row))
    .filter((override): override is ManualIdentityOverride => Boolean(override?.tmdbId && (override.kind || "movie") === "movie"))
    .filter((override) => {
      const candidateTitles = [override.title, override.originalTitle].filter(Boolean).map((value) => normalizeMediaTitle(String(value)));
      return candidateTitles.some((candidate) => candidate && (title.includes(candidate) || candidate.includes(title)));
    });
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function applyManualIdentityOverride(identity: ContentIdentity, override: ManualIdentityOverride): ContentIdentity {
  const title = override.title || identity.title;
  return {
    ...identity,
    ...(override.tmdbId ? { tmdbId: override.tmdbId } : {}),
    ...(override.imdbId ? { imdbId: override.imdbId } : {}),
    ...(override.tvdbId ? { tvdbId: override.tvdbId } : {}),
    ...(title ? { title, normalizedTitle: normalizeMediaTitle(title) } : {}),
    ...(override.originalTitle ? { originalTitle: override.originalTitle } : {}),
    ...(override.year !== undefined ? { year: override.year } : {}),
    ...(override.kind ? { kind: override.kind } : {}),
    ...(override.season !== undefined ? { season: override.season } : {}),
    ...(override.episode !== undefined ? { episode: override.episode } : {}),
    ...(override.originalLanguage ? { originalLanguage: override.originalLanguage } : {}),
    confidence: 1,
    source: "manual",
    resolutionStatus: "resolved",
    provenance: {
      ...(identity.provenance || {}),
      ...(override.tmdbId ? { tmdbId: "MANUAL" } : {}),
      ...(override.title ? { title: "MANUAL", normalizedTitle: "MANUAL" } : {}),
      ...(override.year !== undefined ? { year: "MANUAL" } : {}),
      ...(override.originalLanguage ? { originalLanguage: "MANUAL" } : {}),
    },
  };
}

export function applyManualIdentityOverrides(versions: VersionRecord[]): VersionRecord[] {
  const database = getDb();
  return versions.map((version) => {
    const versionOverride = readOverride(database.prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key = ?").get(versionOverrideKey(version.id)));
    const storage = version.fingerprint.storage;
    const sourceKey = sourceOverrideKey(storage.provider, storage.path);
    const sourceOverride = sourceKey ? readOverride(database.prepare("SELECT override_json FROM version_manager_identity_overrides WHERE identity_key = ?").get(sourceKey)) : undefined;
    const override = versionOverride || sourceOverride || getManualIdentityOverride(version.fingerprint.identity);
    return override ? { ...version, fingerprint: { ...version.fingerprint, identity: applyManualIdentityOverride(version.fingerprint.identity, override) } } : version;
  });
}

export function manualOverrideFromReview(value: ManualIdentityOverride): ManualIdentityOverride {
  return { ...value };
}
