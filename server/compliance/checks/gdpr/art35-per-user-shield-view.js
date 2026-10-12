'use strict';

/**
 * GDPR Art. 35 — the per-person Privacy Shield views are assessed.
 *
 * Usage & Monitoring can rank named people by Privacy Shield events and list
 * the events per person. That is a facility suitable for monitoring named
 * staff (WOR art. 27(1)(k), (l)), whether or not chat signals are on, so it
 * needs a DPIA, works-council consent that covers it, and a notice that names
 * it (amendment 25). This check reads no chat signals data at all.
 *
 *   not_applicable  the per-person views are not on this plan
 *                   (`advanced_usage_monitoring`, the capability that gates
 *                   them in server/index.js)
 *   warn            they are. In this release it never passes: the opt-in
 *                   gate (DPIA, works-council scope, a notice naming the
 *                   endpoints, a start date, pseudonymous by default, audited
 *                   name reveal, a retention bound) does not exist yet.
 *
 * Evidence is a fixed allow-list: endpoint names, the guardrail log
 * retention, and the AI Act date. No user, no count.
 */

const ENDPOINTS = Object.freeze(['guardrails.overview.top_users', 'guardrails.recent', 'guardrails.by_user']);
const AI_ACT_ASSESSMENT_DUE = '2027-12-02';

function defaultDeps() {
    return {
        hasCapability: (capId, opts) => require('../../../core/entitlements/entitlements').hasCapability(capId, opts),
        guardrailRetentionDays: () => require('../../../jobs/monitoringRetention').RETENTION_DAYS,
    };
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

    async evaluate(orgId, _subject, deps = defaultDeps()) {
        let reachable = false;
        try {
            reachable = !!(await deps.hasCapability('advanced_usage_monitoring', { orgId: !orgId || orgId === 'default' ? null : orgId }));
        } catch { reachable = false; }
        if (!reachable) {
            return {
                status: 'not_applicable',
                evidence: { reachable: false },
                details: 'Per-person Privacy Shield views are not available on this plan.',
            };
        }
        let days = 0;
        try { days = Number(deps.guardrailRetentionDays()) || 0; } catch { days = 0; }
        const kept = days > 0 ? `${days} days` : 'no limit (MONITORING_LOG_RETENTION_DAYS=0)';
        return {
            status: 'warn',
            evidence: {
                reachable: true,
                endpoints: [...ENDPOINTS],
                guardrail_retention_days: days,
                opt_in_gate: false,
                ai_act_assessment_due: AI_ACT_ASSESSMENT_DUE,
            },
            details: 'Usage & Monitoring offers per-person Privacy Shield views: GET /api/usage/guardrails/overview (top_users, a ranking of named people), '
                + 'GET /api/usage/guardrails/recent (events with the person, filterable by ?user) and GET /api/usage/guardrails/by-user (deprecated). '
                + 'These are a facility suitable for monitoring named staff (WOR art. 27(1)(k), (l)), so they need a DPIA, works-council consent that covers them, '
                + `and a notice that names them. Per-person events are kept for ${kept}. `
                + 'AI Act: before 2 December 2027, document an Annex III 4(b) / Art. 6(3) assessment of the ranking or remove it.',
        };
    },

    ENDPOINTS,
};
