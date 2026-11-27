'use strict';
/**
 * boot/gates.js: the one gates object of index.js and the mount rows. With module learning
 * present, requireTraining is exactly learning's function (the recorded chains do not
 * change); with learning absent (core mode), a factory whose middleware passes every request.
 * Each case runs in a child process: the gates' files reach stores that log and keep timers,
 * and the absent case needs BEEFLOW_HIDE_MODULES=learning. The child registers the modules' names
 * first (testUtils/registerFeatures.js), as index.js does before it builds the gates.
 *
 * Run: cd server && node --test boot/gates.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..');
const MARK = 'GATES-RESULT ';

/** The child's require of a server file, by absolute path. @param {string} rel */
const req = (rel) => `require(${JSON.stringify(path.join(SERVER, rel))})`;

/**
 * Run `code` (which sets `result`) in a child with these modules hidden; it prints a marked
 * line and exits.
 * @param {string} hide @param {string} code
 */
function inChild(hide, code) {
    const env = { ...process.env, BEEFLOW_HIDE_MODULES: hide };
    delete env.NODE_TEST_CONTEXT;
    const script = `let result;\n${code}\nprocess.stdout.write('\\n${MARK}' + JSON.stringify(result) + '\\n'); process.exit(0);`;
    const r = spawnSync(process.execPath, ['--require', path.join(SERVER, 'moduleRoots.cjs'), '--require', path.join(SERVER, 'testUtils/registerFeatures.js'), '-e', script], { cwd: SERVER, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith(MARK));
    assert.ok(line, r.stdout);
    return JSON.parse(line.slice(MARK.length));
}

test('one object, and each member is the core factory itself', () => {
    const out = inChild('', `
        const g = ${req('boot/gates.js')}.getGates();
        result = {
            once: ${req('boot/gates.js')}.getGates() === g,
            requireModule: g.requireModule === ${req('modules/index.js')}.requireModule,
            requireCapability: g.requireCapability === ${req('core/entitlements/entitlements.js')}.requireCapability,
            requireLicenseFeature: g.requireLicenseFeature === ${req('license/middleware.js')}.requireFeature,
            requireAuthedUser: g.requireAuthedUser === ${req('auth/index.js')}.requireAuth,
            requireAnyPermission: g.requireAnyPermission === ${req('auth/permissions.js')}.requireAnyPermission,
            featureGate: g.featureGate === ${req('boot/featureGate.js')}.featureGate,
        };
    `);
    assert.deepEqual(Object.entries(out).filter(([, same]) => !same), []);
});

test('requireTraining is learning\'s own function while learning is present', () => {
    const out = inChild('', `
        const g = ${req('boot/gates.js')}.getGates();
        result = { same: g.requireTraining === ${req('learning/requireTraining.js')}.requireTraining };
    `);
    assert.deepEqual(out, { same: true });
});

test('without learning, requireTraining gives a middleware that lets every request through', () => {
    const out = inChild('learning', `
        const g = ${req('boot/gates.js')}.getGates();
        let passed = 0;
        g.requireTraining('agents')({}, {}, () => { passed += 1; });
        result = { passed };
    `);
    assert.deepEqual(out, { passed: 1 });
});
