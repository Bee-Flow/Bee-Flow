/**
 * NIS2 Art. 21(2)(j) — multi-factor authentication on privileged access.
 *
 * Every organisation admin (system role 'admin', or an org-admin orgRole) must
 * either have TOTP enabled on the account (users.mfa_enabled) or sign in
 * through an SSO provider that enforces MFA. The platform cannot see what the
 * identity provider enforces, so SSO coverage needs BOTH a configured provider
 * (configStore 'providers' / 'oauth', as ISO A.8.5 reads it) AND the admin
 * attestation `sso_enforces_mfa` in compliance settings.
 *
 * Evidence names counts and opaque user ids only — never e-mail addresses or
 * display names (BFSF-441).
 */

const { getAll } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');
const configStore = require('../../../stores/configStore');

// users."orgRole" values that make someone an org admin (auth/permissions.js
// ORG_ADMIN_VARIANTS: the current 'org_admin' and the legacy 'admin').
const ORG_ADMIN_ROLES = ['org_admin', 'admin'];
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

async function _ssoProviders() {
    const enabled = [];
    try {
        const providers = (await configStore.getConfig('providers')) || {};
        for (const [name, p] of Object.entries(providers)) {
            if (p && p.enabled && p.clientId) enabled.push(name);
        }
        const oauth = (await configStore.getConfig('oauth')) || {};
        if (oauth.nextcloudUrl && oauth.clientId) enabled.push('nextcloud');
    } catch { /* config store unreachable — treated as "no SSO" */ }
    return enabled;
}

module.exports = {
    id: 'NIS2-Art21(2)(j)-admin-mfa',
    regulation: 'NIS2',
    article: 'Art. 21(2)(j)',
    frameworks: [
        { regulation: 'ISO27001', ref: 'A.8.5' },
        { regulation: 'DORA', ref: 'Art. 9' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_nis2_admin_mfa_title',
    descriptionKey: 'compliance.check_nis2_admin_mfa_desc',
    remediationKey: 'compliance.check_nis2_admin_mfa_fix',
    remediationLink: 'admin/security/users',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'NIS2 is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        let admins;
        try {
            admins = await getAll(`
                SELECT id, COALESCE(mfa_enabled, false) AS mfa_enabled
                FROM users
                WHERE "organizationId" = $1
                  AND (role = 'admin' OR "orgRole" = ANY($2))
                  AND COALESCE(status, 'active') <> 'suspended'
            `, [orgId, ORG_ADMIN_ROLES]);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return {
                    status: 'warn',
                    evidence: { provisioned: false, missing: e.code },
                    details: 'MFA columns on the user table are not provisioned yet — cannot verify admin MFA coverage.',
                };
            }
            throw e;
        }

        const ssoProviders = await _ssoProviders();
        const ssoAttested = settings.sso_enforces_mfa === true;
        const ssoCovered = ssoProviders.length > 0 && ssoAttested;

        const mfaEnabled = admins.filter(a => a.mfa_enabled === true).length;
        const uncovered = ssoCovered ? [] : admins.filter(a => a.mfa_enabled !== true);

        const evidence = {
            admins_total: admins.length,
            mfa_enabled: mfaEnabled,
            sso_providers: ssoProviders,
            sso_enforces_mfa_attested: ssoAttested,
            sso_covered: ssoCovered,
            uncovered_count: uncovered.length,
            uncovered: uncovered.slice(0, 10).map(a => a.id),
        };

        if (admins.length === 0) {
            return {
                status: 'not_applicable',
                evidence,
                details: 'No organisation admin accounts found — nothing to verify.',
            };
        }
        if (uncovered.length === 0) {
            return {
                status: 'pass',
                evidence,
                details: ssoCovered
                    ? `All ${admins.length} admin account(s) are covered: ${mfaEnabled} with TOTP, the rest through SSO (${ssoProviders.join(', ')}) attested to enforce MFA.`
                    : `All ${admins.length} admin account(s) have multi-factor authentication enabled.`,
            };
        }
        if (uncovered.length === admins.length && ssoProviders.length === 0) {
            return {
                status: 'fail',
                evidence,
                details: `None of the ${admins.length} admin account(s) has MFA enabled and no SSO provider is configured. Privileged access is protected by a password alone.`,
            };
        }
        const hint = ssoProviders.length > 0 && !ssoAttested
            ? ` SSO (${ssoProviders.join(', ')}) is configured — if your identity provider enforces MFA, confirm that under Compliance → Settings.`
            : '';
        return {
            status: 'warn',
            evidence,
            details: `${uncovered.length} of ${admins.length} admin account(s) have no MFA enabled.${hint}`,
        };
    },
};
