/**
 * Smoke scenarios — ISO 27001 checks on the public edge:
 * A.5.14 mail spoofing protection and A.8.24 TLS on public endpoints.
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function isoMailAndTls() {
    log.info('\n▶ ISO 27001 A.5.14 — Mail spoofing protection');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoMailSecurity.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('warn when enabled but never swept', async () => {
        resetState();
        _state.isoConnectorConfigs['mail-security'] = { enabled: true };
        assertStatus(await checks.isoMailSecurity.evaluate('x'), 'warn', 'no snapshot yet');
    });
    await t('fail when neither SPF nor DMARC exists', async () => {
        resetState();
        _state.isoConnectorConfigs['mail-security'] = { enabled: true };
        _state.isoSnapshots['mail-security'] = [{
            fetched_at: new Date().toISOString(),
            payload: { domain: 'acme.nl', spf: { present: false }, dmarc: { present: false }, dkim: { found_selectors: [] } },
        }];
        assertStatus(await checks.isoMailSecurity.evaluate('x'), 'fail', 'wide open to spoofing');
    });
    await t('warn on a non-enforcing DMARC policy', async () => {
        resetState();
        _state.isoConnectorConfigs['mail-security'] = { enabled: true };
        _state.isoSnapshots['mail-security'] = [{
            fetched_at: new Date().toISOString(),
            payload: { domain: 'acme.nl', spf: { present: true }, dmarc: { present: true, policy: 'none' }, dkim: { found_selectors: ['google'] } },
        }];
        assertStatus(await checks.isoMailSecurity.evaluate('x'), 'warn', 'p=none is not enforcement');
    });
    await t('pass with SPF + enforcing DMARC + DKIM', async () => {
        resetState();
        _state.isoConnectorConfigs['mail-security'] = { enabled: true };
        _state.isoSnapshots['mail-security'] = [{
            fetched_at: new Date().toISOString(),
            payload: { domain: 'acme.nl', spf: { present: true }, dmarc: { present: true, policy: 'reject' }, dkim: { found_selectors: ['google'] } },
        }];
        assertStatus(await checks.isoMailSecurity.evaluate('x'), 'pass', 'full mail auth');
    });

    log.info('\n▶ ISO 27001 A.8.24 — TLS on public endpoints');
    await t('not applicable when the connector is disabled', async () => {
        resetState();
        assertStatus(await checks.isoTlsEndpoints.evaluate('x'), 'not_applicable', 'connector off');
    });
    await t('fail on an expired certificate', async () => {
        resetState();
        _state.isoConnectorConfigs['tls-endpoints'] = { enabled: true };
        _state.isoSnapshots['tls-endpoints'] = [{
            payload: { host: 'app.acme.nl', reachable: true, protocol: 'TLSv1.3', days_remaining: -2, authorized: true },
        }];
        assertStatus(await checks.isoTlsEndpoints.evaluate('x'), 'fail', 'expired cert');
    });
    await t('warn on a legacy protocol', async () => {
        resetState();
        _state.isoConnectorConfigs['tls-endpoints'] = { enabled: true };
        _state.isoSnapshots['tls-endpoints'] = [{
            payload: { host: 'old.acme.nl', reachable: true, protocol: 'TLSv1.1', days_remaining: 200, authorized: true },
        }];
        assertStatus(await checks.isoTlsEndpoints.evaluate('x'), 'warn', 'TLSv1.1');
    });
    await t('warn when a certificate expires within 30 days', async () => {
        resetState();
        _state.isoConnectorConfigs['tls-endpoints'] = { enabled: true };
        _state.isoSnapshots['tls-endpoints'] = [{
            payload: { host: 'app.acme.nl', reachable: true, protocol: 'TLSv1.3', days_remaining: 10, authorized: true },
        }];
        assertStatus(await checks.isoTlsEndpoints.evaluate('x'), 'warn', 'renew soon');
    });
    await t('pass with healthy endpoints; skipped private hosts are ignored', async () => {
        resetState();
        _state.isoConnectorConfigs['tls-endpoints'] = { enabled: true };
        _state.isoSnapshots['tls-endpoints'] = [
            { payload: { host: 'app.acme.nl', reachable: true, protocol: 'TLSv1.3', days_remaining: 120, authorized: true } },
            { payload: { host: 'internal.local', skipped: 'private_hostname' } },
        ];
        assertStatus(await checks.isoTlsEndpoints.evaluate('x'), 'pass', 'healthy TLS');
    });
};
