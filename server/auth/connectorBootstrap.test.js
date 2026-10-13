/**
 * Unit tests for the connector-bootstrap hardening helpers — the provisioning
 * policy resolver and the stable instance-id fallback. Pure logic, no DB / no
 * fetch (the full handler is integration territory).
 *
 * Run: node --test server/auth/connectorBootstrap.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { helpers } = require('./connectorBootstrap');

test('defaultProvisioningMode: official Cloud hosts default to open', () => {
    const prev = process.env.SERVER_PUBLIC_HOST;
    process.env.SERVER_PUBLIC_HOST = 'server.beeflow.nl';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    process.env.SERVER_PUBLIC_HOST = 'server.dev.beeflow.nl';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    // case-insensitive
    process.env.SERVER_PUBLIC_HOST = 'Server.BeeFlow.NL';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    if (prev === undefined) delete process.env.SERVER_PUBLIC_HOST; else process.env.SERVER_PUBLIC_HOST = prev;
});

test('defaultProvisioningMode: self-host / unset fails closed to pairing_only', () => {
    const prev = process.env.SERVER_PUBLIC_HOST;
    process.env.SERVER_PUBLIC_HOST = 'ai.acme.example';
    assert.equal(helpers.defaultProvisioningMode(), 'pairing_only');
    delete process.env.SERVER_PUBLIC_HOST;
    assert.equal(helpers.defaultProvisioningMode(), 'pairing_only');
    if (prev !== undefined) process.env.SERVER_PUBLIC_HOST = prev;
});

test('stableInstanceIdFallback: host-keyed and version-independent', () => {
    assert.equal(helpers.stableInstanceIdFallback('https://nc.example.com/', 'Acme'), 'nc-host:nc.example.com');
    // host includes the port; path is ignored
    assert.equal(helpers.stableInstanceIdFallback('https://nc.example.com:8443/foo', 'Acme'), 'nc-host:nc.example.com:8443');
});

test('stableInstanceIdFallback: malformed URL falls back to theming name', () => {
    assert.equal(helpers.stableInstanceIdFallback('not a url', 'Acme'), 'nc:Acme');
    assert.equal(helpers.stableInstanceIdFallback('', null), 'nc:nextcloud');
});

test('PROVISIONING_MODES is the closed set the admin route also enforces', () => {
    assert.deepEqual(helpers.PROVISIONING_MODES, ['open', 'pairing_only']);
});

// _selectSecondaryAdmins — which extra NC admins get provisioned besides the
// primary (the rest of the `admin` group, so any admin can onboard).
const sel = helpers._selectSecondaryAdmins;

test('selectSecondaryAdmins: drops the primary, keeps the rest (lower-cased email)', () => {
    const admins = [
        { uid: 'alice', email: 'Alice@EX.com', displayName: 'Alice' },
        { uid: 'bob', email: 'bob@ex.com', displayName: 'Bob' },
    ];
    assert.deepEqual(sel(admins, 'alice'), [{ uid: 'bob', email: 'bob@ex.com', displayName: 'Bob' }]);
});

test('selectSecondaryAdmins: drops email-less and blank-uid entries, dedups by uid', () => {
    const admins = [
        { uid: 'bob', email: 'bob@ex.com' },
        { uid: 'carol', email: '' },          // no email → dropped
        { uid: '', email: 'x@ex.com' },        // no uid → dropped
        { uid: 'bob', email: 'dupe@ex.com' },  // duplicate uid → dropped
    ];
    assert.deepEqual(sel(admins, 'alice'), [{ uid: 'bob', email: 'bob@ex.com', displayName: 'bob' }]);
});

test('selectSecondaryAdmins: missing/empty list → []', () => {
    assert.deepEqual(sel(undefined, 'alice'), []);
    assert.deepEqual(sel([], 'alice'), []);
    assert.deepEqual(sel(null, 'alice'), []);
});

test('selectSecondaryAdmins: displayName falls back to uid', () => {
    assert.deepEqual(sel([{ uid: 'bob', email: 'bob@ex.com' }], 'alice'),
        [{ uid: 'bob', email: 'bob@ex.com', displayName: 'bob' }]);
});

// verifyNcInstance — the base URL comes from an unauthenticated header, so it
// must not turn the server into a probe of its own network (SSRF).
const http = require('node:http');

/** A fake "internal" Nextcloud on loopback that counts the requests it gets. */
async function withLoopbackNc(fn) {
    let hits = 0;
    const srv = http.createServer((req, res) => {
        hits++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ocs: { data: { version: { string: '30.0.0' }, capabilities: { theming: { instanceid: 'internal-id', name: 'Internal' } } } } }));
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
    try {
        await fn(`http://127.0.0.1:${port}`, () => hits);
    } finally {
        await new Promise(resolve => srv.close(() => resolve(undefined)));
    }
}

function withPrivateHostsFlag(value, fn) {
    const prev = process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    if (value === undefined) delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    else process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = value;
    return Promise.resolve(fn()).finally(() => {
        if (prev === undefined) delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
        else process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = prev;
    });
}

test('verifyNcInstance: refuses a loopback base URL without sending a request', async () => {
    await withPrivateHostsFlag(undefined, () => withLoopbackNc(async (base, hits) => {
        await assert.rejects(helpers.verifyNcInstance(base, 'internal-id'), /NC capabilities unreachable/);
        assert.equal(hits(), 0, 'the internal host must never be contacted');
    }));
});

test('verifyNcInstance: refuses cloud metadata and private hosts (classified as unreachable)', async () => {
    await withPrivateHostsFlag(undefined, async () => {
        for (const base of ['http://169.254.169.254/latest', 'http://10.0.0.5', 'http://localhost:3101', 'http://[::1]:80', 'http://user:pw@nc.example.com']) {
            await assert.rejects(helpers.verifyNcInstance(base, 'x'), /NC capabilities unreachable/, base);
        }
    });
});

test('verifyNcInstance: metadata stays refused even with NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1', async () => {
    await withPrivateHostsFlag('1', async () => {
        await assert.rejects(helpers.verifyNcInstance('http://169.254.169.254', 'x'), /NC capabilities unreachable/);
    });
});

test('verifyNcInstance: NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 keeps a LAN self-host working', async () => {
    await withPrivateHostsFlag('1', () => withLoopbackNc(async (base, hits) => {
        const nc = await helpers.verifyNcInstance(base, 'internal-id');
        assert.deepEqual(nc, { themingName: 'Internal', ncVersion: '30.0.0' });
        assert.equal(hits(), 1);
    }));
});
