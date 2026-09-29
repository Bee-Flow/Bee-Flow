/**
 * Data Act Art. 25(2)(d) — a customer can start switching with at most two
 * months' notice, whatever the contract term says.
 *
 * Two contracts can be in scope:
 *   1. The PLATFORM's contract with this organisation (Bee Flow cloud). Only
 *      on a cloud deployment — a self-hosted install has no switching contract
 *      with Bee Flow, so the check is not applicable there. The platform
 *      declares its notice period in configStore 'billing'.notice_period_days.
 *   2. The ORGANISATION's own customer contracts, when it resells the service
 *      as a data-processing provider (`data_act_provider_role`). Its
 *      `notice_period_days` is judged by the same rule.
 *
 *   value missing        → warn  (nothing declared — the term is unknown)
 *   value > 60 days      → fail  (longer than two months)
 *   value ≤ 60 days      → pass
 *   the worse of the two contracts wins.
 *
 * Hybrid: the deployment mode is automated, the periods are declarations.
 * The evidence holds the numbers, never the contract text.
 */

const complianceStore = require('../../../stores/complianceStore');
const configStore = require('../../../stores/configStore');

const MAX_NOTICE_DAYS = 60; // "two months" (Art. 25(2)(d))
const RANK = { pass: 0, warn: 1, fail: 2 };

function _relevance(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return rel && typeof rel === 'object' ? rel : {};
}

/**
 * 'cloud' | 'self-hosted'. Prefers the licence module's own view (its
 * exported `serverLicenseGovernsOrgs()` is true exactly on self-hosted; a
 * `deploymentMode()` export is honoured when present) and falls back to the
 * env var the licence module itself reads.
 */
function _deploymentMode() {
    try {
        const license = require('../../../license');
        if (typeof license.deploymentMode === 'function') return license.deploymentMode();
        if (typeof license.serverLicenseGovernsOrgs === 'function') return license.serverLicenseGovernsOrgs() ? 'self-hosted' : 'cloud';
    } catch { /* licence module unavailable — fall through */ }
    const mode = process.env.DEPLOYMENT_MODE || 'cloud';
    return mode === 'private-cloud' ? 'self-hosted' : mode;
}

function _days(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** One contract → { status, days, reason }. */
function _judge(days) {
    if (days === null) return { status: 'warn', days, reason: 'not declared' };
    if (days > MAX_NOTICE_DAYS) return { status: 'fail', days, reason: `${days} days exceeds ${MAX_NOTICE_DAYS}` };
    return { status: 'pass', days, reason: `${days} days ≤ ${MAX_NOTICE_DAYS}` };
}

module.exports = {
    id: 'DATA_ACT-Art25-notice-period',
    regulation: 'DATA_ACT',
    article: '25(2)(d)',
    frameworks: [],
    severity: 'medium',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.check_data_act_notice_period_title',
    descriptionKey: 'compliance.check_data_act_notice_period_desc',
    remediationKey: 'compliance.check_data_act_notice_period_fix',
    remediationLink: 'admin/compliance/settings',

    async evaluate(orgId) {
        const settings = (await complianceStore.getSettings(orgId)) || {};
        if (_relevance(settings).data_act === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The Data Act was marked not relevant for this organisation.',
            };
        }

        const mode = _deploymentMode();
        const providerRole = settings.data_act_provider_role === true;
        if (mode === 'self-hosted' && !providerRole) {
            return {
                status: 'not_applicable',
                evidence: { deployment_mode: mode, org_provider_role: false, max_notice_days: MAX_NOTICE_DAYS },
                details: 'Self-hosted install: there is no cloud switching contract with Bee Flow, and this organisation does not resell the service.',
            };
        }

        const contracts = [];
        if (mode === 'cloud') {
            let billing = null;
            try { billing = await configStore.getConfig('billing'); } catch { billing = null; }
            const days = _days(billing && billing.notice_period_days);
            contracts.push({ party: 'platform', ...(_judge(days)) });
        }
        if (providerRole) {
            contracts.push({ party: 'organisation', ...(_judge(_days(settings.notice_period_days))) });
        }

        const worst = contracts.reduce((w, c) => (RANK[c.status] > RANK[w.status] ? c : w), contracts[0]);
        const evidence = {
            deployment_mode: mode,
            max_notice_days: MAX_NOTICE_DAYS,
            org_provider_role: providerRole,
            platform_notice_period_days: contracts.find(c => c.party === 'platform')?.days ?? null,
            org_notice_period_days: contracts.find(c => c.party === 'organisation')?.days ?? null,
            contracts,
        };

        const describe = (c) => c.party === 'platform'
            ? `the platform's notice period (billing settings)`
            : `this organisation's own customer notice period`;

        if (worst.status === 'fail') {
            const failing = contracts.filter(c => c.status === 'fail');
            return {
                status: 'fail',
                evidence,
                details: `${failing.map(c => `${describe(c)} is ${c.days} days`).join('; ')} — Art. 25(2)(d) caps the switching notice at two months (${MAX_NOTICE_DAYS} days).`,
            };
        }
        if (worst.status === 'warn') {
            const missing = contracts.filter(c => c.status === 'warn');
            return {
                status: 'warn',
                evidence,
                details: `${missing.map(describe).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not declared, so the two-month cap cannot be verified.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `${contracts.map(c => `${describe(c)} is ${c.days} days`).join('; ')} — within the two-month cap.`,
        };
    },
};

module.exports._test = { MAX_NOTICE_DAYS, _judge, _days, _deploymentMode };
