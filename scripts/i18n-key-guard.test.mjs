/**
 * The key guard exists for one failure: a merge in which the second branch
 * wins and the first one's keys are gone. So the cases are the ones that
 * shape takes — a key present at the base and missing now fails and is NAMED;
 * a removal listed in removed-keys.txt passes; additions never matter — and
 * the base may have either layout, since the first pull requests after the
 * split compare the new directory against the old monolith.
 *
 * Sandbox: a throwaway git repository under os.tmpdir() with the real script
 * copied in (style: scripts/count-ratchet.test.mjs).
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { archiveExtras } from './i18n-key-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'i18n-key-guard.mjs');
const DEFAULTS = path.join('server', 'i18n', 'defaults');

function git(dir, ...args) {
    return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Old layout: en.js holds the whole dictionary. */
function writeMonolith(dir, dict) {
    fs.rmSync(path.join(dir, DEFAULTS, 'en'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, DEFAULTS, 'en.js'),
        `const GUI_DEFAULTS = ${JSON.stringify(dict, null, 4)};\nmodule.exports = { GUI_DEFAULTS };\n`);
}

/** New layout: en/<ns>.js per namespace, en/index.js merges, en.js re-exports. */
function writeSplit(dir, dict) {
    const en = path.join(dir, DEFAULTS, 'en');
    fs.rmSync(en, { recursive: true, force: true });
    fs.mkdirSync(en, { recursive: true });
    const byNs = {};
    for (const [k, v] of Object.entries(dict)) (byNs[k.split('.')[0]] ||= {})[k] = v;
    for (const [ns, entries] of Object.entries(byNs)) {
        fs.writeFileSync(path.join(en, `${ns}.js`), `module.exports = ${JSON.stringify(entries, null, 4)};\n`);
    }
    fs.writeFileSync(path.join(en, 'index.js'),
        `const GUI_DEFAULTS = Object.assign({}, ${Object.keys(byNs).map((ns) => `require('./${ns}.js')`).join(', ')});\nmodule.exports = { GUI_DEFAULTS };\n`);
    fs.writeFileSync(path.join(dir, DEFAULTS, 'en.js'), "module.exports = require('./en/index.js');\n");
}

const BASE = { 'a.one': 'One', 'a.two': 'Two', 'b.three': 'Three', greet: 'Hi' };

function sandbox(layout = writeMonolith, dict = BASE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-key-guard-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'i18n-key-guard.mjs'));
    fs.copyFileSync(path.join(HERE, 'entry-point.mjs'), path.join(dir, 'scripts', 'entry-point.mjs'));
    fs.mkdirSync(path.join(dir, DEFAULTS), { recursive: true });
    layout(dir, dict);
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
}

function run(dir, args = ['--base', 'HEAD']) {
    try {
        const env = { ...process.env };
        delete env.BEEFLOW_MODULE_ROOTS;
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts', 'i18n-key-guard.mjs'), ...args], {
            cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const without = (dict, ...keys) => Object.fromEntries(Object.entries(dict).filter(([k]) => !keys.includes(k)));

test('nothing lost — additions and a layout change are fine', () => {
    const dir = sandbox(writeMonolith);
    writeSplit(dir, { ...BASE, 'c.new': 'New' });
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /no keys lost against HEAD \(4 before, 5 now\)/);
});

test('a key missing against an old-layout base fails, and every missing key is named', () => {
    const dir = sandbox(writeMonolith);
    writeSplit(dir, without(BASE, 'a.two', 'greet'));
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /2 English key\(s\) present at HEAD are missing now/);
    assert.match(r.stderr, /^ {2}a\.two$/m);
    assert.match(r.stderr, /^ {2}greet$/m);
    assert.match(r.stderr, /removed-keys\.txt/);
});

test('a key missing against a new-layout base fails too', () => {
    const dir = sandbox(writeSplit);
    writeSplit(dir, without(BASE, 'b.three'));
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /^ {2}b\.three$/m);
});

test('a removal listed in removed-keys.txt passes; comments and blanks are ignored', () => {
    const dir = sandbox(writeSplit);
    writeSplit(dir, without(BASE, 'a.two', 'b.three'));
    fs.writeFileSync(path.join(dir, DEFAULTS, 'removed-keys.txt'), '# header\n\na.two   # old wording\n');
    const partial = run(dir);
    assert.strictEqual(partial.code, 1, 'b.three is still unlisted');
    assert.doesNotMatch(partial.stderr, /^ {2}a\.two$/m);
    fs.appendFileSync(path.join(dir, DEFAULTS, 'removed-keys.txt'), 'b.three\n');
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /2 removal\(s\) listed in removed-keys\.txt/);
});

test('no --base, or a base git cannot read, is a usage error rather than a pass', () => {
    const dir = sandbox();
    assert.strictEqual(run(dir, []).code, 2);
    const r = run(dir, ['--base', 'no-such-ref']);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /cannot read server\/i18n\/defaults at no-such-ref/);
});

// -- module roots (server/moduleRoots.cjs) ---------------------------------
// A module keeps its namespace files in modules/<id>/server/i18n/defaults/en/.
// The base archive holds them and the resolver, and keys are compared by key:
// a namespace file that moved between roots loses nothing, and a key deleted
// from a module root at the base is still seen as lost.

const SERVER = path.join(HERE, '..', 'server');
const RESOLVER_FILES = ['moduleRoots.cjs', 'modules/roots/rootSet.cjs', 'modules/roots/resolveHooks.cjs',
    'modules/roots/treeCheck.cjs', 'i18n/defaults/namespaceName.js', 'i18n/defaults/en/index.js'];

/**
 * The real resolver and en/index.js; the namespaces in `inModule` live in module "x".
 * @param {string[]} inModule
 */
function rootsLayout(inModule) {
    return (dir, dict) => {
        const en = path.join(dir, DEFAULTS, 'en');
        const mod = path.join(dir, 'modules', 'x', DEFAULTS, 'en');
        for (const d of [en, mod]) fs.rmSync(d, { recursive: true, force: true });
        for (const rel of RESOLVER_FILES) {
            fs.mkdirSync(path.dirname(path.join(dir, 'server', rel)), { recursive: true });
            fs.copyFileSync(path.join(SERVER, rel), path.join(dir, 'server', rel));
        }
        fs.mkdirSync(mod, { recursive: true });
        const byNs = {};
        for (const [k, v] of Object.entries(dict)) (byNs[k.split('.')[0]] ||= {})[k] = v;
        for (const [ns, entries] of Object.entries(byNs)) {
            fs.writeFileSync(path.join(inModule.includes(ns) ? mod : en, `${ns}.js`), `module.exports = ${JSON.stringify(entries, null, 4)};\n`);
        }
        fs.writeFileSync(path.join(dir, DEFAULTS, 'en.js'), "module.exports = require('./en/index.js');\n");
    };
}

test('a namespace file that moved into a module root loses no keys', () => {
    const dir = sandbox(rootsLayout([]));
    rootsLayout(['b'])(dir, BASE);
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /no keys lost against HEAD \(4 before, 4 now\)/);
});

test('the base archive holds the module roots: a key lost from a module file fails, a move back does not', () => {
    const dir = sandbox(rootsLayout(['b']));
    rootsLayout(['b'])(dir, without(BASE, 'b.three'));
    const lost = run(dir);
    assert.strictEqual(lost.code, 1);
    assert.match(lost.stderr, /^ {2}b\.three$/m);

    rootsLayout([])(dir, BASE);
    const back = run(dir);
    assert.strictEqual(back.code, 0, back.stderr);
    assert.match(back.stdout, /\(4 before, 4 now\)/);
});

test('core mode does not count a hidden module as lost keys', () => {
    const dir = sandbox(rootsLayout(['b']));
    const env = { ...process.env, BEEFLOW_HIDE_MODULES: 'x' };
    delete env.BEEFLOW_MODULE_ROOTS;
    const out = execFileSync(process.execPath, [path.join(dir, 'scripts', 'i18n-key-guard.mjs'), '--base', 'HEAD'], { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(out, /\(4 before, 4 now\)/);
});

test('the archive takes the resolver and the dictionary of every module root, nothing else', () => {
    assert.deepStrictEqual(archiveExtras([
        'server/moduleRoots.cjs', 'server/modules/roots/rootSet.cjs', 'server/modules/firstParty/moduleState.js',
        'modules/README.md', 'modules/x/server/i18n/defaults/en/b.js', 'modules/x/server/i18n/defaults/nl/b.json',
        'modules/x/server/core/a.js', 'modules/x/frontend/server/i18n/defaults/en/c.js',
    ]), ['server/moduleRoots.cjs', 'server/modules/roots/rootSet.cjs', 'modules/x/server/i18n/defaults/en/b.js',
        'modules/x/server/i18n/defaults/nl/b.json']);
});
