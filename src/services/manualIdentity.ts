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
    const override = versionOverride || getManualIdentityOverride(version.fingerprint.identity);
    return override ? { ...version, fingerprint: { ...version.fingerprint, identity: applyManualIdentityOverride(version.fingerprint.identity, override) } } : version;
  });
}

export function manualOverrideFromReview(value: ManualIdentityOverride): ManualIdentityOverride {
  return { ...value };
}
