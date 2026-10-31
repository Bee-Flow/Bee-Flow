/**
 * gen-routes-contract with an injected walk and a throwaway server/ shaped
 * directory: writes the file, says "unchanged" the second time, and --check
 * refuses a weakened route. The classifier itself is tested in
 * server/auth/routeContract.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from './gen-routes-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');

// A server/ look-alike: the real auth/ and testUtils/ modules by symlink (the
// classifier and the sweep parser), an index.js with no routes of its own, and
// its own auth/routes.contract.json.
function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-contract-'));
    // auth/ is copied, not linked: the contract is written there.
    fs.mkdirSync(path.join(dir, 'auth'));
    for (const f of fs.readdirSync(path.join(SERVER, 'auth'))) {
        if (f.endsWith('.js')) fs.copyFileSync(path.join(SERVER, 'auth', f), path.join(dir, 'auth', f));
    }
    for (const d of ['testUtils', 'routes', 'core', 'config', 'license', 'utils', 'telemetry', 'stores', 'node_modules']) {
        fs.symlinkSync(path.join(SERVER, d), path.join(dir, d), 'dir');
    }
    fs.writeFileSync(path.join(dir, 'index.js'), "const express = require('express');\nconst app = express();\napp.listen(0);\n");
    return dir;
}

const route = (over) => ({ method: 'GET', path: '/x', gates: [{ axis: 'auth' }], middleware: [], schemas: {}, probedHandler: false, ...over });

test('writes the contract from the walk, then reports it unchanged', () => {
    const dir = sandbox();
    let log = '';
    const out = (s) => { log += s; };
    assert.equal(main([], { walked: [route()], server: dir, out }), 0);
    const file = path.join(dir, 'auth', 'routes.contract.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(doc.routes, { 'GET /x': { gate: 'auth' } });
    assert.match(log, /wrote .*routes\.contract\.json: 1 routes/);
    log = '';
    assert.equal(main([], { walked: [route()], server: dir, out }), 0);
    assert.match(log, /unchanged/);
    assert.equal(main(['--check'], { walked: [route()], server: dir, out }), 0);
});

test('--check refuses a weakened route, a new route and a missing file', () => {
    const dir = sandbox();
    let log = '';
    const out = (s) => { log += s; };
    assert.equal(main(['--check'], { walked: [route()], server: dir, out }), 1);
    assert.match(log, /missing/);
    main([], { walked: [route({ gates: [{ axis: 'auth' }, { axis: 'platform', kind: 'superAdmin' }] })], server: dir, out });
    log = '';
    assert.equal(main(['--check'], { walked: [route()], server: dir, out }), 1);
    assert.match(log, /GET \/x: recorded platform\(superAdmin\), now auth/);
    log = '';
    assert.equal(main(['--check'], { walked: [route({ gates: [{ axis: 'platform', kind: 'superAdmin' }] }), route({ path: '/y' })], server: dir, out }), 1);
    assert.match(log, /GET \/y: not in auth\/routes\.contract\.json/);
});

test('a route with no gate anywhere is written but fails the run', () => {
    const dir = sandbox();
    let log = '';
    assert.equal(main([], { walked: [route({ gates: [] })], server: dir, out: (s) => { log += s; } }), 1);
    assert.match(log, /no gate anywhere/);
});
