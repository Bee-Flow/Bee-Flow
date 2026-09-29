/**
 * Smoke scenarios — ISO 27001 controls proven by the platform itself:
 * A.5.15 access control, A.8.5 secure authentication, A.8.24 cryptography,
 * A.8.15/8.16 security event logging, A.8.10 deletion, A.8.11/8.12 DLP.
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');

module.exports = async function isoPlatformControls() {
    log.info('\n▶ ISO 27001 A.5.15 — Access control centrally defined');
    const accessRegistrySingleton = require('../../../auth/accessRegistry');
    const encryptionSingleton = require('../../../auth/encryption');
    await t('pass with the real registry, roles and drift test', async () => {
        resetState();
        assertStatus(await checks.isoAccessControl.evaluate(), 'pass', 'real registry');
    });
    await t('fail when the registry declares no routes', async () => {
        resetState();
        const saved = accessRegistrySingleton.routes;
        accessRegistrySingleton.routes = {};
        try {
            assertStatus(await checks.isoAccessControl.evaluate(), 'fail', 'empty registry');
        } finally { accessRegistrySingleton.routes = saved; }
    });
    await t('warn when the drift test is missing', async () => {
        resetState();
        const fsMod = require('fs');
        const saved = fsMod.existsSync;
        fsMod.existsSync = (p) => String(p).includes('accessRegistry.drift.test') ? false : saved(p);
        try {
            assertStatus(await checks.isoAccessControl.evaluate(), 'warn', 'no drift test');
        } finally { fsMod.existsSync = saved; }
    });

    log.info('\n▶ ISO 27001 A.8.5 — Secure authentication');
    await t('warn when no SSO provider is configured', async () => {
        resetState();
        assertStatus(await checks.isoSecureAuth.evaluate(), 'warn', 'password-only');
    });
    await t('pass when a Google provider is enabled', async () => {
        resetState();
        _state.config['providers'] = { google: { enabled: true, clientId: 'abc' } };
        assertStatus(await checks.isoSecureAuth.evaluate(), 'pass', 'google sso');
    });
    await t('pass when Nextcloud OAuth is configured', async () => {
        resetState();
        _state.config['oauth'] = { nextcloudUrl: 'https://cloud.example.com', clientId: 'nc' };
        assertStatus(await checks.isoSecureAuth.evaluate(), 'pass', 'nextcloud sso');
    });
    await t('fail when the lockout API is missing from the encryption module', async () => {
        resetState();
        _state.config['providers'] = { google: { enabled: true, clientId: 'abc' } };
        const saved = encryptionSingleton.unlockUserDEK;
        delete encryptionSingleton.unlockUserDEK;
        try {
            assertStatus(await checks.isoSecureAuth.evaluate(), 'fail', 'no lockout api');
        } finally { encryptionSingleton.unlockUserDEK = saved; }
    });

    log.info('\n▶ ISO 27001 A.8.24 — Cryptography');
    await t('pass with the shipped module and platform keys set', async () => {
        resetState();
        process.env.MASTER_ENCRYPTION_KEY = 'set';
        process.env.SESSION_SECRET = 'set';
        assertStatus(await checks.isoCryptography.evaluate(), 'pass', 'intact crypto');
    });
    await t('warn when MASTER_ENCRYPTION_KEY is not set', async () => {
        resetState();
        delete process.env.MASTER_ENCRYPTION_KEY;
        try {
            assertStatus(await checks.isoCryptography.evaluate(), 'warn', 'no master key');
        } finally { process.env.MASTER_ENCRYPTION_KEY = 'restore'; }
    });
    await t('fail when a core export disappears', async () => {
        resetState();
        process.env.MASTER_ENCRYPTION_KEY = 'set';
        const saved = encryptionSingleton.rewrapUserDEK;
        delete encryptionSingleton.rewrapUserDEK;
        try {
            assertStatus(await checks.isoCryptography.evaluate(), 'fail', 'missing export');
        } finally { encryptionSingleton.rewrapUserDEK = saved; }
    });

    log.info('\n▶ ISO 27001 A.8.15/8.16 — Security event logging');
    const liveLedgers = (integration, guardrail, auth) => ([
        { query: /COUNT\(\*\)::int AS c FROM integration_activity_log/, row: { c: integration } },
        { query: /COUNT\(\*\)::int AS c FROM guardrail_events/, row: { c: guardrail } },
        { query: /COUNT\(\*\)::int AS c FROM access_audit_log/, row: { c: auth } },
        { query: /MIN\(timestamp\).*FROM integration_activity_log/, row: { age: 120 } },
        { query: /MIN\(timestamp\).*FROM guardrail_events/, row: { age: 200 } },
        { query: /MIN\(created_at\).*FROM access_audit_log/, row: { age: 90 } },
    ]);
    await t('pass when all three ledgers received events recently', async () => {
        resetState();
        _state.dbOne = liveLedgers(34, 5, 12);
        assertStatus(await checks.isoLogging.evaluate('x'), 'pass', 'all ledgers live');
    });
    await t('warn when one ledger is quiet despite history', async () => {
        resetState();
        _state.dbOne = liveLedgers(34, 0, 12);
        assertStatus(await checks.isoLogging.evaluate('x'), 'warn', 'guardrail ledger quiet');
    });
    await t('warn when nobody signed in — the clause names access attempts first', async () => {
        // The state this control was passing in before authentication was
        // logged at all: two busy ledgers, and not one recorded sign-in.
        resetState();
        _state.dbOne = liveLedgers(34, 5, 0);
        const res = await checks.isoLogging.evaluate('x');
        assertStatus(res, 'warn', 'authentication ledger quiet');
        if (!/authentication log/.test(res.details)) {
            throw new Error(`details do not name the quiet ledger: ${res.details}`);
        }
    });
    await t('warn (not fail) on a young install with no events at all', async () => {
        resetState();
        assertStatus(await checks.isoLogging.evaluate('x'), 'warn', 'young install');
    });

    log.info('\n▶ ISO 27001 A.8.10 — Information deletion');
    await t('pass with fresh heartbeat and fulfilled deletions', async () => {
        resetState();
        _state.settings.last_retention_run_at = new Date(Date.now() - 3600 * 1000).toISOString();
        _state.dsrStats.deletion = { total: 2, open: 0, overdue: 0, fulfilled: 2, avg_days_to_fulfil: 3 };
        assertStatus(await checks.isoDeletion.evaluate('x'), 'pass', 'fresh heartbeat + fulfilled');
    });
    await t('pass with fresh heartbeat and zero deletion requests', async () => {
        resetState();
        _state.settings.last_retention_run_at = new Date(Date.now() - 3600 * 1000).toISOString();
        assertStatus(await checks.isoDeletion.evaluate('x'), 'pass', 'no requests');
    });
    await t('fail when the retention enforcer never ran', async () => {
        resetState();
        _state.dsrStats.deletion = { total: 2, open: 0, overdue: 0, fulfilled: 2, avg_days_to_fulfil: 3 };
        assertStatus(await checks.isoDeletion.evaluate('x'), 'fail', 'no heartbeat');
    });
    await t('fail when the heartbeat is stale (48h)', async () => {
        resetState();
        _state.settings.last_retention_run_at = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        assertStatus(await checks.isoDeletion.evaluate('x'), 'fail', 'stale heartbeat');
    });
    await t('fail when a deletion request is overdue despite a fresh heartbeat', async () => {
        resetState();
        _state.settings.last_retention_run_at = new Date(Date.now() - 3600 * 1000).toISOString();
        _state.dsrStats.deletion = { total: 3, open: 1, overdue: 1, fulfilled: 2, avg_days_to_fulfil: 5 };
        assertStatus(await checks.isoDeletion.evaluate('x'), 'fail', 'overdue deletion');
    });

    log.info('\n▶ ISO 27001 A.8.11/8.12 — Data masking & leak prevention');
    await t('fail when no leak-prevention layer is configured', async () => {
        resetState();
        assertStatus(await checks.isoDlp.evaluate('x'), 'fail', 'nothing configured');
    });
    await t('warn when only one layer is on', async () => {
        resetState();
        _state.config['ai'] = { regexGuardrails: [{ id: 'a' }] };
        assertStatus(await checks.isoDlp.evaluate('x'), 'warn', 'partial layers');
    });
    await t('warn when configured but no traffic yet', async () => {
        resetState();
        _state.config['org_privacy_shield_x'] = { enabled: true, collectionIds: ['c1'] };
        _state.dbOne = [
            { query: /total_events/, row: { total_events: 0, blocked_events: 0, redacted_events: 0 } },
            { query: /ai_usage_log/, row: { c: 3 } },
        ];
        assertStatus(await checks.isoDlp.evaluate('x'), 'warn', 'no traffic yet');
    });
    await t('warn when real traffic produces zero guardrail events', async () => {
        resetState();
        _state.config['org_privacy_shield_x'] = { enabled: true, collectionIds: ['c1'] };
        _state.dbOne = [
            { query: /total_events/, row: { total_events: 0, blocked_events: 0, redacted_events: 0 } },
            { query: /ai_usage_log/, row: { c: 500 } },
        ];
        assertStatus(await checks.isoDlp.evaluate('x'), 'warn', 'silent shield');
    });
    await t('pass when masking and blocking demonstrably fire on real traffic', async () => {
        resetState();
        _state.config['org_privacy_shield_x'] = { enabled: true, collectionIds: ['c1'] };
        _state.dbOne = [
            { query: /total_events/, row: { total_events: 12, blocked_events: 2, redacted_events: 6 } },
            { query: /ai_usage_log/, row: { c: 500 } },
        ];
        assertStatus(await checks.isoDlp.evaluate('x'), 'pass', 'events observed');
    });
};
const log = require('../../../telemetry/log');
