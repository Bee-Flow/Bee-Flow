/**
 * A component's index.js does not see the server's secrets.
 *
 * Components were caller-authored code until the Component Designer was
 * removed (2026-10); the shipped ones remain. runComponent spawned them with
 * `env: process.env`, so `console.log(JSON.stringify(process.env))` in a
 * component was enough to read MASTER_ENCRYPTION_KEY and DATABASE_URL. These
 * tests spawn a real child and read back what it can see.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runComponent, buildComponentEnv } = require('./executionEngine');

// Planted in the PARENT's env for the duration of this file. Placeholder
// values, not real secrets.
const PLANTED = {
    MASTER_ENCRYPTION_KEY: 'test-planted-master-key',
    DATABASE_URL: 'postgres://planted:planted@localhost/planted',
    OPAQUE_SERVER_SETUP: 'test-planted-opaque',
    ANTHROPIC_API_KEY: 'test-planted-provider-key',
    // A name nobody has put on any list: an allow-list must drop it too.
    SOME_FUTURE_SECRET: 'test-planted-future',
    // NODE_OPTIONS can --require code into the child; it must not pass.
    NODE_OPTIONS: '--no-warnings',
};

let dir;
const saved = {};

before(() => {
    for (const [k, v] of Object.entries(PLANTED)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-env-'));
    // A component that reports its whole environment plus what it was given.
    fs.writeFileSync(path.join(dir, 'index.js'), `
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ env: process.env, inputs: JSON.parse(input) }));
});
`);
});

after(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('a spawned component cannot read the server secrets from its env', async () => {
    const out = await runComponent(dir, { hello: 'world' });
    for (const name of Object.keys(PLANTED)) {
        assert.equal(out.env[name], undefined, `${name} leaked into the component`);
    }
    // And no planted VALUE shows up under some other name either.
    const blob = JSON.stringify(out.env);
    for (const value of Object.values(PLANTED)) {
        assert.ok(!blob.includes(value), `a planted value leaked: ${value}`);
    }
});

test('the component still runs normally: inputs on stdin, PATH and HOME present', async () => {
    const out = await runComponent(dir, { hello: 'world', _accessToken: 'per-run' });
    assert.deepEqual(out.inputs, { hello: 'world', _accessToken: 'per-run' });
    if (process.env.PATH !== undefined) assert.equal(out.env.PATH, process.env.PATH);
    if (process.env.HOME !== undefined) assert.equal(out.env.HOME, process.env.HOME);
});

test('buildComponentEnv keeps proxy, locale and the extra CA path, drops the rest', () => {
    const env = buildComponentEnv({
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy:3128',
        NO_PROXY: '',
        LANG: 'nl_NL.UTF-8',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
        MASTER_ENCRYPTION_KEY: 'x',
        SESSION_SECRET: 'x',
        NODE_OPTIONS: '--require /tmp/evil.js',
    });
    assert.deepEqual(env, {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy:3128',
        NO_PROXY: '',
        LANG: 'nl_NL.UTF-8',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
    });
});

test('buildComponentEnv returns a fresh object, never process.env itself', () => {
    const env = buildComponentEnv();
    assert.notEqual(env, process.env);
    env.MUTATED = '1';
    assert.equal(process.env.MUTATED, undefined);
});
