"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.providerReconciliationRoutes = providerReconciliationRoutes;
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
function providerReconciliationRoutes(providerId = "alldebrid") {
    const sourcePathPrefix = `${config_1.config.providerReconciliationMountBase.replace(/\/$/, '')}/${providerId}`;
    return {
        movies: { kind: "radarr", baseUrl: config_1.config.providerReconciliationRadarrUrl, apiKey: config_1.config.providerReconciliationRadarrApiKey, sourcePathPrefix, importMode: "Copy", symlinkLibraryPath: config_1.config.providerReconciliationMoviesLibraryPath || undefined },
        shows: { kind: "sonarr", baseUrl: config_1.config.providerReconciliationSonarrUrl, apiKey: config_1.config.providerReconciliationSonarrApiKey, sourcePathPrefix, importMode: "Copy", symlinkLibraryPath: config_1.config.providerReconciliationShowsLibraryPath || undefined },
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
    await (0, organizer_1.organizeOnce)();
    return { events: events.length, organizerCompleted: true };
}
/** Registers the worker created during application startup for on-demand refreshes. */
function registerProviderReconciliationWorker(worker) {
    activeProviderReconciliationWorker = worker;
}
