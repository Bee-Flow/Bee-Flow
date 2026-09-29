/**
 * A gate that only ever passes is indistinguishable from no gate.
 *
 * check-server-manifest.mjs is the guard for the mobile CI job's
 * server-manifest exclusion, and its whole job is to go RED on two changes
 * that would otherwise be silent — because the suite that used to catch them
 * no longer fires on the commit that makes them.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'check-server-manifest.mjs');

const REAL_JEST_CONFIG = fs.readFileSync(path.join(REPO, 'mobile/jest.config.js'), 'utf8');

// `type: undefined` has to mean "omit the field", not "fall back to the
// default" — otherwise the no-type-field fixture silently tests the happy path.
function sandbox(opts = {}) {
    const type = 'type' in opts ? opts.type : 'commonjs';
    const jestConfig = 'jestConfig' in opts ? opts.jestConfig : REAL_JEST_CONFIG;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvmanifest-'));
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mobile'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/check-server-manifest.mjs'));
    fs.writeFileSync(path.join(dir, 'server/package.json'), JSON.stringify({ name: 'server', type }, null, 2));
    if (jestConfig !== null) fs.writeFileSync(path.join(dir, 'mobile/jest.config.js'), jestConfig);
    return dir;
}

function run(dir) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/check-server-manifest.mjs')], {
            cwd: dir,
            encoding: 'utf8',
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

test('the real repository passes', () => {
    const r = run(REPO);
    assert.strictEqual(r.code, 0, r.stderr);
});

test('flipping the server to an ES module is refused', () => {
    // catalogLockstep.test.ts require()s a server module from a CommonJS
    // jest-expo context; "module" breaks it, and mobile-checks no longer fires
    // on server/package.json to say so.
    const r = run(sandbox({ type: 'module' }));
    assert.strictEqual(r.code, 1, 'the server silently became an ES module');
    assert.match(r.stderr, /expected "commonjs"/);
    assert.match(r.stderr, /catalogLockstep\.test\.ts/);
});

test('a server manifest with no type field at all is refused', () => {
    const r = run(sandbox({ type: undefined }));
    assert.strictEqual(r.code, 1, '"no type field" is not the same as "commonjs"');
    assert.match(r.stderr, /expected "commonjs"/);
});

test('dropping SERVER_DIR from transformIgnorePatterns is refused', () => {
    const stripped = fs
        .readFileSync(path.join(REPO, 'mobile/jest.config.js'), 'utf8')
        .replace(/^\s*SERVER_DIR,\s*$/m, '');
    assert.ok(!stripped.includes('SERVER_DIR,'), 'fixture did not apply');
    const r = run(sandbox({ jestConfig: stripped }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /no longer mentions SERVER_DIR in transformIgnorePatterns/);
});

test('a missing mobile jest config fails loudly, it does not skip', () => {
    const r = run(sandbox({ jestConfig: null }));
    assert.strictEqual(r.code, 1, 'the check passed without ever reading the config it guards');
    assert.match(r.stderr, /refuses to pass without reading it/);
});
