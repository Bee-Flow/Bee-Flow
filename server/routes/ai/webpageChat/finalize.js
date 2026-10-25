// @typecheck noImplicitAny
/**
 * Webpage chat: the end of one turn (routes/ai/webpageChat.js). The
 * tool-driven slot edits persisted with one AI version per turn, the
 * dependents index refreshed, and the un-tokeniser's tail flushed.
 */

'use strict';

const log = require('../../../telemetry/log');
const webpageStore = require('../../../stores/webpageStore');
const versionFacts = require('../../../core/webpages/versionFacts');
// The AI arm is a save path like any other: it writes slots AND extra
// files, so it must refresh the dependents index. If it skipped that, the
// rows of the PREVIOUS version would stay while the AI just removed the
// element that pointed at the table. See automation/usageSync.savePaths.test.js.
const webpageUsageSync = require('../../../core/webpages/webpageUsageSync');

/**
 * Everything before send('done').
 * @param {{ send: import('./toolLoop').Send, webpageId: string, userId: string, dirtySlots: Set<import('./toolLoop').Slot>,
 *   touchedExtraPaths: Set<string>, liveFiles: import('./toolLoop').SlotFiles, preTurnFiles: import('./toolLoop').SlotFiles,
 *   _streamUntok: ReturnType<typeof import('../../../core/dlp/untokeniseStream').createUntokeniser> | null }} args
 */
async function finishTurn({
    send, webpageId, userId, dirtySlots, touchedExtraPaths, liveFiles, preTurnFiles, _streamUntok,
}) {
    // Persist any tool-driven file updates to RustFS so versioning + sha256s
    // stay accurate across sessions.
    //
    // ── ONE SNAPSHOT PER TURN (W4) ───────────────────────────────────────
    // The autosave's 5-minute debounce used to sit here. That belongs to
    // KEYSTROKES: a run of small edits without a clear start or end. An AI
    // turn is the opposite: one bounded event with its own summary, and two
    // turns within five minutes (the normal pace of a conversation) shared
    // one restore point under the debounce, so the second turn could no
    // longer be rolled back on its own. The rows carry `source: 'ai'`, count
    // against MAX_VERSIONS_PER_WEBPAGE like any other and cannot push out a
    // published snapshot (that one is prune-proof).
    if (dirtySlots.size > 0) {
        try {
            const wpFresh = await webpageStore.getWebpage(webpageId, userId);
            const hadContent = wpFresh && (wpFresh.htmlSize + wpFresh.cssSize + wpFresh.jsSize > 0);
            if (hadContent) {
                await webpageStore.createVersion(userId, webpageId,
                    // The summary comes from WHAT THE TOOLS DID, not from
                    // the model's prose: the same rule webpageTurnFacts.js
                    // keeps on the client side.
                    versionFacts.aiTurnSummary(dirtySlots), {
                        htmlSha: wpFresh.htmlSha,
                        cssSha: wpFresh.cssSha,
                        jsSha: wpFresh.jsSha,
                        contentLength: wpFresh.htmlSize + wpFresh.cssSize + wpFresh.jsSize,
                    }, 'ai', {
                        // The person whose session drove the turn. The AI is
                        // not an account and cannot become one: `source`
                        // already says it was an AI turn.
                        actorUserId: userId,
                        lineDelta: versionFacts.slotsLineDelta(preTurnFiles, liveFiles, dirtySlots),
                    });
            }
            /** @type {Record<string, unknown>} */
            const updates = {};
            for (const slot of dirtySlots) {
                const { sha, size } = await webpageStore.writeSlot(userId, webpageId, slot, liveFiles[slot]);
                updates[`${slot}Sha`] = sha;
                updates[`${slot}Size`] = size;
            }
            if (Object.keys(updates).length > 0) {
                await webpageStore.updateWebpageMetadata(webpageId, userId, updates);
            }
        } catch (persistErr) {
            log.error('[WebpageChat] Failed to persist tool-driven edits:', persistErr.message);
        }
    }

    // Refresh the dependents index as soon as the turn changed ANYTHING on
    // the page. `touchedExtraPaths` counts explicitly: a react-mui app lives
    // entirely in extra files, so a turn that only rewrote `src/App.jsx` has
    // an empty `dirtySlots` and still a different list of tables. Debounced
    // and detached: an AI turn does not wait for it and does not break on it.
    //
    // Since the reconcile hangs off `stores/webpageStore.js` this line is no
    // longer the ONLY coverage, and that is exactly why it may stay where it
    // is: if the turn falls over earlier (adapter.stream throws, the catch in
    // webpageChat.js only does `res.end()`), the extra file is already
    // persisted, and the store already scheduled a pass when it wrote it.
    // This is the summarising pass at the end, not the safety net.
    if (dirtySlots.size > 0 || touchedExtraPaths.size > 0) {
        webpageUsageSync.reconcileWebpageUsageDetached(webpageId);
    }

    if (_streamUntok) {
        const _tail = _streamUntok.flush();
        if (_tail) send('content', { text: _tail });
    }
}

module.exports = { finishTurn };
