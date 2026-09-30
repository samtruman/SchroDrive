"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDeleteImpact = buildDeleteImpact;
function buildDeleteImpact(groups, query = "", scope = "all") {
    const result = new Map();
    const q = query.trim().toLowerCase();
    for (const group of groups)
        for (const version of group.versions) {
            const storage = version.fingerprint.storage;
            const text = JSON.stringify({ group, version }).toLowerCase();
            if (q && !text.includes(q))
                continue;
            if (scope === "candidates" && version.decision !== "DELETE_CANDIDATE")
                continue;
            if (scope === "attention" && version.decision !== "REVIEW")
                continue;
            const key = `${storage.provider}:${storage.torrentId}`;
            const item = result.get(key) || { providerItemId: storage.torrentId, provider: storage.provider, state: "READY", onlyCopy: true, versions: [], affectedGroups: [], reasons: [] };
            item.versions.push({ id: version.id, title: group.identity.title, season: group.identity.season, episode: group.identity.episode, decision: version.decision, files: [{ path: storage.path, size: storage.size }] });
            if (!item.affectedGroups.includes(group.id))
                item.affectedGroups.push(group.id);
            if (version.decision === "KEEP")
                item.onlyCopy = false;
            if (version.decision === "REVIEW") {
                item.state = "BLOCKED";
                item.reasons.push("Review or identity blocker requires operator decision");
            }
            if (version.decision === "DELETE_CANDIDATE" && storage.recoverability?.status !== "RECOVERABLE") {
                item.state = "BLOCKED";
                item.reasons.push("Provider item is not confirmed recoverable");
            }
            result.set(key, item);
        }
    for (const item of result.values()) {
        if (item.onlyCopy)
            item.reasons.push("ONLY COPY — No alternative version identified");
        if (item.versions.some((version) => version.decision === "KEEP"))
            item.state = "PARTIALLY_REDUNDANT";
        if (!item.reasons.length)
            item.reasons.push("ProviderItem is the physical delete unit; executor is disabled");
    }
    return [...result.values()].sort((a, b) => a.providerItemId.localeCompare(b.providerItemId));
}
