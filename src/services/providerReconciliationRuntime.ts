import { config } from "../core/config";
import { registry } from "../providers";
import { parseMediaFilename } from "./mediaParser";
import { isOrganizerReviewPending, recordOrganizerReview, resolveOrganizerReviewAutomatically } from "./organizerReview";
import { organizeOnce } from "./organizer";
import {
  ProviderSnapshotSource,
  ProviderReconciliationIntake,
  ProviderReconciliationWorker,
  HttpArrClient,
  SqliteIntakeStateStore,
  type ArrRoute,
  type ArrDeletePropagationResult,
  type DirectFileEvent,
  propagateDeletedFile,
} from "./providerReconciliation";
import type { DeleteImpact } from "./deleteImpact";

export function providerReconciliationRoutes(providerId = "alldebrid"): { movies: ArrRoute; shows: ArrRoute } {
  const sourcePathPrefix = `${config.providerReconciliationMountBase.replace(/\/$/, '')}/${providerId}`;
  return {
    movies: { kind: "radarr", baseUrl: config.providerReconciliationRadarrUrl, apiKey: config.providerReconciliationRadarrApiKey, sourcePathPrefix, importMode: "Copy", symlinkLibraryPath: config.providerReconciliationMoviesLibraryPath || undefined },
    shows: { kind: "sonarr", baseUrl: config.providerReconciliationSonarrUrl, apiKey: config.providerReconciliationSonarrApiKey, sourcePathPrefix, importMode: "Copy", symlinkLibraryPath: config.providerReconciliationShowsLibraryPath || undefined },
  };
}

export async function propagateProviderDeletion(impact: DeleteImpact): Promise<ArrDeletePropagationResult> {
  const routes = providerReconciliationRoutes(impact.provider);
  const paths = impact.versions.flatMap((version) => version.files.map((file) => file.path).filter((value): value is string => Boolean(value)));
  if (paths.length === 0) return { removedSymlinks: 0, warning: "Deleted ProviderItem has no tracked media paths" };
  const isShow = impact.versions.some((version) => version.identity.kind === "episode" || version.identity.season !== undefined || version.identity.episode !== undefined);
  const route = isShow ? routes.shows : routes.movies;
  const results: ArrDeletePropagationResult[] = [];
  for (const [index, filePath] of [...new Set(paths)].entries()) {
    const event: DirectFileEvent = {
      provider: impact.provider,
      providerItemId: impact.providerItemId,
      action: "deleted",
      path: filePath,
      tree: [],
      sourceCategory: isShow ? "Shows" : "Movies",
      observedAt: new Date().toISOString(),
      stableDedupeKey: `delete:${impact.provider}:${impact.providerItemId}:${filePath}`,
    };
    results.push(await propagateDeletedFile(route, event, { refreshArr: index === 0 }));
  }
  return {
    removedSymlinks: results.reduce((sum, result) => sum + result.removedSymlinks, 0),
    arrEntityId: results.find((result) => result.arrEntityId)?.arrEntityId,
    arrCommandId: results.find((result) => result.arrCommandId)?.arrCommandId,
    warning: results.find((result) => result.warning)?.warning,
  };
}

/** Builds the opt-in provider reconciliation worker without changing provider lifecycle services. */
export function createProviderReconciliationWorker(): ProviderReconciliationWorker | undefined {
  if (!config.providerReconciliationRadarrUrl || !config.providerReconciliationRadarrApiKey || !config.providerReconciliationSonarrUrl || !config.providerReconciliationSonarrApiKey) {
    console.warn("[provider-reconciliation] Radarr/Sonarr routes are incomplete; worker disabled");
    return undefined;
  }
  const arr = new HttpArrClient();
  const store = new SqliteIntakeStateStore();
  const intakes = config.providers.flatMap((providerId) => {
    const provider = registry.get(providerId);
    if (!provider || !provider.isConfigured()) return [];
    const source = new ProviderSnapshotSource(provider);
    return [new ProviderReconciliationIntake(source, arr, store, {
      dryRun: config.providerReconciliationDryRun,
      routeFor: (category, sourceProvider) => category === "Movies" ? providerReconciliationRoutes(sourceProvider || providerId).movies : providerReconciliationRoutes(sourceProvider || providerId).shows,
      onSuccess: async (event) => {
        resolveOrganizerReviewAutomatically(event.path, `Provider reconciliation (${event.provider}) matched ARR and completed`);
      },
      onDeleted: async (event) => {
        resolveOrganizerReviewAutomatically(event.path, `Provider reconciliation (${event.provider}) item is no longer present`);
      },
      shouldRetry: (event) => isOrganizerReviewPending(event.path),
      onReview: async (event, error) => {
        const parsed = parseMediaFilename(event.path, event.path);
        recordOrganizerReview(event.path, { ...parsed, status: parsed.status === "matched" ? "ambiguous" : parsed.status, reason: `Provider reconciliation (${event.provider}): ${error.message}` });
      },
    })];
  });
  if (intakes.length === 0) {
    console.warn("[provider-reconciliation] no configured providers available; worker disabled");
    return undefined;
  }
  return new ProviderReconciliationWorker(intakes, {
    recentMs: Math.max(1000, config.providerReconciliationRecentIntervalMs), fullMs: Math.max(1000, config.providerReconciliationFullIntervalMs), recentLimit: Math.max(1, config.providerReconciliationRecentLimit), runFullOnStart: config.providerReconciliationRunFullOnStart,
  });
}

export function startProviderReconciliation(): ProviderReconciliationWorker | undefined {
  if (!config.providerReconciliationEnabled) {
    console.log("[provider-reconciliation] disabled (PROVIDER_RECONCILIATION_ENABLED=false)");
    return undefined;
  }
  const worker = createProviderReconciliationWorker();
  if (!worker) return undefined;
  worker.start();
  console.log("[provider-reconciliation] started; provider intake is read-only and provider deletion/repair is not used");
  return worker;
}

/**
 * Runs the lightweight provider refresh used by the Dashboard.
 *
 * This deliberately does not run the Version Manager inventory scan. The
 * Dashboard only needs current provider activity and newly visible organised
 * links; the full policy/profile inventory remains an explicit Media Manager
 * operation.
 */
let activeProviderReconciliationWorker: ProviderReconciliationWorker | undefined;

export async function refreshProviderActivity(): Promise<{ events: number; organizerCompleted: boolean }> {
  const events = activeProviderReconciliationWorker
    ? await activeProviderReconciliationWorker.runRecent()
    : [];
  await organizeOnce();
  return { events: events.length, organizerCompleted: true };
}

/** Registers the worker created during application startup for on-demand refreshes. */
export function registerProviderReconciliationWorker(worker: ProviderReconciliationWorker | undefined): void {
  activeProviderReconciliationWorker = worker;
}
