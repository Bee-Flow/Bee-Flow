// @typecheck
'use strict';

/**
 * The daily project-findings digest — how admins and the DPO hear about the
 * project checks without being paged by them.
 *
 * Project checks can run over hundreds of projects. Telling someone about
 * each finding as it appears would be a bell nobody reads, and telling end
 * users is not this module's business at all (they get at most one hint in
 * their own project, routes/projects/complianceHints.js). So:
 *
 *   - ONE notice per organisation per day, at most, sent after a sweep;
 *   - only about findings that are NEW: a finding is remembered by its
 *     fingerprint (compliance/findingState.js) in compliance_notify_log, so the
 *     same warning is reported once, and reported again only when it changes
 *     (warn → fail, another project affected);
 *   - never about a finding an admin already acknowledged, accepted or
 *     snoozed;
 *   - counts and a link only — no project name, no person, no content.
 *
 * The day's claim is a primary-key insert, so two replicas finishing a sweep
 * at the same moment send one digest between them. A finding first seen after
 * the day's digest went out waits for tomorrow's, which is the point.
 */

const findingState = require('./findingState');
const { complianceSectionPath } = require('../utils/appPaths');
const log = require('../telemetry/log');

// Upper bound on the findings one digest looks at: the count in the message
// is exact up to here, and a sweep with more than this many brand-new project
// findings says so as "500+".
const MAX_CANDIDATES = 500;

function _defaults() {
    return {
        complianceStore: require('../stores/complianceStore'),
        registry: require('./registry'),
        frameworkPolicy: require('./frameworkPolicy'),
        notices: require('./adminNotices'),
        now: () => Date.now(),
    };
}

/**
 * @param {object} [overrides] complianceStore, registry, frameworkPolicy,
 *   notices ({notify}), now
 */
function makeProjectDigest(overrides = {}) {
    let _d = null;
    const d = () => (_d || (_d = { ..._defaults(), ...overrides }));

    /** The open, undecided project findings of an org, with their fingerprints. */
    async function openFindings(orgId) {
        const { complianceStore, registry, frameworkPolicy } = d();
        const [latest, active, states] = await Promise.all([
            complianceStore.getLatestPerCheck(orgId),
            frameworkPolicy.activeRegulations(orgId),
            complianceStore.listFindingStates ? complianceStore.listFindingStates(orgId).catch(() => []) : [],
        ]);
        const index = findingState.indexStates(states);
        const out = [];
        for (const row of latest || []) {
            if (row.status !== 'warn' && row.status !== 'fail') continue;
            const def = registry.get(row.check_id);
            if (!def || def.projectCheck !== true || !active.has(def.regulation)) continue;
            if (findingState.applies(findingState.stateFor(index, row), row, def, d().now())) continue;
            out.push({
                key: `${row.check_id}:${findingState.scopeKeyOf(row)}`,
                fingerprint: findingState.fingerprintOf(row, def),
                status: row.status,
            });
            if (out.length >= MAX_CANDIDATES) break;
        }
        return out;
    }

    /**
     * Send today's digest for one org if there is anything new. Never throws.
     * @returns {Promise<{sent: boolean, count?: number, reason?: string}>}
     */
    async function sendDigest(orgId) {
        try {
            const { complianceStore, notices } = d();
            const dayKey = new Date(d().now()).toISOString().slice(0, 10);
            if (await complianceStore.wasNotified(orgId, 'project_digest', dayKey, 'sent')) {
                return { sent: false, reason: 'already_sent' };
            }
            const fresh = [];
            for (const f of await openFindings(orgId)) {
                if (!(await complianceStore.wasNotified(orgId, 'project_finding', f.key, f.fingerprint))) fresh.push(f);
            }
            if (!fresh.length) return { sent: false, reason: 'nothing_new' };
            if (!(await complianceStore.markNotified(orgId, 'project_digest', dayKey, 'sent'))) {
                return { sent: false, reason: 'claimed_elsewhere' };
            }
            const failing = fresh.filter(f => f.status === 'fail').length;
            const n = fresh.length >= MAX_CANDIDATES ? `${MAX_CANDIDATES}+` : String(fresh.length);
            await notices.notify(orgId, {
                category: 'heads_up',
                title: 'New compliance findings in projects',
                message: failing > 0
                    ? `${n} new finding(s) in collaborative projects since the last digest, ${failing} of them failing. Review them under Compliance → Needs attention.`
                    : `${n} new finding(s) in collaborative projects since the last digest. Review them under Compliance → Needs attention.`,
                link: complianceSectionPath('overview'),
            });
            for (const f of fresh) {
                await complianceStore.markNotified(orgId, 'project_finding', f.key, f.fingerprint).catch(() => false);
            }
            return { sent: true, count: fresh.length };
        } catch (e) {
            log.warn(`[ComplianceProjectDigest] org="${orgId}" digest skipped:`, e?.message || e);
            return { sent: false, reason: 'error' };
        }
    }

    return { sendDigest, openFindings };
}

const _default = makeProjectDigest();

module.exports = { makeProjectDigest, sendDigest: _default.sendDigest, MAX_CANDIDATES };
