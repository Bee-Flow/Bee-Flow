// @typecheck strict
/**
 * kb_log_query / kb_log_review: the KB query log (Enterprise, licence feature kb_query_log) as steps, so an
 * app can be the work queue of a knowledge base's quality review. kb_log_query reads decrypted log rows
 * into `resultVar` as { rows, total, count }; kb_log_review sets a row's review status and note.
 * Both need a knowledge base the app OWNER and the VIEWER manage; a public app never runs them.
 * filters is { from, to, userId, channel, outcome, status }, each a binding (empty = no filter).
 * resultDetail 'summary' (the default) carries no question, passage, answer or note; 'full' returns the
 * decrypted text (keep the result variable small: the 64 kB step-body lesson of file_intake).
 */
const KB_LOG_QUERY_FIELDS = {
    kbId: { type: 'binding', required: true },
    filters: { type: 'recordValues' },
    limit: { type: 'int', min: 1, max: 200 },
    resultDetail: { type: 'enum', values: ['full', 'summary'], default: 'summary' },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

const KB_LOG_REVIEW_FIELDS = {
    kbId: { type: 'binding', required: true },
    entryId: { type: 'binding', required: true },
    status: { type: 'binding', required: true },
    note: { type: 'binding' },
};

/** The STEP_SPECS entries of both kinds (spread into actionSpecs.js). */
const KB_LOG_STEP_SPECS = {
    kb_log_query: { mutatesData: true, fields: KB_LOG_QUERY_FIELDS },
    kb_log_review: { mutatesData: true, fields: KB_LOG_REVIEW_FIELDS },
};

module.exports = { KB_LOG_QUERY_FIELDS, KB_LOG_REVIEW_FIELDS, KB_LOG_STEP_SPECS };
