// @typecheck strict
'use strict';

/**
 * The feature modules the tree asks for and the ones boot/featureModules.js
 * registers are the same set.
 *
 * featureModule(name) throws only when it is called: a name nobody registered
 * shows on the first request that reaches that line, and a registration nobody
 * asks for stays for ever. The names are typed (FeatureModuleMap in
 * core/featureModules.js), which stops a misspelt name in a type-checked file.
 * This test holds the other side, the registrations themselves, against the
 * names in the source:
 *
 *   asked for   the literal first argument of a featureModule(...) call
 *   named       a registered name standing as a string literal anywhere else,
 *               which is how a caller that passes the name through a helper
 *               of its own (projects/appDefinitionGate.mts) is seen
 *
 * Tests, testkits and testUtils/ are not the tree the product runs and are
 * left out; so are comment lines, where a call is an example.
 *
 * Run: cd server && node --test boot/featureModules.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('./featureModules');
const { featureModuleNames } = require('../core/featureModules');

const SERVER = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'coverage', 'testUtils', 'assets', 'data', 'prompts']);
const SOURCE = /\.(?:[cm]?js|mts)$/;
const TEST_CODE = /\.test\.[cm]?[jt]s$|\.testkit\.js$/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const CALL = /\bfeatureModule\(\s*(['"`])([^'"`]+)\1/g;
const LITERAL = /(['"`])([\w./-]+)\1/g;
// Where the names are declared and registered: a name standing there is not a use.
const REGISTRY = new Set(['boot/featureModules.js', 'core/featureModules.js']);

/**
 * @param {string} dir
 * @param {string[]} out
 */
function sourceFiles(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, out);
        else if (SOURCE.test(entry.name) && !TEST_CODE.test(entry.name)) out.push(full);
    }
    return out;
}

/** The names asked for (with where) and every string literal that could be a name. */
function scan() {
    /** @type {Map<string, string[]>} */
    const asked = new Map();
    /** @type {Set<string>} */
    const named = new Set();
    for (const file of sourceFiles(SERVER, [])) {
        const rel = path.relative(SERVER, file).split(path.sep).join('/');
        if (REGISTRY.has(rel)) continue;
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            if (COMMENT_LINE.test(line)) return;
            for (const m of line.matchAll(CALL)) asked.set(m[2], [...(asked.get(m[2]) || []), `${rel}:${i + 1}`]);
            for (const m of line.matchAll(LITERAL)) named.add(m[2]);
        });
    }
    return { asked, named };
}

const registered = new Set(featureModuleNames());
const { asked, named } = scan();

test('the scan finds the calls it is meant to judge', () => {
    // A walker that silently finds nothing would pass both tests below.
    assert.ok(asked.size >= 20, `only ${asked.size} feature module names found in the source`);
    assert.ok(registered.size >= 20, `only ${registered.size} feature modules registered`);
});

test('every feature module the tree asks for is registered', () => {
    const unknown = [...asked]
        .filter(([name]) => !registered.has(name))
        .map(([name, where]) => `${name}  (${where.join(', ')})`);
    assert.deepEqual(unknown, [],
        'featureModule() is called with a name boot/featureModules.js does not register; register it there and add it to FeatureModuleMap in core/featureModules.js');
});

test('every registered feature module is asked for somewhere', () => {
    const unused = [...registered].filter((name) => !asked.has(name) && !named.has(name));
    assert.deepEqual(unused, [],
        'boot/featureModules.js registers a module no source file names; remove the registration and its line in FeatureModuleMap');
});
