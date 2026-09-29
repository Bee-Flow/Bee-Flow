/**
 * Smoke scenarios — ISO 27001 A.5.16 identity hygiene, fed by the directory
 * connectors (Google Workspace, Microsoft Entra).
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function isoDirectoryIdentity() {
    log.info('\n▶ ISO 27001 A.5.16 — Directory identity hygiene');
    await t('not applicable when neither directory connector is enabled', async () => {
        resetState();
        assertStatus(await checks.isoIdentityHygiene.evaluate('x'), 'not_applicable', 'no directory linked');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['google-workspace'] = { enabled: true };
        assertStatus(await checks.isoIdentityHygiene.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('fail when dormant accounts exceed 10% of the active population', async () => {
        resetState();
        _state.isoConnectorConfigs['google-workspace'] = { enabled: true };
        _state.isoSnapshots['google-workspace'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { source: 'google-workspace', users: 100, suspended: 0, mfa_enrolled: 95, admins: 2, dormant_90d: 20 },
        }];
        assertStatus(await checks.isoIdentityHygiene.evaluate('x'), 'fail', '20% dormant');
    });
    await t('fail when MFA enrolment drops below 50%', async () => {
        resetState();
        _state.isoConnectorConfigs['google-workspace'] = { enabled: true };
        _state.isoSnapshots['google-workspace'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { source: 'google-workspace', users: 100, suspended: 0, mfa_enrolled: 30, admins: 2, dormant_90d: 0 },
        }];
        assertStatus(await checks.isoIdentityHygiene.evaluate('x'), 'fail', '30% MFA');
    });
    await t('warn when Entra permissions leave dormancy and MFA unknown', async () => {
        resetState();
        _state.isoConnectorConfigs['microsoft-entra'] = { enabled: true };
        _state.isoSnapshots['microsoft-entra'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { source: 'microsoft-entra', users: 80, enabled: 78, admins: null, dormant_90d: null, mfa_capable: null },
        }];
        assertStatus(await checks.isoIdentityHygiene.evaluate('x'), 'warn', 'values unknown');
    });
    await t('warn for dormant accounts in the 1–10% band', async () => {
        resetState();
        _state.isoConnectorConfigs['google-workspace'] = { enabled: true };
        _state.isoSnapshots['google-workspace'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { source: 'google-workspace', users: 200, suspended: 0, mfa_enrolled: 195, admins: 3, dormant_90d: 10 },
        }];
        assertStatus(await checks.isoIdentityHygiene.evaluate('x'), 'warn', '5% dormant');
    });
    await t('pass when both directories are healthy', async () => {
        resetState();
        _state.isoConnectorConfigs['google-workspace'] = { enabled: true };
        _state.isoConnectorConfigs['microsoft-entra'] = { enabled: true };
        _state.isoSnapshots['google-workspace'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { source: 'google-workspace', users: 100, suspended: 2, mfa_enrolled: 97, admins: 2, dormant_90d: 0 },
        }];
        _state.isoSnapshots['microsoft-entra'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { source: 'microsoft-entra', users: 50, enabled: 50, admins: 3, dormant_90d: 0, mfa_capable: 49 },
        }];
        assertStatus(await checks.isoIdentityHygiene.evaluate('x'), 'pass', 'clean directories');
    });
};
