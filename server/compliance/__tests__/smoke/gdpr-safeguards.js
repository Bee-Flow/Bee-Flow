/**
 * Smoke scenarios — GDPR technical and organisational safeguards:
 * Art. 32 (encryption, DLP, access logging), Art. 33 (breach detection),
 * Art. 37 (DPO), Art. 12 (privacy notice) and Art. 44 (external transfers).
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function gdprSafeguards() {
    log.info('\n▶ GDPR Art. 32 — Encryption at rest');
    await t('pass when env vars are set and the org writes message bodies encrypted', async () => {
        resetState();
        process.env.MASTER_ENCRYPTION_KEY = 'set';
        process.env.SESSION_SECRET = 'set';
        _state.dbOne.push({ query: /encryption_tier/, row: { encryption_tier: 'managed', encryption_scope: null } });
        assertStatus(await checks.encryptionAtRest.evaluate('org-enc'), 'pass', 'both set, managed tier');
    });
    await t('warn when env vars are set but the org tier is "none"', async () => {
        resetState();
        assertStatus(await checks.encryptionAtRest.evaluate('org-plain'), 'warn', 'both set, tier none');
    });
    await t('fail when master key missing', async () => {
        delete process.env.MASTER_ENCRYPTION_KEY;
        assertStatus(await checks.encryptionAtRest.evaluate(), 'fail', 'missing master');
        process.env.MASTER_ENCRYPTION_KEY = 'restore';
    });

    log.info('\n▶ GDPR Art. 32 — Encryption in transit');
    await t('pass in production with TRUST_PROXY', async () => {
        process.env.NODE_ENV = 'production'; process.env.TRUST_PROXY = '1';
        assertStatus(await checks.encryptionInTransit.evaluate(), 'pass', 'prod+proxy');
    });
    await t('warn in development', async () => {
        process.env.NODE_ENV = 'development'; delete process.env.TRUST_PROXY;
        assertStatus(await checks.encryptionInTransit.evaluate(), 'warn', 'dev');
    });

    log.info('\n▶ GDPR Art. 32 — DLP enabled');
    await t('pass when org shield has all three layers', async () => {
        resetState();
        _state.config['org_privacy_shield_default'] = {
            enabled: true, collectionIds: ['x'],
            azurePiiEnabled: true, piiDetectionCategories: ['email'],
            moderationEnabled: true,
        };
        assertStatus(await checks.dlp.evaluate('default'), 'pass', 'shield full');
    });
    await t('pass using global ai-config fallback', async () => {
        resetState();
        _state.config['ai'] = {
            regexGuardrails: [{ id: 'a' }],
            piiDetectionCategories: ['email', 'iban'],
            moderationEnabled: true,
        };
        assertStatus(await checks.dlp.evaluate('acme'), 'pass', 'global fallback');
    });
    await t('fail when nothing configured', async () => {
        resetState();
        assertStatus(await checks.dlp.evaluate('acme'), 'fail', 'empty');
    });

    log.info('\n▶ GDPR Art. 32 — Access logging');
    await t('pass when recent events exist', async () => {
        resetState();
        _state.dbOne = [{ query: /guardrail_events/, row: { c: 42 } }];
        assertStatus(await checks.accessLogging.evaluate('default'), 'pass', 'events present');
    });
    await t('warn when no events in 7d', async () => {
        resetState();
        _state.dbOne = [{ query: /guardrail_events/, row: { c: 0 } }];
        assertStatus(await checks.accessLogging.evaluate('default'), 'warn', 'no events');
    });

    log.info('\n▶ GDPR Art. 33 — Breach detection');
    await t('pass with valid recipient', async () => {
        resetState();
        _state.settings.breach_recipients = ['dpo@example.com'];
        assertStatus(await checks.breachDetection.evaluate('x'), 'pass', 'one recipient');
    });
    await t('fail when no recipients', async () => {
        resetState();
        assertStatus(await checks.breachDetection.evaluate('x'), 'fail', 'empty');
    });
    await t('fail when recipients without @', async () => {
        resetState();
        _state.settings.breach_recipients = ['not-an-email'];
        assertStatus(await checks.breachDetection.evaluate('x'), 'fail', 'invalid emails');
    });
    await t('fail when an open incident is past the 72h deadline unnotified', async () => {
        resetState();
        _state.settings.breach_recipients = ['dpo@example.com'];
        _state.incidentDeadlines = { open: 1, overdue_unnotified: 1, nearing_deadline: 0 };
        assertStatus(await checks.breachDetection.evaluate('x'), 'fail', 'overdue incident');
    });
    await t('warn when an incident nears the 72h deadline', async () => {
        resetState();
        _state.settings.breach_recipients = ['dpo@example.com'];
        _state.incidentDeadlines = { open: 1, overdue_unnotified: 0, nearing_deadline: 1 };
        assertStatus(await checks.breachDetection.evaluate('x'), 'warn', 'nearing deadline');
    });
    await t('pass with open incidents still inside the window', async () => {
        resetState();
        _state.settings.breach_recipients = ['dpo@example.com'];
        _state.incidentDeadlines = { open: 2, overdue_unnotified: 0, nearing_deadline: 0 };
        assertStatus(await checks.breachDetection.evaluate('x'), 'pass', 'inside window');
    });

    log.info('\n▶ GDPR Art. 37 — DPO appointed');
    await t('pass with name and email', async () => {
        resetState();
        _state.settings.dpo_name = 'Jane Doe'; _state.settings.dpo_email = 'jane@example.com';
        assertStatus(await checks.dpo.evaluate('x'), 'pass', 'full dpo');
    });
    await t('fail without dpo', async () => {
        resetState();
        assertStatus(await checks.dpo.evaluate('x'), 'fail', 'empty dpo');
    });

    log.info('\n▶ GDPR Art. 12 — Privacy notice');
    await t('pass with https url', async () => {
        resetState();
        _state.settings.privacy_notice_url = 'https://example.com/privacy';
        assertStatus(await checks.privacyNotice.evaluate('x'), 'pass', 'url set');
    });
    await t('fail when empty', async () => {
        resetState();
        assertStatus(await checks.privacyNotice.evaluate('x'), 'fail', 'empty url');
    });

    log.info('\n▶ GDPR Art. 44 — External transfers');
    // Primary signal: the outbound activity ledger (integration_activity_log).
    await t('fail when non-EU operator has no SCC attestation', async () => {
        resetState();
        _state.dbRows = [{
            query: /integration_activity_log/,
            rows: [{ operator: 'openai', country_code: 'US', country_name: 'United States', is_eu: false, is_local: false, calls: 12 }],
        }];
        assertStatus(await checks.externalTransfers.evaluate('x'), 'fail', 'non-EU unconfirmed');
    });
    await t('pass when non-EU operator is SCC-attested', async () => {
        resetState();
        _state.settings.scc_confirmed_operators = [{ operator: 'openai', confirmed_at: new Date().toISOString() }];
        _state.dbRows = [{
            query: /integration_activity_log/,
            rows: [{ operator: 'openai', country_code: 'US', country_name: 'United States', is_eu: false, is_local: false, calls: 12 }],
        }];
        assertStatus(await checks.externalTransfers.evaluate('x'), 'pass', 'SCC attested');
    });
    await t('pass when all traffic is EU or local', async () => {
        resetState();
        _state.dbRows = [{
            query: /integration_activity_log/,
            rows: [{ operator: 'scaleway', country_code: 'FR', country_name: 'France', is_eu: true, is_local: false, calls: 40 }],
        }];
        assertStatus(await checks.externalTransfers.evaluate('x'), 'pass', 'EU only');
    });
    // Fallback signal (no traffic yet): provider list + agent model scan.
    await t('not_applicable when nothing is configured at all', async () => {
        resetState();
        _state.config['ai'] = { providers: [] };
        assertStatus(await checks.externalTransfers.evaluate('x'), 'not_applicable', 'no providers');
    });
    await t('pass with internal provider only (ollama)', async () => {
        resetState();
        _state.config['ai'] = { providers: [{ id: 'a', type: 'ollama', url: 'http://ollama:11434', apiKey: 'none' }] };
        assertStatus(await checks.externalTransfers.evaluate('x'), 'pass', 'internal only');
    });
    await t('warn when agent uses external-prefixed model', async () => {
        resetState();
        _state.config['ai'] = { providers: [] };
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [{ id: '1', name: 'A', model: 'openai/gpt-4o', organization_id: 'x' }],
        }];
        assertStatus(await checks.externalTransfers.evaluate('x'), 'warn', 'agent model openai/');
    });
    await t('not_applicable when agent uses bare model name without provider prefix', async () => {
        resetState();
        _state.config['ai'] = { providers: [] };
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [{ id: '1', name: 'A', model: 'gpt-4o', organization_id: 'x' }],
        }];
        assertStatus(await checks.externalTransfers.evaluate('x'), 'not_applicable', 'bare model, nothing external');
    });
};
