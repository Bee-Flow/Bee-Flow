// @typecheck
/**
 * The guard installer without a Docker socket (services/guardInstaller.js).
 *
 * The default compose stacks no longer mount /var/run/docker.sock into the
 * server. The installer must then SAY so (status carries `dockerSocket: false`
 * and the reason that names the opt-in override) instead of probing a socket
 * that is not there, and install/uninstall must refuse with UNSUPPORTED_ENV,
 * which the route turns into a 409 the admin UI can show.
 *
 * Run: cd server && node --test services/guardInstaller.socket.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { useConfigRows } = require('../testUtils/configRows');

const config = useConfigRows();
const installer = require('./guardInstaller');

test.after(() => { installer._setSocketProbeForTests(null); config.restore(); });
test.beforeEach(() => { config.reset(); delete process.env.KUBERNETES_SERVICE_HOST; });

test('without the socket, status reports it and names the opt-in instead of probing Docker', async () => {
    installer._setSocketProbeForTests(() => false);
    const status = await installer.getStatus();
    assert.strictEqual(status.dockerSocket, false);
    assert.strictEqual(status.status, installer.STATUS.NOT_INSTALLED);
    assert.match(status.unavailableReason, /not available on this install/);
    assert.match(status.unavailableReason, /docker-compose\.docker-socket\.override\.yml/);
    assert.match(status.unavailableReason, /guard/);
});

test('an install done while the socket was mounted is still reported after it was taken away', async () => {
    installer._setSocketProbeForTests(() => false);
    config.rows.pii_guard_installed = installer.STATUS.RUNNING;
    config.rows.pii_guard_url = 'http://beeflow-guard:8100';
    const status = await installer.getStatus();
    assert.strictEqual(status.status, installer.STATUS.RUNNING);
    assert.strictEqual(status.url, 'http://beeflow-guard:8100');
    assert.strictEqual(status.dockerSocket, false);
});

test('install and uninstall refuse with UNSUPPORTED_ENV when the socket is absent', () => {
    installer._setSocketProbeForTests(() => false);
    for (const run of [() => installer.install({ apiKey: 'k' }), () => installer.uninstall()]) {
        assert.throws(run, (err) => {
            assert.strictEqual(/** @type {{ code?: string }} */ (err).code, 'UNSUPPORTED_ENV');
            assert.match(/** @type {Error} */ (err).message, /docker-compose\.docker-socket\.override\.yml/);
            return true;
        });
    }
});

test('with the socket present the status does not carry the unavailable reason', async () => {
    installer._setSocketProbeForTests(() => true);
    // The probe says yes; the Docker calls behind it fail in this test
    // process and are logged, which getStatus already tolerates.
    const status = await installer.getStatus();
    assert.strictEqual(status.dockerSocket, true);
    assert.strictEqual(status.unavailableReason, null);
});
