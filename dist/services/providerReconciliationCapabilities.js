"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessReconciliationCapabilities = assessReconciliationCapabilities;
/**
 * Computes the safe mode without assuming that providers share an API.
 * Change detection is a worker-side snapshot diff and therefore requires both
 * a status listing and a file tree. Recent polling is optional; full polling
 * is the safe minimum for a polling worker.
 */
function assessReconciliationCapabilities(capabilities) {
    const hasPolling = capabilities.statusList && capabilities.fileTree && capabilities.fullSnapshot;
    const hasRecent = hasPolling && capabilities.recentSnapshot;
    const changeDetection = hasPolling && capabilities.changeDetection;
    const hasPush = capabilities.pushEvents;
    if (!hasPolling && !hasPush) {
        return { capabilities: { ...capabilities, changeDetection }, mode: 'disabled', reason: 'provider exposes neither a complete snapshot contract nor push events' };
    }
    if (hasPolling) {
        return { capabilities: { ...capabilities, recentSnapshot: hasRecent, changeDetection }, mode: hasRecent ? 'polling-hybrid' : 'polling-full-only', reason: hasRecent ? 'frequent recent polling plus periodic full polling; local snapshot diff is authoritative' : 'periodic full polling with local snapshot diff; recent polling is unavailable' };
    }
    if (hasPush) {
        return { capabilities: { ...capabilities, changeDetection }, mode: 'push-only', reason: 'provider exposes push events but not a complete polling snapshot contract' };
    }
    // Keep an exhaustive fallback for future capability extensions. The current
    // branches above make this unreachable, but it must remain a valid mode.
    return { capabilities: { ...capabilities, recentSnapshot: hasRecent, changeDetection }, mode: 'polling-full-only', reason: 'fallback polling mode with worker-side snapshot diff' };
}
