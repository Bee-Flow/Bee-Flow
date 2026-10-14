'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePublicBaseUrl, publicProtocol } = require('./publicUrl');

const req = (protocol, host) => ({ protocol, get: (h) => (h === 'host' ? host : undefined) });

test('a public host gets https even when the request arrived as http behind a TLS proxy', () => {
    delete process.env.PUBLIC_BASE_URL;
    assert.equal(resolvePublicBaseUrl(req('http', 'dev.beeflow.nl')), 'https://dev.beeflow.nl');
});

test('https stays https', () => {
    assert.equal(publicProtocol('https', 'beeflow.nl'), 'https');
});

test('local and private hosts keep the request protocol', () => {
    for (const host of ['localhost:5176', '127.0.0.1:3001', '[::1]:3001', '192.168.1.20', '10.0.0.4:80', '172.20.0.5', 'server:3001', 'nas.local']) {
        assert.equal(publicProtocol('http', host), 'http', host);
    }
});

test('172.32.x is public', () => {
    assert.equal(publicProtocol('http', '172.32.0.1'), 'https');
});
