/**
 * The manifest schema is enforced when a module is packed.
 *
 * MANIFEST.schema.json describes the whole manifest; manifestSchema.mjs checks
 * a manifest against it and pack() refuses one that does not match, before it
 * writes anything. The manifests shipped in this repository must pass.
 *
 * Run: node --test test/manifestSchema.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pack } from '../scripts/pack.mjs';
import { validateManifest, assertValidManifest } from '../scripts/manifestSchema.mjs';

const SDK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(SDK, rel), 'utf8'));

const VALID = {
    manifestVersion: 2,
    id: 'schema_test_mod',
    name: 'Schema Test',
    version: '1.2.3',
    hostApiVersion: 3,
    permissions: ['db', 'http:api.example.com'],
    capabilities: [{ id: 'schema_test_mod_cap' }],
    server: { entry: 'server/entry.cjs', workers: [{ id: 'tick', intervalMs: 60000 }] },
};
const withChange = (change) => { const m = structuredClone(VALID); change(m); return m; };

function moduleDir(manifest) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfmod-schema-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'entry.cjs'), 'module.exports.createModule = () => ({ router: () => {} });\n');
    return dir;
}

test('the manifests shipped with the SDK match the schema', () => {
    for (const rel of ['template/module.manifest.json', 'modules/security_scan/module.manifest.json']) {
        assert.deepEqual(validateManifest(readJson(rel)), [], rel);
    }
});

test('a valid manifest has no problems', () => {
    assert.deepEqual(validateManifest(VALID), []);
});

test('each kind of rule is enforced and names the place', () => {
    const cases = [
        [(m) => { delete m.server; }, /^server is required$/],
        [(m) => { delete m.server.entry; }, /^server\.entry is required$/],
        [(m) => { m.id = 'Bad-Id'; }, /^id does not match /],
        [(m) => { m.version = '1.2'; }, /^version does not match /],
        [(m) => { m.manifestVersion = 3; }, /^manifestVersion must be one of 1, 2$/],
        [(m) => { m.hostApiVersion = '3'; }, /^hostApiVersion must be an integer, not a string$/],
        [(m) => { m.hostApiVersion = 0; }, /^hostApiVersion must be at least 1$/],
        [(m) => { m.name = ''; }, /^name must be at least 1 characters$/],
        [(m) => { m.name = 'x'.repeat(81); }, /^name must be at most 80 characters$/],
        [(m) => { m.permissions = ['root']; }, /^permissions\[0\] does not match /],
        [(m) => { m.capabilities = [{ name: 'no id' }]; }, /^capabilities\[0\]\.id is required$/],
        [(m) => { m.server.workers[0].intervalMs = 10; }, /^server\.workers\[0\]\.intervalMs must be at least 1000$/],
        [(m) => { m.server.restart = 'sometimes'; }, /^server\.restart must be one of "auto", "never", "always"$/],
        [(m) => { m.author = 'someone'; }, /^author is not a field of the manifest schema$/],
        [(m) => { m.server.port = 8080; }, /^server\.port is not a field of the manifest schema$/],
        [(m) => { m.frontend = { entry: 'frontend/index.js', studioApp: { urlSegment: 'x1', labels: { en: 1 } } }; }, /^frontend\.studioApp\.labels\.en must be a string, not an integer$/],
    ];
    for (const [change, expected] of cases) {
        const problems = validateManifest(withChange(change));
        assert.equal(problems.length, 1, `${expected}: ${JSON.stringify(problems)}`);
        assert.match(problems[0], expected);
    }
});

test('what the schema leaves open stays open', () => {
    // A capability and `requirements` take extra keys; an optional block may be absent.
    assert.deepEqual(validateManifest(withChange((m) => { m.capabilities[0].licenseFeature = 'x'; m.requirements = { docker: true, gpu: 'optional' }; })), []);
});

test('every problem is reported, not only the first', () => {
    const problems = validateManifest(withChange((m) => { m.id = 'X'; delete m.name; m.extra = 1; }));
    assert.equal(problems.length, 3, JSON.stringify(problems));
});

test('a schema keyword the validator does not implement is an error, not a pass', () => {
    assert.throws(() => validateManifest({}, { type: 'object', minProperties: 1 }), /uses "minProperties".*does not implement/);
    assert.throws(() => validateManifest({ a: 1 }, { type: 'object', properties: { a: { type: 'integer', multipleOf: 2 } } }), /uses "multipleOf" at a/);
});

test('assertValidManifest lists the problems in one error', () => {
    assert.throws(() => assertValidManifest(withChange((m) => { m.id = 'X'; m.extra = 1; })), (e) => /does not match MANIFEST\.schema\.json/.test(e.message) && /- id does not match/.test(e.message) && /- extra is not a field/.test(e.message));
});

test('pack refuses a manifest the schema refuses and writes no package', async () => {
    const dir = moduleDir(withChange((m) => { m.permissions = ['everything']; }));
    try {
        const out = path.join(dir, 'out.bfmod');
        await assert.rejects(() => pack(dir, out), /permissions\[0\] does not match/);
        assert.equal(fs.existsSync(out), false, 'no .bfmod is written');
        assert.equal(fs.existsSync(path.join(dir, 'integrity.json')), false, 'no integrity file is written');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('packing the same directory twice works: the aliases pack writes are part of the schema', async () => {
    const dir = moduleDir(withChange((m) => { m.minAppVersion = '1.1.0'; m.maxAppVersion = '2.0.0'; }));
    try {
        await pack(dir, path.join(dir, 'first.bfmod'));
        const written = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        assert.equal(written.min_app_version, '1.1.0');
        assert.equal(written.host_api_version, 3);
        fs.rmSync(path.join(dir, 'first.bfmod'));
        await pack(dir, path.join(dir, 'second.bfmod'));
        assert.equal(fs.existsSync(path.join(dir, 'second.bfmod')), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
