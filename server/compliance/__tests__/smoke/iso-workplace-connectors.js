/**
 * Smoke scenarios — ISO 27001 checks that only report (never fail by design):
 * A.8.19 workplace server software (Nextcloud), A.6.5 HR offboarding feed
 * (AFAS) and A.8.32 ticketed changes (YouTrack).
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function isoWorkplaceConnectors() {
    log.info('\n▶ ISO 27001 A.8.19 — Workplace server software (never fails by design)');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoWorkplaceSoftware.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['nextcloud'] = { enabled: true };
        assertStatus(await checks.isoWorkplaceSoftware.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('warn when serverinfo reported no version', async () => {
        resetState();
        _state.isoConnectorConfigs['nextcloud'] = { enabled: true };
        _state.isoSnapshots['nextcloud'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { source: 'nextcloud', version: null, apps_updates_available: null, users: null, version_outdated_hint: null },
        }];
        assertStatus(await checks.isoWorkplaceSoftware.evaluate('x'), 'warn', 'version missing');
    });
    await t('pass when a version is recorded', async () => {
        resetState();
        _state.isoConnectorConfigs['nextcloud'] = { enabled: true };
        _state.isoSnapshots['nextcloud'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { source: 'nextcloud', version: '31.0.2.1', apps_updates_available: 3, users: 42, version_outdated_hint: null },
        }];
        assertStatus(await checks.isoWorkplaceSoftware.evaluate('x'), 'pass', 'version pinned');
    });

    log.info('\n▶ ISO 27001 A.6.5 — HR offboarding feed (never fails by design)');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoOffboardingFeed.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['afas'] = { enabled: true, settings: { connector: 'Profit_Employees' } };
        assertStatus(await checks.isoOffboardingFeed.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('warn when the feed answers but returns zero rows', async () => {
        resetState();
        _state.isoConnectorConfigs['afas'] = { enabled: true, settings: { connector: 'Profit_Employees' } };
        _state.isoSnapshots['afas'] = [{
            subject_id: 'Profit_Employees',
            fetched_at: new Date().toISOString(),
            payload: { source: 'afas', connector: 'Profit_Employees', rows: 0, fields: [], fetched: true },
        }];
        assertStatus(await checks.isoOffboardingFeed.evaluate('x'), 'warn', 'empty feed');
    });
    await t('pass when employee rows exist', async () => {
        resetState();
        _state.isoConnectorConfigs['afas'] = { enabled: true, settings: { connector: 'Profit_Employees' } };
        _state.isoSnapshots['afas'] = [{
            subject_id: 'Profit_Employees',
            fetched_at: new Date().toISOString(),
            payload: { source: 'afas', connector: 'Profit_Employees', rows: 87, fields: ['EmployeeId', 'StartDate'], fetched: true },
        }];
        assertStatus(await checks.isoOffboardingFeed.evaluate('x'), 'pass', 'population present');
    });

    log.info('\n▶ ISO 27001 A.8.32 — Ticketed changes (never fails by design)');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoTicketedChanges.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['youtrack'] = { enabled: true, settings: { project: 'OPS' } };
        assertStatus(await checks.isoTicketedChanges.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('warn when the project shows no activity in 30 days', async () => {
        resetState();
        _state.isoConnectorConfigs['youtrack'] = { enabled: true, settings: { project: 'OPS' } };
        _state.isoSnapshots['youtrack'] = [{
            subject_id: 'OPS',
            fetched_at: new Date().toISOString(),
            payload: { source: 'youtrack', project: 'OPS', window_days: 30, recent_issues: 0, resolved_recent: 0 },
        }];
        assertStatus(await checks.isoTicketedChanges.evaluate('x'), 'warn', 'silent project');
    });
    await t('pass with recent ticket activity', async () => {
        resetState();
        _state.isoConnectorConfigs['youtrack'] = { enabled: true, settings: { project: 'OPS' } };
        _state.isoSnapshots['youtrack'] = [{
            subject_id: 'OPS',
            fetched_at: new Date().toISOString(),
            payload: { source: 'youtrack', project: 'OPS', window_days: 30, recent_issues: 14, resolved_recent: 9 },
        }];
        assertStatus(await checks.isoTicketedChanges.evaluate('x'), 'pass', 'tickets in use');
    });
};
