"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchDeleteExecutionError = void 0;
exports.executeVersionManagerDelete = executeVersionManagerDelete;
exports.executeVersionManagerDeleteBatch = executeVersionManagerDeleteBatch;
const deleteImpact_1 = require("./deleteImpact");
class BatchDeleteExecutionError extends Error {
    constructor(message, completedIds, failedProviderItemId, cause) {
        super(message);
        this.completedIds = completedIds;
        this.failedProviderItemId = failedProviderItemId;
        this.cause = cause;
        this.name = "BatchDeleteExecutionError";
    }
}
exports.BatchDeleteExecutionError = BatchDeleteExecutionError;
function revalidatedImpacts(request) {
    return request.selection?.length
        ? (0, deleteImpact_1.buildSelectedDeleteImpact)(request.groups, request.selection)
        : (0, deleteImpact_1.buildDeleteImpact)(request.groups, "", "all");
}
/** Revalidates the physical unit immediately before optionally deleting it. */
async function executeVersionManagerDelete(request) {
    const impact = revalidatedImpacts(request).find((item) => item.provider === request.provider.id && item.providerItemId === request.providerItemId);
    if (!impact)
        throw new Error("ProviderItem is no longer physically eligible for deletion");
    if (impact.state !== "READY" || impact.onlyCopy || impact.protectedByKeep)
        throw new Error("ProviderItem is no longer physically eligible for deletion; final safety check failed");
    const current = await request.provider.listTorrents();
    if (!current.some((item) => String(item.id) === request.providerItemId))
        throw new Error("ProviderItem no longer exists at the provider");
    if (request.dryRun)
        return { status: "VALIDATED", executed: false, provider: request.provider.id, providerItemId: request.providerItemId, impact };
    if (request.confirmation !== request.providerItemId)
        throw new Error("Live deletion confirmation does not match the ProviderItem");
    await request.provider.deleteTorrent(request.providerItemId);
    return { status: "DELETED", executed: true, provider: request.provider.id, providerItemId: request.providerItemId, impact };
}
/** Preflights the complete selection, then deletes sequentially and stops on the first provider error. */
async function executeVersionManagerDeleteBatch(request) {
    const providerItemIds = [...new Set(request.providerItemIds.map(String).filter(Boolean))];
    if (providerItemIds.length === 0 || providerItemIds.length > 100)
        throw new Error("Select between 1 and 100 ProviderItems");
    const impacts = revalidatedImpacts(request);
    const impactById = new Map(impacts.filter((item) => item.provider === request.provider.id).map((item) => [item.providerItemId, item]));
    for (const id of providerItemIds) {
        const impact = impactById.get(id);
        if (!impact)
            throw new Error(`ProviderItem ${id} is no longer physically eligible for deletion`);
        if (impact.state !== "READY" || impact.onlyCopy || impact.protectedByKeep)
            throw new Error(`ProviderItem ${id} failed the final safety check`);
    }
    const current = new Set((await request.provider.listTorrents()).map((item) => String(item.id)));
    const missing = providerItemIds.find((id) => !current.has(id));
    if (missing)
        throw new Error(`ProviderItem ${missing} no longer exists at the provider`);
    const results = providerItemIds.map((id) => ({
        status: "VALIDATED",
        executed: false,
        provider: request.provider.id,
        providerItemId: id,
        impact: impactById.get(id),
    }));
    if (request.dryRun)
        return { status: "VALIDATED", executed: false, provider: request.provider.id, providerItemIds, results };
    if (request.confirmation !== JSON.stringify(providerItemIds))
        throw new Error("Live batch deletion confirmation does not match the selected ProviderItems");
    const completedIds = [];
    for (const id of providerItemIds) {
        try {
            await request.provider.deleteTorrent(id);
            completedIds.push(id);
        }
        catch (error) {
            throw new BatchDeleteExecutionError(error?.message || `Provider deletion failed for ${id}`, completedIds, id, error);
        }
    }
    return { status: "DELETED", executed: true, provider: request.provider.id, providerItemIds, results: results.map((result) => ({ ...result, status: "DELETED", executed: true })) };
}
