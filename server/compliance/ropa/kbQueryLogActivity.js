// @typecheck strict
'use strict';

/**
 * The knowledge-base query log as a processing activity.
 *
 * Present only while at least one knowledge base of the organisation has logging switched on:
 * with no base logging there is no new processing to describe (the rows of a base that was switched
 * off wait for their term to end, and are deleted by the retention job).
 *
 * Everything here describes the configuration the controller chose: which bases log, for how long,
 * and who can read the log. English only, like the rest of the register builder.
 */

const LEGAL_BASIS = 'Art. 6(1)(f) GDPR, legitimate interest: AI quality control, checking and improving the quality of answers from the organisation’s knowledge bases. The purpose is not the assessment of employees. Consent is not the basis: users are informed and their acknowledgement is recorded';

function defaultDeps() {
    return {
        listLoggingKbs: (/** @type {string} */ orgId) => require('../../stores/kb/queryLog/orgViews.mts').listLoggingKbsOfOrg(orgId),
    };
}

/**
 * @param {string} orgId
 * @returns {Promise<object[]>} [] or [activity]
 */
async function kbQueryLogActivity(orgId, deps = defaultDeps()) {
    if (!orgId) return [];
    const kbs = (await deps.listLoggingKbs(orgId)) || [];
    if (!kbs.length) return [];
    const terms = kbs.map((/** @type {Record<string, any>} */ k) => Number(k.query_log_retention_days)).filter((/** @type {number} */ n) => Number.isFinite(n) && n > 0);
    const shortest = terms.length ? Math.min(...terms) : null;
    const longest = terms.length ? Math.max(...terms) : null;
    const range = shortest === null ? 'the term set per knowledge base' : shortest === longest ? `${shortest} days` : `${shortest} to ${longest} days, set per knowledge base`;

    const named = kbs.filter((/** @type {Record<string, any>} */ k) => k.query_log_show_names === true).length;
    const namesText = named === 0
        ? 'Managers see the askers as pseudonyms (a stable label per person), not by name.'
        : named === kbs.length ? 'Managers see the askers by name.' : `Managers see the askers by name for ${named} of the ${kbs.length} logging knowledge bases and as pseudonyms for the rest.`;

    return [{
        activity_id: 'kb-query-log',
        name: 'Knowledge base query log: quality control of answers',
        purpose: 'Quality control of the knowledge bases: finding questions that get no answer or a poor one, so that the managers of a base can add or correct content. Never used to evaluate or assess employees.',
        processing: `Per question put to ${kbs.length === 1 ? 'a logging knowledge base' : `one of the ${kbs.length} logging knowledge bases`}: when, by whom, through which part of Bee Flow, the question, the passages found and, where an AI answers, the answer and its sources. The managers of the base can mark each entry as reviewed or as needing an addition. ${namesText}`,
        data_categories: [
            'Questions put to a knowledge base (free text, which can contain personal data)',
            'Passages retrieved from the knowledge base and the answers given',
            'Who asked, and when, through which channel',
            'Reviewer, review status and note of the managers',
        ],
        data_subjects: ['Employees and members who ask questions to the knowledge bases', 'Visitors of web pages and apps that use a logging knowledge base', 'People named in the questions (third parties)'],
        recipients: 'The managers of each knowledge base (its owner and the organisation members who may manage knowledge) and the organisation’s compliance team (Compliance Center), who see metadata only unless a data-subject request is open.',
        transfers: [],
        retention: `${range}. Rows are deleted automatically once their term has ended; switching a knowledge base off can delete its rows at once.`,
        legal_basis: LEGAL_BASIS,
        security_measures: [
            'Questions, passages, answers and notes are encrypted under an organisation key, also on zero-knowledge installations',
            'Logging is opt-in per knowledge base, needs an Enterprise licence, and is switched on only after the organisation attested its preconditions (DPIA, works council, privacy notice, purpose limited to AI quality control)',
            'Users are told in the chat which knowledge bases log and must acknowledge this once (recorded); until they do, their questions are not logged',
            'Askers are shown to managers as pseudonyms unless the organisation chose to show names for that knowledge base',
            'Only managers of the knowledge base can read the log; compliance sees the text only with an open data-subject request, and every such read is recorded in the access log',
            'Switching logging on or off, changing the term, exports and erasure are recorded in the access log',
            'Erased together with a person’s account, and on request (Art. 17) by the compliance team',
        ],
        dpia: 'none',
        dpia_link: 'admin/compliance/dpia',
        ai_act: /** @type {Record<string, unknown> | null} */ (null),
        source: { kind: 'kb_query_log', id: 'kb_query_log' },
    }];
}

module.exports = { kbQueryLogActivity, LEGAL_BASIS };
