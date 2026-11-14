'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { privateUrlInput } = require('./componentInputGuard');

/** A lookup that answers without DNS: public unless the host is listed as private. */
const lookupWith = (privateHosts = []) => (host, _options, callback) =>
    callback(privateHosts.includes(host) ? new Error('EPRIVATEADDRESS') : null);

test('a public target passes', async () => {
    assert.strictEqual(await privateUrlInput({ youtrackUrl: 'https://youtrack.example.com', query: 'x' }, { lookup: lookupWith() }), null);
});

test('a literal private, loopback or metadata address is refused without a lookup', async () => {
    const never = () => { throw new Error('no lookup expected'); };
    for (const url of ['http://127.0.0.1:8080/admin', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'HTTP://localhost/x']) {
        assert.strictEqual(await privateUrlInput({ webhookUrl: url }, { lookup: never }), 'webhookUrl', url);
    }
});

test('a name that resolves to a private address is refused', async () => {
    assert.strictEqual(await privateUrlInput({ a: 'ok', baseUrl: 'https://intranet.example.com/x' }, { lookup: lookupWith(['intranet.example.com']) }), 'baseUrl');
});

test('text that is not an http(s) URL, and the server-set `_` inputs, are left alone', async () => {
    const inputs = { query: 'state: Open', note: 'see http in the middle', _nextcloudUrl: 'http://10.0.0.9', max: 10 };
    assert.strictEqual(await privateUrlInput(inputs, { lookup: lookupWith() }), null);
});

test('the operator list, the caller\'s Nextcloud and a proxy may be private', async () => {
    const { allowedPrivateHosts } = require('./componentInputGuard');
    assert.deepStrictEqual(allowedPrivateHosts({ _nextcloudUrl: 'https://NC.lan/x' }, { COMPONENT_ALLOW_PRIVATE_HOSTS: 'n8n.lan, 10.0.0.5', HTTPS_PROXY: 'http://proxy.lan:3128' }),
        ['n8n.lan', '10.0.0.5', 'nc.lan', 'proxy.lan']);
    assert.deepStrictEqual(allowedPrivateHosts({}, { COMPONENT_ALLOW_PRIVATE_HOSTS: '1' }), ['*']);
    assert.deepStrictEqual(allowedPrivateHosts({}, {}), []);
    const never = () => { throw new Error('no lookup expected'); };
    assert.strictEqual(await privateUrlInput({ webhookUrl: 'http://10.0.0.5/hook' }, { lookup: never, allowed: ['10.0.0.5'] }), null);
    assert.strictEqual(await privateUrlInput({ webhookUrl: 'http://10.0.0.6/hook' }, { lookup: never, allowed: ['10.0.0.5'] }), 'webhookUrl');
    assert.strictEqual(await privateUrlInput({ webhookUrl: 'http://10.0.0.6/hook' }, { lookup: never, allowed: ['*'] }), null);
});
