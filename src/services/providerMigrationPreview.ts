import { randomUUID } from "node:crypto";
import type { DebridProvider } from "../providers";
import { exportMigrationLibrary, resolveProviderItemRecoverability } from "./migrationExporter";
import { analyzeMigrationImport, type ImportPlanItem } from "./migrationImporter";
import { effectiveMigrationStatus, type MigrationStateAuditLike } from "./migrationState";
import { migrationRouteLevel, providerMigrationCapabilities } from "./providerMigrationCapabilities";

type Audit = MigrationStateAuditLike & { infoHash: string };
export function validateMigrationRoute(source: DebridProvider, target: DebridProvider) {
  if (source.id === target.id) throw new Error("Choose two different providers");
  if (!source.isConfigured() || !target.isConfigured()) throw new Error("Both providers must be configured");
  if (!migrationRouteLevel(providerMigrationCapabilities(source), providerMigrationCapabilities(target)).supported) throw new Error("Provider route does not support migration");
}

export async function previewProviderMigration(source: DebridProvider, target: DebridProvider, audit: Audit[]) {
  validateMigrationRoute(source, target);
  const [sourceInventory, targetInventory] = await Promise.all([source.listTorrents(), target.listTorrents()]);
  const cache = new Map();
  // Reads only. No backup files and no provider add/delete calls.
  for (const item of sourceInventory) await resolveProviderItemRecoverability(item, source, cache);
  const exported = exportMigrationLibrary(sourceInventory, [], { mode: "FULL_LIBRARY", sourceProvider: source.id });
  const plan = analyzeMigrationImport({ manifest: exported.manifest }, targetInventory);
  const latest = new Map<string, Audit>();
  for (const entry of audit) if (!latest.has(entry.infoHash)) latest.set(entry.infoHash, entry);
  const items = plan.items.map(item => {
    const effective = effectiveMigrationStatus(item.status, item.infoHash ? latest.get(item.infoHash) : undefined);
    return { ...item, effectiveStatus: effective.status, reason: effective.reason || item.reason };
  });
  return { readOnly: true, sourceProvider: source.id, targetProvider: target.id,
    generatedAt: new Date().toISOString(), sourceItems: sourceInventory.length, targetItems: targetInventory.length,
    items, counts: items.reduce<Record<string, number>>((counts, item) => { counts[item.effectiveStatus] = (counts[item.effectiveStatus] || 0) + 1; return counts; }, {}) };
}

type Preview = Awaited<ReturnType<typeof previewProviderMigration>>;
const previews = new Map<string, { plan: Preview; expiresAt: number; jobId?: string }>();
export function rememberMigrationPreview(plan: Preview) {
  for (const [id, value] of previews) if (value.expiresAt <= Date.now()) previews.delete(id);
  if (previews.size >= 20) previews.delete(previews.keys().next().value!);
  const previewId = randomUUID(), expiresAt = Date.now() + 15 * 60_000;
  previews.set(previewId, { plan, expiresAt });
  return { ...plan, previewId, expiresAt: new Date(expiresAt).toISOString() };
}
export function selectMigrationPreview(previewId: string, source: string, target: string, hashes: unknown, audit: Audit[]) {
  const stored = previews.get(previewId);
  if (!stored || stored.expiresAt <= Date.now()) throw new Error("Preview expired; load a fresh provider preview");
  if (stored.plan.sourceProvider !== source || stored.plan.targetProvider !== target) throw new Error("Preview does not match the selected providers");
  if (!Array.isArray(hashes) || !hashes.length || hashes.some(hash => typeof hash !== "string")) throw new Error("Select at least one eligible item");
  const latest = new Map<string, Audit>();
  for (const entry of audit) if (!latest.has(entry.infoHash)) latest.set(entry.infoHash, entry);
  const items: ImportPlanItem[] = [...new Set(hashes)].map(hash => {
    const item = stored.plan.items.find(item => item.infoHash === hash);
    if (!item || item.effectiveStatus !== "READY_TO_IMPORT" || effectiveMigrationStatus(item.status, latest.get(hash))?.status !== "READY_TO_IMPORT") throw new Error("Selection contains an ineligible item; refresh the preview");
    return item;
  });
  return { items, jobId: stored.jobId, markStarted: (jobId: string) => { stored.jobId = jobId; } };
}
