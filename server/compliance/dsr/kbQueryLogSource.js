// @typecheck strict
/**
 * DSR discovery, source 8: the questions the subject put to logging knowledge bases of THIS
 * organisation, as a count by user id. No text is opened here; opening it is its own, audited
 * route (routes/compliance/kbQueryLog.js).
 */

'use strict';

const { complianceSectionPath } = require('../../utils/appPaths');
const { fallback } = require('../../utils/bestEffort');

/**
 * Rows of the KB query log that belong to the subject in this organisation, as a count.
 * @param {string} orgId
 * @param {string | null | undefined} userId
 * @param {{ kbQueryLogStore?: { countsForUser?: (orgId: string, userId: string) => Promise<{ total: number }> } | null }} deps
 * @returns {Promise<{ kind: string, label_key: string, href: string | null, count: number | null }>}
 */
async function scanKbQueryLog(orgId, userId, deps) {
    const source = {
        kind: 'kb_query_log',
        label_key: 'compliance.dsr_discovery_kb_query_log',
        href: userId ? complianceSectionPath('kb_query_log') : null,
    };
    if (!userId) return { ...source, count: 0 };
    const store = deps.kbQueryLogStore;
    if (!store?.countsForUser) return { ...source, count: null };
    try {
        return { ...source, count: Number((await store.countsForUser(orgId, userId)).total) || 0 };
    } catch (e) { return fallback('compliance/dsr/kbQueryLogSource', e, { ...source, count: null }); }
}

module.exports = { scanKbQueryLog };
