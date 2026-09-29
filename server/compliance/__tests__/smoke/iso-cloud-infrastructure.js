/**
 * Smoke scenarios — ISO 27001 checks fed by the infrastructure connectors
 * (Scaleway, OpenObserve): A.8.13 server backups, A.8.20 network exposure
 * and A.8.16 log monitoring.
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function isoCloudInfrastructure() {
    log.info('\n▶ ISO 27001 A.8.13 — Server backups');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoBackups.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        assertStatus(await checks.isoBackups.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('fail when servers exist without any snapshot', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { region: 'nl-ams', servers: 3, clusters: 1, snapshots: 0, servers_with_backup: 0, newest_backup_age_days: null },
        }];
        assertStatus(await checks.isoBackups.evaluate('x'), 'fail', 'no backups at all');
    });
    await t('fail when the stalest backup exceeds 7 days', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { region: 'nl-ams', servers: 2, clusters: 0, snapshots: 4, servers_with_backup: 2, newest_backup_age_days: 9 },
        }];
        assertStatus(await checks.isoBackups.evaluate('x'), 'fail', 'stale backups');
    });
    await t('warn on 3-7 day old backups', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { region: 'nl-ams', servers: 2, clusters: 0, snapshots: 6, servers_with_backup: 2, newest_backup_age_days: 5 },
        }];
        assertStatus(await checks.isoBackups.evaluate('x'), 'warn', '5 days old');
    });
    await t('warn on partial coverage even with fresh backups', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { region: 'nl-ams', servers: 3, clusters: 0, snapshots: 5, servers_with_backup: 2, newest_backup_age_days: 1 },
        }];
        assertStatus(await checks.isoBackups.evaluate('x'), 'warn', 'one server unprotected');
    });
    await t('warn honestly when the org runs no instances', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { region: 'nl-ams', servers: 0, clusters: 2, snapshots: 0, servers_with_backup: 0, newest_backup_age_days: null },
        }];
        assertStatus(await checks.isoBackups.evaluate('x'), 'warn', 'evidence-only, no instances');
    });
    await t('pass with full coverage and backups at most 3 days old', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { region: 'nl-ams', servers: 2, clusters: 1, snapshots: 8, servers_with_backup: 2, newest_backup_age_days: 1 },
        }];
        assertStatus(await checks.isoBackups.evaluate('x'), 'pass', 'fresh backups');
    });

    log.info('\n▶ ISO 27001 A.8.20 — Network exposure');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoNetworkExposure.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        assertStatus(await checks.isoNetworkExposure.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('fail when an admin port is open to the world', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: {
                region: 'nl-ams', security_groups: 2, open_admin_ports: 1,
                open_admin_port_samples: [{ security_group_id: 'sg-1', zone: 'nl-ams-1', port: 22, ip_range: '0.0.0.0/0' }],
                inbound_default_accept_groups: 0,
            },
        }];
        assertStatus(await checks.isoNetworkExposure.evaluate('x'), 'fail', 'SSH world-open');
    });
    await t('warn when a group accepts all inbound traffic by default', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { region: 'nl-ams', security_groups: 2, open_admin_ports: 0, open_admin_port_samples: [], inbound_default_accept_groups: 1 },
        }];
        assertStatus(await checks.isoNetworkExposure.evaluate('x'), 'warn', 'default accept inbound');
    });
    await t('pass when only web ports are broad and admin ports are closed', async () => {
        resetState();
        _state.isoConnectorConfigs['scaleway'] = { enabled: true };
        _state.isoSnapshots['scaleway'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { region: 'nl-ams', security_groups: 3, open_admin_ports: 0, open_admin_port_samples: [], inbound_default_accept_groups: 0 },
        }];
        assertStatus(await checks.isoNetworkExposure.evaluate('x'), 'pass', 'admin ports closed');
    });

    log.info('\n▶ ISO 27001 A.8.16 — Log monitoring');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoMonitoring.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['openobserve'] = { enabled: true };
        assertStatus(await checks.isoMonitoring.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('fail when no data flows and no alert rules exist', async () => {
        resetState();
        _state.isoConnectorConfigs['openobserve'] = { enabled: true };
        _state.isoSnapshots['openobserve'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { streams: 0, streams_with_data: 0, alert_rules: 0, alert_rules_enabled: 0, retention_days_min: null },
        }];
        assertStatus(await checks.isoMonitoring.evaluate('x'), 'fail', 'blind and mute');
    });
    await t('warn when data flows but no alert rules exist', async () => {
        resetState();
        _state.isoConnectorConfigs['openobserve'] = { enabled: true };
        _state.isoSnapshots['openobserve'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { streams: 4, streams_with_data: 3, alert_rules: 0, alert_rules_enabled: 0, retention_days_min: 180 },
        }];
        assertStatus(await checks.isoMonitoring.evaluate('x'), 'warn', 'no alert rules');
    });
    await t('warn when retention is below 90 days', async () => {
        resetState();
        _state.isoConnectorConfigs['openobserve'] = { enabled: true };
        _state.isoSnapshots['openobserve'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { streams: 4, streams_with_data: 3, alert_rules: 2, alert_rules_enabled: 2, retention_days_min: 30 },
        }];
        assertStatus(await checks.isoMonitoring.evaluate('x'), 'warn', '30d retention');
    });
    await t('warn when the alert state could not be read', async () => {
        resetState();
        _state.isoConnectorConfigs['openobserve'] = { enabled: true };
        _state.isoSnapshots['openobserve'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { streams: 4, streams_with_data: 3, alert_rules: null, alert_rules_enabled: null, retention_days_min: 180, alerts_error: 'alerts list failed (500)' },
        }];
        assertStatus(await checks.isoMonitoring.evaluate('x'), 'warn', 'alerts unknown');
    });
    await t('pass with data flowing and an enabled alert rule', async () => {
        resetState();
        _state.isoConnectorConfigs['openobserve'] = { enabled: true };
        _state.isoSnapshots['openobserve'] = [{
            subject_id: 'summary',
            fetched_at: new Date().toISOString(),
            payload: { streams: 5, streams_with_data: 4, alert_rules: 3, alert_rules_enabled: 2, retention_days_min: 180 },
        }];
        assertStatus(await checks.isoMonitoring.evaluate('x'), 'pass', 'monitored and alerting');
    });
};
