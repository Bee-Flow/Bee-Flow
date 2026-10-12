/**
 * Smoke scenarios — GDPR data lifecycle and accountability:
 * Art. 5(1)(e) storage limitation, Art. 15/17 DSR SLAs, Art. 30 RoPA,
 * Art. 35 DPIA, Art. 28 processor agreements and Art. 32(1)(d) DLP efficacy.
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function gdprDataLifecycle() {
    log.info('\n▶ GDPR Art. 5(1)(e) — Storage limitation');
    await t('pass with fresh heartbeat and no orphans', async () => {
        resetState();
        _state.settings.last_retention_run_at = new Date(Date.now() - 3600 * 1000).toISOString();
        _state.settings.default_retention_days = 365;
        _state.dbOne = [{ query: /user_memories/, row: { c: 0 } }];
        assertStatus(await checks.storageLimitation.evaluate('x'), 'pass', 'fresh heartbeat');
    });
    await t('fail when enforcer never ran', async () => {
        resetState();
        _state.dbOne = [{ query: /user_memories/, row: { c: 0 } }];
        assertStatus(await checks.storageLimitation.evaluate('x'), 'fail', 'no heartbeat');
    });
    await t('warn when orphan memories exceed the window', async () => {
        resetState();
        _state.settings.last_retention_run_at = new Date(Date.now() - 3600 * 1000).toISOString();
        _state.dbOne = [{ query: /user_memories/, row: { c: 7 } }];
        assertStatus(await checks.storageLimitation.evaluate('x'), 'warn', 'orphans');
    });

    log.info('\n▶ GDPR Art. 15 — DSR access SLA');
    await t('not_applicable with no requests', async () => {
        resetState();
        assertStatus(await checks.dsrAccess.evaluate('x'), 'not_applicable', 'no requests');
    });
    await t('pass when all fulfilled in time', async () => {
        resetState();
        _state.dsrStats.access = { total: 3, open: 0, overdue: 0, fulfilled: 3, avg_days_to_fulfil: 4.2 };
        assertStatus(await checks.dsrAccess.evaluate('x'), 'pass', 'fulfilled');
    });
    await t('warn when open requests approach the deadline', async () => {
        resetState();
        _state.dsrStats.access = { total: 3, open: 1, overdue: 0, nearing: 1, fulfilled: 2, avg_days_to_fulfil: 10 };
        assertStatus(await checks.dsrAccess.evaluate('x'), 'warn', 'open slow');
    });
    await t('fail when a request is overdue', async () => {
        resetState();
        _state.dsrStats.access = { total: 3, open: 1, overdue: 1, fulfilled: 2, avg_days_to_fulfil: 10 };
        assertStatus(await checks.dsrAccess.evaluate('x'), 'fail', 'overdue');
    });

    log.info('\n▶ GDPR Art. 17 — DSR deletion SLA');
    await t('not_applicable with no requests', async () => {
        resetState();
        assertStatus(await checks.dsrDeletion.evaluate('x'), 'not_applicable', 'no requests');
    });
    await t('fail when a deletion request is overdue', async () => {
        resetState();
        _state.dsrStats.deletion = { total: 1, open: 1, overdue: 1, fulfilled: 0, avg_days_to_fulfil: 0 };
        assertStatus(await checks.dsrDeletion.evaluate('x'), 'fail', 'overdue deletion');
    });
    await t('pass when fulfilled', async () => {
        resetState();
        _state.dsrStats.deletion = { total: 2, open: 0, overdue: 0, fulfilled: 2, avg_days_to_fulfil: 3 };
        assertStatus(await checks.dsrDeletion.evaluate('x'), 'pass', 'fulfilled deletion');
    });

    log.info('\n▶ GDPR Art. 30 — RoPA reviewed');
    await t('warn when never reviewed', async () => {
        resetState();
        assertStatus(await checks.ropaReviewed.evaluate('x'), 'warn', 'never reviewed');
    });
    await t('pass when reviewed recently', async () => {
        resetState();
        _state.settings.ropa_reviewed_at = new Date(Date.now() - 30 * 86400000).toISOString();
        assertStatus(await checks.ropaReviewed.evaluate('x'), 'pass', 'recent review');
    });
    await t('warn when review is 300+ days old', async () => {
        resetState();
        _state.settings.ropa_reviewed_at = new Date(Date.now() - 320 * 86400000).toISOString();
        assertStatus(await checks.ropaReviewed.evaluate('x'), 'warn', 'aging review');
    });
    await t('fail when review is over a year old', async () => {
        resetState();
        _state.settings.ropa_reviewed_at = new Date(Date.now() - 400 * 86400000).toISOString();
        assertStatus(await checks.ropaReviewed.evaluate('x'), 'fail', 'stale review');
    });

    log.info('\n▶ GDPR Art. 35 — DPIA for high-risk agents');
    const subject = { id: 'a1', label: 'HR screener', risk_reason: 'system prompt mentions automated decisions' };
    await t('not_applicable without a subject', async () => {
        resetState();
        assertStatus(await checks.dpiaHighRisk.evaluate('x', null), 'not_applicable', 'no subject');
    });
    await t('fail when no DPIA on record', async () => {
        resetState();
        assertStatus(await checks.dpiaHighRisk.evaluate('x', subject), 'fail', 'no dpia');
    });
    await t('warn when DPIA expired', async () => {
        resetState();
        _state.dpia = {
            mode: 'attestation', approved_at: new Date(Date.now() - 400 * 86400000).toISOString(),
            approved_by: 'u1', expires_at: new Date(Date.now() - 30 * 86400000).toISOString(),
        };
        assertStatus(await checks.dpiaHighRisk.evaluate('x', subject), 'warn', 'expired dpia');
    });
    await t('pass with current DPIA', async () => {
        resetState();
        _state.dpia = {
            mode: 'questionnaire', approved_at: new Date(Date.now() - 30 * 86400000).toISOString(),
            approved_by: 'u1', expires_at: new Date(Date.now() + 300 * 86400000).toISOString(),
        };
        assertStatus(await checks.dpiaHighRisk.evaluate('x', subject), 'pass', 'current dpia');
    });
    await t('listSubjects flags decision-keyword agents only', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [
                { id: '1', name: 'Recruiter', system_prompt: 'You approve or reject candidates.', model: 'ollama/llama3', config: '{}', organization_id: 'x' },
                { id: '2', name: 'FAQ bot', system_prompt: 'Answer questions about the handbook.', model: 'ollama/llama3', config: '{}', organization_id: 'x' },
            ],
        }];
        const subjects = await checks.dpiaHighRisk.listSubjects('x');
        if (subjects.length !== 1 || subjects[0].id !== '1') {
            throw new Error(`expected only the decision-making agent, got ${JSON.stringify(subjects)}`);
        }
    });

    log.info('\n▶ GDPR Art. 28 — Processor agreements');
    await t('not_applicable without observed traffic', async () => {
        resetState();
        assertStatus(await checks.subprocessors.evaluate('x'), 'not_applicable', 'no traffic');
    });
    await t('warn when an observed operator lacks an attestation', async () => {
        resetState();
        _state.dbRows = [{
            query: /integration_activity_log/,
            rows: [{ operator: 'openai', is_eu: false, calls: 9 }],
        }];
        assertStatus(await checks.subprocessors.evaluate('x'), 'warn', 'uncovered operator');
    });
    await t('pass when every observed operator is attested', async () => {
        resetState();
        _state.settings.scc_confirmed_operators = [{ operator: 'openai' }];
        _state.dbRows = [{
            query: /integration_activity_log/,
            rows: [{ operator: 'openai', is_eu: false, calls: 9 }],
        }];
        assertStatus(await checks.subprocessors.evaluate('x'), 'pass', 'all attested');
    });

    log.info('\n▶ GDPR Art. 32(1)(d) — DLP effectiveness');
    await t('not_applicable when DLP is off', async () => {
        resetState();
        assertStatus(await checks.dlpEfficacy.evaluate('x'), 'not_applicable', 'dlp off');
    });
    await t('not_applicable with DLP on but negligible traffic — "cannot judge" is not a pass', async () => {
        resetState();
        _state.config['org_privacy_shield_x'] = { enabled: true };
        _state.dbOne = [
            { query: /ai_usage_log/, row: { c: 3 } },
            { query: /guardrail_events/, row: { c: 0 } },
        ];
        assertStatus(await checks.dlpEfficacy.evaluate('x'), 'not_applicable', 'low traffic');
    });
    await t('warn when real traffic produces zero guardrail events', async () => {
        resetState();
        _state.config['org_privacy_shield_x'] = { enabled: true };
        _state.dbOne = [
            { query: /ai_usage_log/, row: { c: 500 } },
            { query: /guardrail_events/, row: { c: 0 } },
        ];
        assertStatus(await checks.dlpEfficacy.evaluate('x'), 'warn', 'silent shield');
    });
    await t('pass when the shield demonstrably fires', async () => {
        resetState();
        _state.config['org_privacy_shield_x'] = { enabled: true };
        _state.dbOne = [
            { query: /ai_usage_log/, row: { c: 500 } },
            { query: /guardrail_events/, row: { c: 12 } },
        ];
        assertStatus(await checks.dlpEfficacy.evaluate('x'), 'pass', 'events observed');
    });
};
