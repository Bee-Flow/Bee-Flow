// @typecheck strict
/**
 * App Studio Builder — the version row written when a turn ends.
 *
 * Plan approval and every phase start already write a checkpoint row (the
 * state BEFORE the work). Without a row at the end, the newest entry in the
 * version history was the app as it stood when the last phase began, and a
 * follow-up turn left no row at all. This module adds ONE row when a turn
 * ends cleanly having changed the definition:
 *   • "AI build finished": a build turn (an approved plan ran, or the app had
 *     no components when the turn began) that ended finalized;
 *   • "AI change": every other turn that changed the definition.
 * No row for a turn that changed nothing, nor for one that failed (an SSE
 * `error` was sent, a save conflicted, the client went away): that draft is
 * one the model could not finish. The store writes nothing when the newest
 * row already holds the same definition, and prunes to the shared cap.
 *
 * This row is outside the per-turn checkpoint cap (MAX_CHECKPOINTS_PER_TURN in
 * ./chatStream.js): it is the one row a long phased build must not lose, and
 * there is at most one per turn.
 *
 * The MCP builder (appStudio/mcpBuilder.js) writes none: it has no turn (each
 * tool call stands alone) and no checkpoints today; app_mark_phase is a
 * route-only tool there.
 */

const studioAppStore = require('../../../stores/studioAppStore');
const log = require('../../../telemetry/log');

const BUILD_FINISHED_SUMMARY = 'AI build finished';
const CHANGE_SUMMARY = 'AI change';

/**
 * Whether a definition has nothing on its screens yet (the empty draft a new app starts from).
 * @param {any} def
 */
function hasNoComponents(def) {
    const screens = Array.isArray(def?.screens) ? def.screens : [];
    return !screens.some((/** @type {any} */ s) => (Array.isArray(s?.sections) ? s.sections : [])
        .some((/** @type {any} */ sec) => Array.isArray(sec?.children) && sec.children.length > 0));
}

/**
 * What the route records at the start of a turn, to decide at its end.
 * @param {any} def the draft's definition as the turn begins
 * @returns {{ startJson: string, startedBlank: boolean }}
 */
function turnStartState(def) {
    return { startJson: JSON.stringify(def ?? null), startedBlank: hasNoComponents(def) };
}

/**
 * The summary of the row a turn should leave, or null for none.
 * @param {{ lastFinalized: boolean, persistBroken: boolean, clientGone: boolean }} turn
 * @param {{ start: { startJson: string, startedBlank: boolean }, def: any, failed: boolean, planRan: boolean }} opts
 * @returns {string|null}
 */
function turnEndSummary(turn, { start, def, failed, planRan }) {
    if (failed || turn.persistBroken || turn.clientGone) return null;
    if (JSON.stringify(def ?? null) === start.startJson) return null;
    const buildTurn = planRan || start.startedBlank;
    return buildTurn && turn.lastFinalized ? BUILD_FINISHED_SUMMARY : CHANGE_SUMMARY;
}

/**
 * Write the end-of-turn row when the turn earned one. Never throws: a failed
 * write is logged and the turn ends as it would have.
 * @param {{ lastFinalized: boolean, persistBroken: boolean, clientGone: boolean }} turn
 * @param {{
 *   draftWrap: { appId?: string|null, def: any }, userId: string,
 *   start: { startJson: string, startedBlank: boolean }, failed: boolean, planRan: boolean,
 *   send: (event: string, data: unknown) => void,
 * }} opts
 * @returns {Promise<string|null>} the new version id, or null when none was written
 */
async function writeTurnEndVersion(turn, { draftWrap, userId, start, failed, planRan, send }) {
    if (!draftWrap.appId) return null;
    const summary = turnEndSummary(turn, { start, def: draftWrap.def, failed, planRan });
    if (!summary) return null;
    try {
        const versionId = await studioAppStore.createVersionSnapshot(draftWrap.appId, userId, draftWrap.def, summary, { skipIfSameAsNewest: true });
        if (versionId) send('checkpoint', { versionId, summary });
        return versionId || null;
    } catch (e) {
        log.error('[AppStudioBuilder] end-of-turn version failed (non-fatal):', e instanceof Error ? e.message : String(e));
        return null;
    }
}

module.exports = { turnStartState, turnEndSummary, writeTurnEndVersion, BUILD_FINISHED_SUMMARY, CHANGE_SUMMARY };
