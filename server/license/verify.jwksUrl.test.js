'use strict';
// LICENSE_JWKS_URL is the licence trust root's rotation path, so it is https
// or nothing: a production process refuses to load with a plain-http URL,
// any other environment loads with a warning. Each case is a fresh process,
// because the check runs once, when the module is required.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** @param {Record<string, string>} env */
function loadVerify(env) {
    return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'verify.js'))}); process.stdout.write('loaded')`], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, LICENSE_JWKS_URL: '', NODE_ENV: 'test', ...env },
        encoding: 'utf8',
    });
}

test('a plain-http JWKS URL stops a production process from loading the verifier', () => {
    const r = loadVerify({ NODE_ENV: 'production', LICENSE_JWKS_URL: 'http://license.example/v1/jwks.json' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /LICENSE_JWKS_URL must be an https:\/\/ URL/);
});

test('an https JWKS URL loads in production, and a plain one outside production only warns', () => {
    const prod = loadVerify({ NODE_ENV: 'production', LICENSE_JWKS_URL: 'https://license.example/v1/jwks.json' });
    assert.equal(prod.status, 0, prod.stderr);
    assert.equal(prod.stdout, 'loaded');
    const dev = loadVerify({ NODE_ENV: 'development', LICENSE_JWKS_URL: 'http://localhost:4400/v1/jwks.json' });
    assert.equal(dev.status, 0, dev.stderr);
    assert.equal(dev.stdout, 'loaded');
});
