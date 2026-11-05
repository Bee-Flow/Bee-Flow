// @typecheck strict
'use strict';

/**
 * GDPR Art. 35 — the per-person monitoring views are assessed.
 *
 * Usage & Monitoring can rank named people by Privacy Shield events, list the
 * events per person, and break AI consumption down per person; the Adoption
 * report lists every member with their AI use. Each of these is a facility
 * suitable for monitoring named staff (WOR art. 27(1)(k), (l)), whether or not
 * chat signals are on, so it needs a DPIA, works-council consent that covers
 * it, and a notice that names it (amendment 25). This check reads no chat
 * signals data at all.
 *
 *   not_applicable  the per-person views are not on this plan
 *                   (`advanced_usage_monitoring`, the capability that gates
 *                   them in server/index.js)
 *   warn            they are. In this release it never passes: the Adoption
 *                   report is pseudonymous by default and records every name
 *                   reveal in the access audit log, but the opt-in gate (DPIA,
 *                   works-council scope, a notice naming the endpoints, a start
 *                   date, a retention bound) does not exist yet.
 *
 * Evidence is a fixed allow-list: endpoint names, booleans, the audit action
 * name, the guardrail log retention, and the AI Act date. No user, no count.
 * The pseudonymity and reveal-audit flags carry the `adoption_` prefix: they
 * hold for the Adoption endpoints only, the other listed views show names.
 */

const ENDPOINTS = Object.freeze([
    'guardrails.overview.top_users',
    'guardrails.recent',
    'guardrails.by_user',
    'usage.users',
    'usage.by_user',
    'usage.recent',
    'adoption.people',
    'adoption.studio.items.top_people',
]);
const AI_ACT_ASSESSMENT_DUE = '2027-12-02';
const REVEAL_AUDIT_ACTION = 'usage_adoption_people_revealed';

function defaultDeps() {
    return {
        /** @type {typeof import('../../../core/entitlements/entitlements').hasCapability} */
        hasCapability: (capId, opts) => require('../../../core/entitlements/entitlements').hasCapability(capId, opts),
        guardrailRetentionDays: () => require('../../../jobs/monitoringRetention').RETENTION_DAYS,
    };
}

/**
 * @param {number} days the guardrail log retention, 0 for none
 * @returns {string}
 */
function detailsText(days) {
    const kept = days > 0 ? `${days} days` : 'no limit (MONITORING_LOG_RETENTION_DAYS=0)';
    return 'Usage & Monitoring offers per-person Privacy Shield views: GET /api/usage/guardrails/overview (top_users, a ranking of named people), '
        + 'GET /api/usage/guardrails/recent (events with the person, filterable by ?user) and GET /api/usage/guardrails/by-user (deprecated). '
        + 'It also breaks AI consumption down per person: GET /api/usage/users, GET /api/usage/by-user and GET /api/usage/recent. '
        + 'The Adoption report lists every member with their AI use (GET /api/usage/adoption/people) and the top users of each Studio item '
        + '(GET /api/usage/adoption/studio/items, topPeople). The Adoption report is pseudonymous by default; revealing names is recorded '
        + `in the access audit log as ${REVEAL_AUDIT_ACTION}, and the top users of an item are always pseudonymous. `
        + 'These are a facility suitable for monitoring named staff (WOR art. 27(1)(k), (l)), so they need a DPIA, works-council consent that covers them, '
        + `and a notice that names them. Per-person Privacy Shield events are kept for ${kept}. `
        + 'AI Act: before 2 December 2027, document an Annex III 4(b) / Art. 6(3) assessment of the ranking or remove it.';
}

module.exports = {
    id: 'GDPR-Art35-per-user-shield-view',
    regulation: 'GDPR',
    article: '35',
    frameworks: [{ regulation: 'ISO27001', ref: 'A.5.34' }],
    severity: 'high',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'chat_monitoring.checks.gdpr_art35_per_user_view.title',
    descriptionKey: 'chat_monitoring.checks.gdpr_art35_per_user_view.desc',
    remediationKey: 'chat_monitoring.checks.gdpr_art35_per_user_view.fix',
    remediationLink: 'admin/monitoring/activity',

    /**
     * @param {string} orgId
     * @param {unknown} _subject
     */
    async evaluate(orgId, _subject, deps = defaultDeps()) {
        let reachable = false;
        try {
            reachable = !!(await deps.hasCapability('advanced_usage_monitoring', { orgId: !orgId || orgId === 'default' ? null : orgId }));
        } catch { reachable = false; }
        if (!reachable) {
            return {
                status: 'not_applicable',
                evidence: { reachable: false },
                details: 'Per-person monitoring views are not available on this plan.',
            };
        }
        let days = 0;
        try { days = Number(deps.guardrailRetentionDays()) || 0; } catch { days = 0; }
        return {
            status: 'warn',
            evidence: {
                reachable: true,
                endpoints: [...ENDPOINTS],
                guardrail_retention_days: days,
                adoption_pseudonymous_default: true,
                adoption_reveal_audited: true,
                adoption_reveal_audit_action: REVEAL_AUDIT_ACTION,
                opt_in_gate: false,
                ai_act_assessment_due: AI_ACT_ASSESSMENT_DUE,
            },
            details: detailsText(days),
        };
    },

    ENDPOINTS,
    REVEAL_AUDIT_ACTION,
};
