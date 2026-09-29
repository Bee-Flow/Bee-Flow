/**
 * Smoke scenarios — AI Act deployer obligations:
 * Art. 4 (AI literacy), Art. 26 (human oversight), Art. 26(6) (log retention)
 * and Art. 53 (GPAI model inventory).
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function aiaOversight() {
    log.info('\n▶ AIA Art. 4 — AI literacy');
    await t('warn when never attested', async () => {
        resetState();
        assertStatus(await checks.aiLiteracy.evaluate('x'), 'warn', 'never attested');
    });
    await t('pass with a recent attestation', async () => {
        resetState();
        _state.settings.ai_literacy_confirmed_at = new Date(Date.now() - 30 * 86400000).toISOString();
        assertStatus(await checks.aiLiteracy.evaluate('x'), 'pass', 'recent');
    });
    await t('warn when the attestation is over a year old', async () => {
        resetState();
        _state.settings.ai_literacy_confirmed_at = new Date(Date.now() - 400 * 86400000).toISOString();
        assertStatus(await checks.aiLiteracy.evaluate('x'), 'warn', 'stale');
    });

    log.info('\n▶ AIA Art. 26 — Human oversight');
    const hrSubject = { id: 'a1', label: 'HR screener', risk_reason: 'automated decisions' };
    await t('fail without a current DPIA', async () => {
        resetState();
        assertStatus(await checks.humanOversight.evaluate('x', hrSubject), 'fail', 'no dpia');
    });
    await t('warn when the DPIA has no oversight answer', async () => {
        resetState();
        _state.dpia = {
            mode: 'attestation', approved_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 300 * 86400000).toISOString(), answers: {},
        };
        assertStatus(await checks.humanOversight.evaluate('x', hrSubject), 'warn', 'no oversight named');
    });
    await t('pass when oversight is named', async () => {
        resetState();
        _state.dpia = {
            mode: 'questionnaire', approved_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 300 * 86400000).toISOString(),
            answers: { human_oversight: 'HR manager reviews every verdict' },
        };
        assertStatus(await checks.humanOversight.evaluate('x', hrSubject), 'pass', 'oversight named');
    });

    log.info('\n▶ AIA Art. 26(6) — Log retention');
    await t('not_applicable with no logs at all', async () => {
        resetState();
        assertStatus(await checks.logRetention.evaluate('x'), 'not_applicable', 'no logs');
    });
    await t('pass when the log span demonstrates six months', async () => {
        resetState();
        _state.dbOne = [{ query: /integration_activity_log|guardrail_events/, row: { age: 210 } }];
        assertStatus(await checks.logRetention.evaluate('x'), 'pass', 'long span');
    });
    await t('warn when the span is short', async () => {
        resetState();
        _state.dbOne = [{ query: /integration_activity_log|guardrail_events/, row: { age: 40 } }];
        assertStatus(await checks.logRetention.evaluate('x'), 'warn', 'short span');
    });

    log.info('\n▶ AIA Art. 53 — GPAI model inventory');
    await t('not_applicable with no providers and no agent models', async () => {
        resetState();
        assertStatus(await checks.modelInventory.evaluate('x'), 'not_applicable', 'nothing configured');
    });
    await t('warn when an external model lacks an attested safeguard', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [{ id: '1', name: 'A', model: 'openai/gpt-4o', organization_id: 'x' }],
        }];
        assertStatus(await checks.modelInventory.evaluate('x'), 'warn', 'uncovered gpai');
    });
    await t('pass when external providers are attested', async () => {
        resetState();
        _state.settings.scc_confirmed_operators = [{ operator: 'openai' }];
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [{ id: '1', name: 'A', model: 'openai/gpt-4o', organization_id: 'x' }],
        }];
        assertStatus(await checks.modelInventory.evaluate('x'), 'pass', 'covered gpai');
    });
};
