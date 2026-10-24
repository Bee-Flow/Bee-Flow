// @typecheck
'use strict';
const log = require('../../telemetry/log');

/**
 * ── THE ID IS A CLAIM ABOUT A MEETING (M4) ──────────────────────────
 *
 * `config.metadata.transcriptionId` on a `text` source makes that line LAND on the timeline of that meeting:
 * the bar below the tag row, the Used-by tab and "Extracted from this transcript" all three read it back,
 * and the delete gate of the note counts it (core/meetingNotes/meetingUsage.js `scanKb`).
 *
 * Administrator rights on the KNOWLEDGE BASE are no answer to that: on your own knowledge base you are
 * always an administrator. Without this gate anyone can invent an id (or copy one) and paste an untrue,
 * irrefutable and undeletable line onto someone else's meeting.
 *
 * ── ONE GATE, TWO WRITERS ───────────────────────────────────────────
 * The gate stood in `POST /api/kb/:id/sources`, and that was precisely one of the two ways in which such a
 * claim comes about: `POST /api/kb/:id/duplicate?withSources=1` copies every non-upload source literally,
 * including the metadata, to a new knowledge base of the caller, and did not pass it. Hence this file: the
 * question should exist once, outside the routes, so that a third writer does not have to think it up again.
 *
 * ── IT RUNS AS THE WRITER, AND UNKNOWN NARROWS ──────────────────────
 * The context comes from `askerContext` (the MAKER), not from the owner of the knowledge base, and
 * DELIBERATELY without `isSuperAdmin`: that flag lets `canReadTranscription` pass any id, and then the gate
 * checks nothing any more. A meeting that the writer may not see gives exactly the same answer as a meeting
 * that does not exist, otherwise this route is an oracle for which meeting ids exist. A probe that fails is
 * NOT permission.
 */

/**
 * May `userId` paste a line onto the timeline of this meeting?
 *
 * @param {string} transcriptionId  the id from `config.metadata`
 * @param {string} userId           the WRITER, not the owner of the KB
 * @returns {Promise<{ok: true} | {ok: false, status: number, code: string, error: string}>}
 *   `ok:false` with status 400 (`transcription_not_visible`) if he may not see it, or 502
 *   (`transcription_probe_failed`) if we could NOT establish it. Two codes, because "no" and
 *   "I don't know" are two different sentences: only with the first does the writer know that he
 *   may not, and with the second he can try again later.
 */
async function checkTranscriptOriginVisible(transcriptionId, userId) {
    if (!transcriptionId) return { ok: true };   // geen bewering, niets te controleren
    const { askerContext } = require('./askerContext');
    const asker = await askerContext(userId);
    try {
        const visible = await require('../../stores/transcriptionStore').canReadTranscription(
            transcriptionId,
            userId,
            // Geen `isSuperAdmin`. Zie de kop: die vlag zou de poort openen in
            // plaats van hem te stellen.
            { orgIds: [...asker.orgIds], userGroupIds: asker.userGroups },
        );
        if (!visible) {
            return {
                ok: false, status: 400,
                code: 'transcription_not_visible',
                error: 'That meeting is not available to you.',
            };
        }
        return { ok: true };
    } catch (e) {
        log.warn('[KB] transcript origin probe failed:', e.message);
        return {
            ok: false, status: 502,
            code: 'transcription_probe_failed',
            error: 'Could not check that meeting right now.',
        };
    }
}

/**
 * The same question, for a path that must not fail: return the config WITHOUT the claim as soon as that
 * is not tenable.
 *
 * The duplicate path is best-effort per source (the copy already exists by the time this runs), so there
 * 'refuse' is no option, and 'drop the claim' is the right answer: the source itself is ordinary content
 * of a knowledge base that the caller may read; only the claim on someone else's meeting is not. A probe
 * that fails drops the claim too.
 *
 * @param {any|null|undefined} config  the config of the source being copied
 * @param {string} userId                 the WRITER of the copy
 * @returns {Promise<any>} a config that can safely be written
 */
async function stripUnauthorizedTranscriptOrigin(config, userId) {
    const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const claimed = cfg.metadata && typeof cfg.metadata === 'object' && !Array.isArray(cfg.metadata)
        ? cfg.metadata.transcriptionId
        : null;
    if (typeof claimed !== 'string' || !claimed.trim()) return cfg;

    const verdict = await checkTranscriptOriginVisible(claimed.trim(), userId);
    if (verdict.ok) return cfg;
    // Allow-list, not delete-keys: build the copy from what may remain.
    // That way a field that is added to `metadata` next year does not travel along by itself, as it would
    // if this rule ever only removed a key.
    const { metadata, ...rest } = cfg;
    log.warn(`[KB] Duplicate: transcript origin ${claimed} dropped — the copier may not see that meeting (${/** @type {{code: string}} */ (verdict).code})`);
    return rest;
}

module.exports = { checkTranscriptOriginVisible, stripUnauthorizedTranscriptOrigin };
