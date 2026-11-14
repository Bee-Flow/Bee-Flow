// @typecheck strict
/**
 * The filters of the KB query log, shared by the KB-level routes
 * (routes/knowledgeBases/queryLog.js) and the compliance routes
 * (routes/compliance/kbQueryLog.js): one definition of what a caller may filter on, and one
 * translation to the store's filter.
 */

const { z, worded, choice, wholeNumber } = require('../../core/http/schemaParts');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { recordKbQueryLogAudit } = require('../../stores/kb/queryLog/audit.mts');
const { CHANNELS, OUTCOMES, REVIEW_STATUSES } = require('../../stores/kb/queryLog/vocab.mts');

const DATE_TEXT = 'A date is an ISO date or time, for example 2026-11-01.';
const isDate = (/** @type {string} */ v) => !Number.isNaN(Date.parse(v));
/** @param {string} name */
const dateParam = (name) => worded(`${name} ${DATE_TEXT.charAt(0).toLowerCase()}${DATE_TEXT.slice(1)}`).trim().refine(isDate, `${name}: ${DATE_TEXT}`).optional();

/** The metadata filters (no free text): what the compliance view may use too. */
const metadataShape = {
    from: dateParam('from'),
    to: dateParam('to'),
    userId: worded('userId is the id of a person.').trim().min(1, 'userId is the id of a person.').max(200, 'userId is the id of a person.').optional(),
    channel: choice(CHANNELS, `channel is one of: ${CHANNELS.join(', ')}.`).optional(),
    outcome: choice(OUTCOMES, `outcome is one of: ${OUTCOMES.join(', ')}.`).optional(),
    status: choice(REVIEW_STATUSES, `status is one of: ${REVIEW_STATUSES.join(', ')}.`).optional(),
};

/** @param {number} max */
const pagingShape = (max) => ({
    limit: wholeNumber(`limit is a whole number from 1 to ${max}.`, { min: 1, max }).optional(),
    offset: wholeNumber('offset is a whole number from 0.', { min: 0 }).optional(),
});

const textShape = {
    q: worded('q is the text to look for.').trim().max(200, 'q is at most 200 characters.').optional(),
};

/**
 * @param {Record<string, any>} q  a parsed query
 * @returns {{ from: string | null, to: string | null, userId: string | null, channel: string | null, outcome: string | null, status: string | null }}
 */
function metadataFilter(q) {
    return {
        from: q.from ? new Date(q.from).toISOString() : null,
        to: q.to ? new Date(q.to).toISOString() : null,
        userId: q.userId || null,
        channel: q.channel || null,
        outcome: q.outcome || null,
        status: q.status || null,
    };
}

/**
 * Write the audit rows of a request. A failure refuses the request: what the audit would have
 * recorded has not happened, and nothing of the log has been shown.
 * @param {Parameters<typeof recordKbQueryLogAudit>[0][]} entries
 */
async function auditFirst(entries) {
    try {
        for (const e of entries) await recordKbQueryLogAudit(e);
    } catch (err) {
        // The reason only: no text of the log is in here.
        log.error('[KbQueryLog] access audit failed; request refused:', /** @type {Error} */ (err)?.message || err);
        throw new HttpError(503, 'audit_unavailable', 'This could not be recorded in the access audit, so it was not done. Try again later.');
    }
}

module.exports = { auditFirst, metadataShape, pagingShape, textShape, metadataFilter, z };
