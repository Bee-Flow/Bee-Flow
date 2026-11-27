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
const REAL_CI = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');

// `type: undefined` has to mean "omit the field", not "fall back to the
// default" — otherwise the no-type-field fixture silently tests the happy path.
// `modulesType: null` leaves modules/ out altogether (a checkout before it existed).
function sandbox(opts = {}) {
    const type = 'type' in opts ? opts.type : 'commonjs';
    const modulesType = 'modulesType' in opts ? opts.modulesType : 'commonjs';
    const jestConfig = 'jestConfig' in opts ? opts.jestConfig : REAL_JEST_CONFIG;
    const ci = 'ci' in opts ? opts.ci : REAL_CI;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvmanifest-'));
    for (const sub of ['server', 'mobile', 'scripts', '.github/workflows']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/check-server-manifest.mjs'));
    fs.writeFileSync(path.join(dir, 'server/package.json'), JSON.stringify({ name: 'server', type }, null, 2));
    if (modulesType !== null) {
        fs.mkdirSync(path.join(dir, 'modules'));
        fs.writeFileSync(path.join(dir, 'modules/package.json'), JSON.stringify({ name: 'm', type: modulesType }, null, 2));
    }
    if (jestConfig !== null) fs.writeFileSync(path.join(dir, 'mobile/jest.config.js'), jestConfig);
    if (ci !== null) fs.writeFileSync(path.join(dir, '.github/workflows/ci.yml'), ci);
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

test('a module root that becomes an ES module is refused', () => {
    const r = run(sandbox({ modulesType: 'module' }));
    assert.strictEqual(r.code, 1, 'modules/ silently became an ES module');
    assert.match(r.stderr, /modules\/package\.json has "type": "module", expected "commonjs"/);
});

test('a checkout without modules/ needs no modules/package.json', () => {
    const r = run(sandbox({ modulesType: null }));
    assert.strictEqual(r.code, 0, r.stderr);
});

test('a ci.yml filter pattern that names only server/ is refused', () => {
    const ci = REAL_CI.replace("- '{server,modules/*/server}/automation/goLive.js'", "- 'server/automation/goLive.js'");
    assert.notStrictEqual(ci, REAL_CI, 'fixture did not apply');
    const r = run(sandbox({ ci }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /'server\/automation\/goLive\.js' names only the core root; write '\{server,modules\/\*\/server\}\/automation\/goLive\.js'/);
});

test('a ci.yml filter pattern that names only agent-hub/ is refused', () => {
    const ci = REAL_CI.replace("- '{agent-hub,modules/*/frontend}/src/utils/plural.ts'", "- 'agent-hub/src/utils/plural.ts'");
    assert.notStrictEqual(ci, REAL_CI, 'fixture did not apply');
    const r = run(sandbox({ ci }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /'agent-hub\/src\/utils\/plural\.ts' names only the core root/);
});

test('the server package manifests may stay core-only', () => {
    assert.match(REAL_CI, /- 'server\/package\.json'/, 'the frontend filter lists server/package.json');
    const r = run(sandbox());
    assert.strictEqual(r.code, 0, r.stderr);
});

test('a missing ci.yml fails loudly, it does not skip', () => {
    const r = run(sandbox({ ci: null }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /ci\.yml is missing .* refuses to pass without reading it/);
});
