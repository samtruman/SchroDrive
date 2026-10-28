"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.providerReconciliationRoutes = providerReconciliationRoutes;
exports.normalizeProviderItemId = normalizeProviderItemId;
exports.propagateProviderDeletion = propagateProviderDeletion;
exports.createProviderReconciliationWorker = createProviderReconciliationWorker;
exports.startProviderReconciliation = startProviderReconciliation;
exports.refreshProviderActivity = refreshProviderActivity;
exports.registerProviderReconciliationWorker = registerProviderReconciliationWorker;
const config_1 = require("../core/config");
const providers_1 = require("../providers");
const mediaParser_1 = require("./mediaParser");
const organizerReview_1 = require("./organizerReview");
const organizer_1 = require("./organizer");
const providerReconciliation_1 = require("./providerReconciliation");
let organizerRefreshScheduled = false;
let organizerRefreshPromise = Promise.resolve();
const pendingOrganizerPaths = new Set();
/**
 * Refresh the organised view after provider reconciliation without running a
 * full scan once per file in a season pack. Calls arriving during the same
 * short window share one scan, so the Dashboard sees new links promptly.
 */
function scheduleOrganizerRefresh(paths = []) {
    for (const sourcePath of paths) {
        if (sourcePath?.trim())
            pendingOrganizerPaths.add(sourcePath.trim());
    }
    if (organizerRefreshScheduled)
        return organizerRefreshPromise;
    organizerRefreshScheduled = true;
    organizerRefreshPromise = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const changedPaths = [...pendingOrganizerPaths];
        pendingOrganizerPaths.clear();
        try {
            if (changedPaths.length > 0)
                await (0, organizer_1.organizeOnce)({ sourcePaths: changedPaths });
        }
        catch (error) {
            console.error("[provider-reconciliation] organized view refresh failed", error?.message || String(error));
        }
        finally {
            organizerRefreshScheduled = false;
        }
    })();
    return organizerRefreshPromise;
}
function providerReconciliationRoutes(providerId = "alldebrid") {
    const sourcePathPrefix = `${config_1.config.providerReconciliationMountBase.replace(/\/$/, '')}/${providerId}`;
    const stagingRoot = config_1.config.arrDownloadsPath.replace(/\/$/, '');
    const provider = providers_1.registry.get(providerId);
    const providerItemStatus = provider?.getTorrentStatus
        ? async (providerItemId) => {
            const prefix = `${providerId}:`;
            const id = normalizeProviderItemId(providerItemId, providerId);
            return (await provider.getTorrentStatus(id)).status;
        }
        : undefined;
    return {
        movies: { kind: "radarr", baseUrl: config_1.config.providerReconciliationRadarrUrl, apiKey: config_1.config.providerReconciliationRadarrApiKey, sourcePathPrefix, importMode: "Copy", symlinkLibraryPath: config_1.config.providerReconciliationMoviesLibraryPath || undefined, stagingPath: stagingRoot ? stagingRoot + "/radarr" : undefined, mountReadyPollMs: stagingRoot ? config_1.config.providerReconciliationMountReadyPollMs : undefined, providerItemStatus },
        shows: { kind: "sonarr", baseUrl: config_1.config.providerReconciliationSonarrUrl, apiKey: config_1.config.providerReconciliationSonarrApiKey, sourcePathPrefix, importMode: "Copy", symlinkLibraryPath: config_1.config.providerReconciliationShowsLibraryPath || undefined, stagingPath: stagingRoot ? stagingRoot + "/sonarr" : undefined, mountReadyPollMs: stagingRoot ? config_1.config.providerReconciliationMountReadyPollMs : undefined, providerItemStatus },
    };
}
function normalizeProviderItemId(providerItemId, providerId) {
    const prefix = `${providerId}:`;
    let id = providerItemId;
    while (id.startsWith(prefix))
        id = id.slice(prefix.length);
    return id;
}
async function propagateProviderDeletion(impact) {
    const routes = providerReconciliationRoutes(impact.provider);
    const paths = impact.versions.flatMap((version) => version.files.map((file) => file.path).filter((value) => Boolean(value)));
    if (paths.length === 0)
        return { removedSymlinks: 0, warning: "Deleted ProviderItem has no tracked media paths" };
    const isShow = impact.versions.some((version) => version.identity.kind === "episode" || version.identity.season !== undefined || version.identity.episode !== undefined);
    const route = isShow ? routes.shows : routes.movies;
    const results = [];
    for (const [index, filePath] of [...new Set(paths)].entries()) {
        const event = {
            provider: impact.provider,
            providerItemId: impact.providerItemId,
            action: "deleted",
            path: filePath,
            tree: [],
            sourceCategory: isShow ? "Shows" : "Movies",
            observedAt: new Date().toISOString(),
            stableDedupeKey: `delete:${impact.provider}:${impact.providerItemId}:${filePath}`,
        };
        results.push(await (0, providerReconciliation_1.propagateDeletedFile)(route, event, { refreshArr: index === 0 }));
    }
    return {
        removedSymlinks: results.reduce((sum, result) => sum + result.removedSymlinks, 0),
        arrEntityId: results.find((result) => result.arrEntityId)?.arrEntityId,
        arrCommandId: results.find((result) => result.arrCommandId)?.arrCommandId,
        warning: results.find((result) => result.warning)?.warning,
    };
}
/** Builds the opt-in provider reconciliation worker without changing provider lifecycle services. */
function createProviderReconciliationWorker() {
    if (!config_1.config.providerReconciliationRadarrUrl || !config_1.config.providerReconciliationRadarrApiKey || !config_1.config.providerReconciliationSonarrUrl || !config_1.config.providerReconciliationSonarrApiKey) {
        console.warn("[provider-reconciliation] Radarr/Sonarr routes are incomplete; worker disabled");
        return undefined;
    }
    const arr = new providerReconciliation_1.HttpArrClient();
    const store = new providerReconciliation_1.SqliteIntakeStateStore();
    const intakes = config_1.config.providers.flatMap((providerId) => {
        const provider = providers_1.registry.get(providerId);
        if (!provider || !provider.isConfigured())
            return [];
        const source = new providerReconciliation_1.ProviderSnapshotSource(provider);
        return [new providerReconciliation_1.ProviderReconciliationIntake(source, arr, store, {
                dryRun: config_1.config.providerReconciliationDryRun,
                routeFor: (category, sourceProvider) => category === "Movies" ? providerReconciliationRoutes(sourceProvider || providerId).movies : providerReconciliationRoutes(sourceProvider || providerId).shows,
                onSuccess: async (event) => {
                    await scheduleOrganizerRefresh([event.path]);
                    (0, organizerReview_1.resolveOrganizerReviewAutomatically)(event.path, `Provider reconciliation (${event.provider}) matched ARR and completed`);
                },
                onDeleted: async (event) => {
                    const route = event.sourceCategory === "Movies"
                        ? providerReconciliationRoutes(event.provider).movies
                        : providerReconciliationRoutes(event.provider).shows;
                    await (0, providerReconciliation_1.propagateDeletedFile)(route, event, { refreshArr: true });
                    (0, organizerReview_1.resolveOrganizerReviewAutomatically)(event.path, `Provider reconciliation (${event.provider}) item is no longer present`);
                },
                shouldRetry: (event) => (0, organizerReview_1.isOrganizerReviewPending)(event.path),
                onReview: async (event, error) => {
                    const parsed = (0, mediaParser_1.parseMediaFilename)(event.path, event.path);
                    (0, organizerReview_1.recordOrganizerReview)(event.path, { ...parsed, status: parsed.status === "matched" ? "ambiguous" : parsed.status, reason: `Provider reconciliation (${event.provider}): ${error.message}` });
                },
            })];
    });
    if (intakes.length === 0) {
        console.warn("[provider-reconciliation] no configured providers available; worker disabled");
        return undefined;
    }
    return new providerReconciliation_1.ProviderReconciliationWorker(intakes, {
        recentMs: Math.max(1000, config_1.config.providerReconciliationRecentIntervalMs), fullMs: Math.max(1000, config_1.config.providerReconciliationFullIntervalMs), recentLimit: Math.max(1, config_1.config.providerReconciliationRecentLimit), runFullOnStart: config_1.config.providerReconciliationRunFullOnStart,
    });
}
function startProviderReconciliation() {
    if (!config_1.config.providerReconciliationEnabled) {
        console.log("[provider-reconciliation] disabled (PROVIDER_RECONCILIATION_ENABLED=false)");
        return undefined;
    }
    const worker = createProviderReconciliationWorker();
    if (!worker)
        return undefined;
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
let activeProviderReconciliationWorker;
async function refreshProviderActivity() {
    const events = activeProviderReconciliationWorker
        ? await activeProviderReconciliationWorker.runRecent()
        : [];
    if (events.length > 0)
        await (0, organizer_1.organizeOnce)({ sourcePaths: events.map((event) => event.path) });
    return { events: events.length, organizerCompleted: true };
}
/** Registers the worker created during application startup for on-demand refreshes. */
function registerProviderReconciliationWorker(worker) {
    activeProviderReconciliationWorker = worker;
}
