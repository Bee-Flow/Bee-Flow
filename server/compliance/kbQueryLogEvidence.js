// @typecheck strict
/**
 * Evidence of what happened to the KB query log, for the compliance hash chain.
 *
 * One row per change of a knowledge base's logging (on, off, term, purge) and per
 * erasure or export of a person's rows. The payload is an allow-list of ids,
 * counts and settings: never a query, an answer, a name or an e-mail address.
 * The write is best-effort towards the caller (the audit row is the fail-closed
 * record); a rejected append is reported, not dropped, like the DSR evidence.
 */

'use strict';

const { onEvidenceWriteFailed } = require('./evidence/writeFailures');
const { emit, EVENTS } = require('./events');
const { bestEffort } = require('../utils/bestEffort');

const CHECK_ID = 'GDPR-Art5-kb-query-log';

/**
 * @param {string | null} orgId
 * @param {{ action: string, subjectType: 'knowledge_base' | 'user', subjectId: string, actorId: string, details?: Record<string, string | number | boolean | null> }} e
 */
async function recordKbQueryLogEvidence(orgId, { action, subjectType, subjectId, actorId, details = {} }) {
    if (!orgId) return;
    try {
        const complianceStore = require('../stores/complianceStore');
        const row = {
            organization_id: orgId,
            check_id: CHECK_ID,
            subject_type: subjectType,
            subject_id: subjectId,
            payload: { action, actor: actorId, at: new Date().toISOString(), ...details },
        };
        await complianceStore.addEvidence(row).catch(onEvidenceWriteFailed(row));
    } catch (err) { bestEffort('compliance/kbQueryLogEvidence:addEvidence', err); }
    emit(EVENTS.KB_QUERY_LOG_CHANGED, { orgId });
}

module.exports = { recordKbQueryLogEvidence, CHECK_ID };
