'use strict';

/**
 * GDPR Art. 35 — chat signals keep their safeguards while they are on.
 *
 * The admin route refuses a configuration whose preconditions do not hold
 * (stores/lib/chatMonitoringRules.js); the resolver pauses a chat type whose
 * precondition lapses later. This check reads the same evaluation and tells
 * the admin when that happened, and when it is about to.
 *
 *   not_applicable  chat signals are not switched on
 *   fail            a global precondition is missing (legal basis, the
 *                   legitimate-interest attestation, retention), or a selected
 *                   chat type is paused: DPIA missing or expired, prior
 *                   consultation, DPO advice, works council pending or its
 *                   scope exceeded, the notice missing or published after the
 *                   start, the default bucket on an installation with
 *                   organisations, no visitor notice
 *   warn            the DPIA expires within 30 days; the notice link does not
 *                   answer (an intranet link is "not checked", not a warning);
 *                   the processing register was not reviewed since chat
 *                   signals were switched on; a small group (fewer than 5
 *                   active people, 10 with kinds of data) on an active
 *                   employee chat type
 *   pass            otherwise
 *
 * Evidence: enums, dates, booleans and bands only (amendment 10). The
 * sentence about the per-person Privacy Shield views is NOT here: that is
 * GDPR-Art35-per-user-shield-view, which runs whether chat signals are on or
 * off (amendment 25).
 */

const V = require('../../../stores/lib/chatMonitoringVocab');
const rules = require('../../../stores/lib/chatMonitoringRules');
const sup = require('../../../stores/lib/chatSignalSuppression');

const DAY_MS = 86_400_000;
const EXPIRY_WARN_DAYS = 30;
const LABEL = Object.freeze({ direct: 'Direct chat', agent: 'Agent chat', agent_public: 'Embedded agents' });

/** Rule codes, worded for the check (build spec 6.2). */
function checkCode(code, dpia) {
    switch (code) {
        case 'dpia': return dpia.kind === 'none' ? 'dpia_missing' : 'dpia_expired';
        case 'prior_consultation_at': return 'prior_consultation_missing';
        case 'dpo_advice_at': return 'dpo_advice_missing';
        case 'works_council': return 'works_council_pending';
        case 'works_council_scope': return 'works_council_scope_exceeded';
        case 'notice_url': return 'notice_missing';
        case 'notice_published_at': return 'notice_after_start';
        default: return code;
    }
}

function defaultDeps() {
    return {
        getSettings: (orgKey) => require('../../../stores/complianceStore').getSettings(orgKey),
        getDpia: (orgKey) => require('../../../stores/dpiaStore').getLatestForAgent(orgKey, V.CHAT_MONITORING_DPIA_KEY),
        hasAnyOrganization: () => require('../../../stores/userStore').hasAnyOrganization(),
        contributorCount: (orgKey, surface, w) => require('../../../stores/chatSignalStore').contributorCount(orgKey, surface, w),
        probe: (url) => require('../../lib/urlProbe').probe(url),
        now: () => new Date(),
    };
}

module.exports = {
    id: 'GDPR-Art35-chat-monitoring-safeguards',
    regulation: 'GDPR',
    article: '35',
    frameworks: [{ regulation: 'ISO27001', ref: 'A.5.34' }],
    severity: 'high',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'chat_monitoring.checks.gdpr_art35_chat_mon.title',
    descriptionKey: 'chat_monitoring.checks.gdpr_art35_chat_mon.desc',
    remediationKey: 'chat_monitoring.checks.gdpr_art35_chat_mon.fix',
    remediationLink: 'admin/compliance/settings',

    async evaluate(orgId, _subject, deps = defaultDeps()) {
        const orgKey = orgId || 'default';
        const s = (await deps.getSettings(orgKey)) || {};
        if (s.chat_monitoring_enabled !== true) {
            return { status: 'not_applicable', evidence: { enabled: false }, details: 'Chat signals are not switched on.' };
        }
        const now = deps.now();
        const [dpiaRow, installHasOrganisations] = await Promise.all([deps.getDpia(orgKey), deps.hasAnyOrganization()]);
        const ev = rules.evaluate(s, { dpiaRow, now, installHasOrganisations, orgKey, privacyNoticeUrl: s.privacy_notice_url });
        const d = rules.dpiaStatus(s, dpiaRow, now);
        const selected = (Array.isArray(s.chat_monitoring_surfaces) ? s.chat_monitoring_surfaces : []).filter(x => V.SURFACES.includes(x));
        const signals = (Array.isArray(s.chat_monitoring_signals) ? s.chat_monitoring_signals : []).filter(x => V.SIGNALS.includes(x));
        const paused = selected
            .filter(x => (ev.bySurface[x] || []).length)
            .map(x => ({ id: x, missing: [...new Set(ev.bySurface[x].map(c => checkCode(c, d)))] }));
        const active = selected.filter(x => !(ev.bySurface[x] || []).length);

        // Warnings.
        const expiresInDays = d.expiresAt ? Math.floor((d.expiresAt.getTime() - now.getTime()) / DAY_MS) : null;
        const expiringSoon = d.current && expiresInDays !== null && expiresInDays < EXPIRY_WARN_DAYS;
        const noticeUrl = rules.httpsUrl(s.chat_monitoring_notice_url)
            || (selected.includes('agent_public') ? rules.httpsUrl(s.privacy_notice_url) : null);
        let noticeReachable = null;
        if (noticeUrl) {
            try {
                const r = await deps.probe(noticeUrl);
                noticeReachable = r && r.error === 'private_host' ? null : !!(r && r.ok);
            } catch { noticeReachable = false; }
        }
        const enabledAt = rules.isoInstant(s.chat_monitoring_enabled_at);
        const reviewedAt = rules.isoInstant(s.ropa_reviewed_at);
        const ropaReviewed = !!reviewedAt && (!enabledAt || reviewedAt >= enabledAt);
        const weeks = sup.lastFourWeeks(now);
        const smallGroups = [];
        for (const surface of active.filter(x => V.isEmployeeSurface(x))) {
            let n = null;
            try { n = await deps.contributorCount(orgKey, surface, { from: weeks.from, toExclusive: weeks.toExclusive }); } catch { n = null; }
            const floor = signals.includes('kinds') ? V.K.kinds : V.K.outcomes;
            if (n === null || n < floor) smallGroups.push(surface);
        }

        const dpo = !!(s.dpo_name || s.dpo_email);
        const consent = V.WORKS_COUNCIL_CONSENT.includes(s.chat_monitoring_works_council);
        const evidence = {
            surfaces_selected: selected,
            surfaces_active: active,
            surfaces_paused: paused,
            missing: ev.global,
            signals,
            legal_basis: V.LEGAL_BASES.includes(s.chat_monitoring_legal_basis) ? s.chat_monitoring_legal_basis : null,
            works_council: V.WORKS_COUNCIL.includes(s.chat_monitoring_works_council) ? s.chat_monitoring_works_council : null,
            works_council_reason: V.WORKS_COUNCIL_REASONS.includes(s.chat_monitoring_works_council_reason) ? s.chat_monitoring_works_council_reason : null,
            works_council_scope_ok: !consent || !Object.values(ev.bySurface).flat().includes('works_council_scope'),
            dpia: d.kind,
            dpia_expires_in_days: d.current ? expiresInDays : null,
            dpia_risk_level: d.riskLevel,
            prior_consultation: d.riskLevel === 'high' ? !Object.values(ev.bySurface).flat().includes('prior_consultation_at') : 'not_required',
            dpo_advice: dpo ? !Object.values(ev.bySurface).flat().includes('dpo_advice_at') : 'not_required',
            notice_set: !!noticeUrl,
            notice_reachable: noticeReachable,
            ropa_reviewed_since_enabled: ropaReviewed,
            retention_days: rules.clampedRetention(s),
            effective_from: rules.isoInstant(s.chat_monitoring_effective_from)?.slice(0, 10) || null,
            small_groups: smallGroups,
        };

        if (ev.global.length || paused.length) {
            const parts = [];
            if (ev.global.length) parts.push(`Missing for all chat types: ${ev.global.join(', ')}.`);
            for (const p of paused) parts.push(`${LABEL[p.id]} is paused: ${p.missing.join(', ')}.`);
            return {
                status: 'fail',
                evidence,
                details: `${parts.join(' ')} The route refuses these on the way in, so this means the record changed afterwards. A paused chat type is neither counted nor announced until it is fixed.`,
            };
        }
        const warnings = [];
        if (expiringSoon) warnings.push(`The DPIA expires in ${Math.max(0, expiresInDays)} day${expiresInDays === 1 ? '' : 's'}; renew it before then or the employee chat types pause.`);
        if (noticeReachable === false) warnings.push('The notice link did not answer; people cannot read what is counted.');
        if (!ropaReviewed) warnings.push('The processing register was not reviewed since chat signals were switched on.');
        if (smallGroups.length) {
            warnings.push(`Small groups on ${smallGroups.map(x => LABEL[x]).join(', ')}: figures are hidden. Small-group totals can still single people out; address this in the DPIA. `
                + 'Whether a works council applies depends on the enterprise headcount, not on Bee Flow users.');
        }
        if (warnings.length) return { status: 'warn', evidence, details: warnings.join(' ') };
        return {
            status: 'pass',
            evidence,
            details: `Chat signals keep their safeguards on ${active.map(x => LABEL[x]).join(', ')}: a current DPIA where it is needed, the works-council decision, a published notice before the start, a legal basis and a retention of ${rules.clampedRetention(s)} days.`,
        };
    },

    _checkCode: checkCode,
};
