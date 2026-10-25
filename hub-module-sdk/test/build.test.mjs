/**
 * build.mjs on a copy of template/: the authoring manifest becomes manifest.json,
 * the server source becomes one self-contained CJS bundle, and a missing source
 * or manifest is an error. The frontend (vite) is not built here.
 *
 * Run: node --test test/build.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { buildServer, buildFrontend, copyManifest } from '../scripts/build.mjs';
import { pack } from '../scripts/pack.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const TEMPLATE = fileURLToPath(new URL('../template', import.meta.url));

let work;
before(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'bfmod-build-')); });
after(() => { fs.rmSync(work, { recursive: true, force: true }); });

function templateCopy(name) {
    const dir = path.join(work, name);
    fs.cpSync(TEMPLATE, dir, { recursive: true });
    return dir;
}

test('copyManifest copies module.manifest.json to manifest.json', () => {
    const dir = templateCopy('manifest');
    const out = copyManifest(dir);
    assert.equal(out, path.join(dir, 'manifest.json'));
    assert.deepEqual(
        JSON.parse(fs.readFileSync(out, 'utf8')),
        JSON.parse(fs.readFileSync(path.join(dir, 'module.manifest.json'), 'utf8')),
    );
});

test('copyManifest keeps an existing manifest.json and throws when there is none', () => {
    const dir = path.join(work, 'only-manifest');
    fs.mkdirSync(dir);
    assert.throws(() => copyManifest(dir), /neither module\.manifest\.json nor manifest\.json/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    assert.equal(copyManifest(dir), path.join(dir, 'manifest.json'));
});

test('buildServer bundles the template into one CJS file with createModule', async () => {
    const dir = templateCopy('server');
    const out = await buildServer(dir);
    assert.equal(out, path.join(dir, 'server', 'entry.cjs'));
    const mod = require(out);
    assert.equal(typeof mod.createModule, 'function');
    // self-contained: no relative requires left
    assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /require\(["']\.\.?\//);
});

test('buildServer honours bfmod.stub from the module package.json', async () => {
    const dir = templateCopy('stub');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ bfmod: { stub: ['left-pad-nope'] } }));
    fs.writeFileSync(path.join(dir, 'server', 'src', 'index.js'),
        "const x = require('left-pad-nope');\nexports.createModule = () => ({ stubbed: typeof x });\n");
    const out = await buildServer(dir);
    assert.equal(require(out).createModule().stubbed, 'object');
});

test('buildServer throws when server/src/index.js is missing', async () => {
    const dir = path.join(work, 'empty');
    fs.mkdirSync(dir);
    await assert.rejects(() => buildServer(dir), /missing .*index\.js/);
});

test('buildFrontend skips without frontend/src and demands a vite config with it', () => {
    const dir = path.join(work, 'fe');
    fs.mkdirSync(path.join(dir, 'frontend'), { recursive: true });
    assert.equal(buildFrontend(dir), null);
    fs.mkdirSync(path.join(dir, 'frontend', 'src'));
    assert.throws(() => buildFrontend(dir), /vite\.config\.js missing/);
});

test('a built template packs with an integrity.json covering the bundle', async () => {
    const dir = templateCopy('pack');
    copyManifest(dir);
    await buildServer(dir);
    fs.rmSync(path.join(dir, 'frontend'), { recursive: true, force: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    delete manifest.frontend;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const outFile = path.join(work, 'template.bfmod');
    await pack(dir, outFile);
    const zip = await JSZip.loadAsync(fs.readFileSync(outFile));
    const integrity = JSON.parse(await zip.file('integrity.json').async('string'));
    assert.ok(integrity.files['manifest.json']);
    assert.ok(integrity.files['server/entry.cjs']);
});
