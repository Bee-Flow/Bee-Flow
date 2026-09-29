/**
 * The relying party a ceremony is bound to. What matters is that the caller
 * cannot pick it: an Origin header is attacker-controlled outside a browser,
 * so only an origin on the deployment's own allow-list may become one.
 *
 * Run: cd server && node --test auth/securityKeys/relyingParty.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRelyingParty } = require('./relyingParty');

const ENV = {
    CORS_ORIGIN: 'https://beeflow.example,https://www.beeflow.example,https://server.beeflow.example,http://localhost:5176',
    CLIENT_PUBLIC_HOST: 'beeflow.example',
};

test('an allowed origin on the public host is its own RP', () => {
    assert.deepEqual(resolveRelyingParty('https://beeflow.example', ENV), {
        rpID: 'beeflow.example', origin: 'https://beeflow.example',
    });
});

test('a subdomain of the public host shares its RP ID, so one key serves both hosts', () => {
    assert.deepEqual(resolveRelyingParty('https://www.beeflow.example', ENV), {
        rpID: 'beeflow.example', origin: 'https://www.beeflow.example',
    });
});

test('an origin outside the allow-list is refused, however plausible it looks', () => {
    assert.equal(resolveRelyingParty('https://beeflow.example.evil.test', ENV), null);
    assert.equal(resolveRelyingParty('https://evil.test', ENV), null);
});

test('no origin at all is refused', () => {
    assert.equal(resolveRelyingParty(undefined, ENV), null);
    assert.equal(resolveRelyingParty('', ENV), null);
});

test('a trailing slash does not change the answer', () => {
    assert.equal(resolveRelyingParty('https://beeflow.example/', ENV)?.rpID, 'beeflow.example');
});

test('localhost over plain http works; the port is not part of the RP ID', () => {
    const env = { CORS_ORIGIN: 'http://localhost:5176', CLIENT_PUBLIC_HOST: 'localhost:5176' };
    assert.deepEqual(resolveRelyingParty('http://localhost:5176', env), {
        rpID: 'localhost', origin: 'http://localhost:5176',
    });
});

test('plain http on a real host and IP addresses are refused: browsers would too', () => {
    const env = { CORS_ORIGIN: 'http://intranet.example,https://10.0.0.5,http://127.0.0.1:5176' };
    assert.equal(resolveRelyingParty('http://intranet.example', env), null);
    assert.equal(resolveRelyingParty('https://10.0.0.5', env), null);
    assert.equal(resolveRelyingParty('http://127.0.0.1:5176', env), null);
});

test('WEBAUTHN_RP_ID wins over CLIENT_PUBLIC_HOST', () => {
    const env = { ...ENV, CORS_ORIGIN: 'https://app.eu.beeflow.example', WEBAUTHN_RP_ID: 'eu.beeflow.example' };
    assert.equal(resolveRelyingParty('https://app.eu.beeflow.example', env)?.rpID, 'eu.beeflow.example');
});

test('a configured parent that the host does not sit under is ignored', () => {
    const env = { CORS_ORIGIN: 'https://other.example', CLIENT_PUBLIC_HOST: 'beeflow.example' };
    assert.equal(resolveRelyingParty('https://other.example', env)?.rpID, 'other.example');
});

test('a host that merely ENDS in the parent name is not under it', () => {
    const env = { CORS_ORIGIN: 'https://notbeeflow.example', CLIENT_PUBLIC_HOST: 'beeflow.example' };
    assert.equal(resolveRelyingParty('https://notbeeflow.example', env)?.rpID, 'notbeeflow.example');
});
