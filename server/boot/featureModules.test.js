// @typecheck strict
'use strict';

/**
 * The feature modules the tree asks for and the ones that are registered are
 * the same set. The registry is read after boot/featureModules.js has loaded,
 * which opens its registration channel and so also holds every name a
 * first-party module registers in its firstParty/<id>.register.js
 * (modules/firstParty/registrationChannels.js): the registrations live in the
 * core file and in each module's register part, and this reads what they did.
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
// A module's register part and its provides file register and declare names too.
const REGISTER_PART = /^firstParty\/[A-Za-z0-9_]+\.register\.js$/;

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
        if (REGISTRY.has(rel) || REGISTER_PART.test(rel)) continue;
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

/**
 * The feature modules of a first-party module that is not loaded here (core mode,
 * BEEFLOW_HIDE_MODULES): read from its provides file on disk, which the loader does not
 * list for a hidden module. Such a name is not registered, and that is the point.
 */
function absentModuleNames() {
    const loaded = new Set(require('../modules/firstParty/loader').modules().filter((m) => m.state === 'loaded').map((m) => m.id));
    const dir = path.join(SERVER, 'firstParty');
    /** @type {Set<string>} */
    const out = new Set();
    for (const name of fs.readdirSync(dir)) {
        const m = /^([A-Za-z][A-Za-z0-9_]*)\.provides\.json$/.exec(name);
        if (!m || loaded.has(/** @type {string} */ (m[1]))) continue;
        for (const fm of JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).featureModules || []) out.add(fm);
    }
    return out;
}
const absent = absentModuleNames();

test('the scan finds the calls it is meant to judge', () => {
    // A walker that silently finds nothing would pass both tests below.
    assert.ok(asked.size >= 20, `only ${asked.size} feature module names found in the source`);
    assert.ok(registered.size + absent.size >= 20, `only ${registered.size} feature modules registered (and ${absent.size} of absent modules)`);
});

test('every feature module the tree asks for is registered', () => {
    const unknown = [...asked]
        .filter(([name]) => !registered.has(name) && !absent.has(name))
        .map(([name, where]) => `${name}  (${where.join(', ')})`);
    assert.deepEqual(unknown, [],
        'featureModule() is called with a name nobody registers; register it in boot/featureModules.js (core) or in its module\'s firstParty/<id>.register.js (and its provides file), and add it to FeatureModuleMap in core/featureModules.js');
});

test('every registered feature module is asked for somewhere', () => {
    const unused = [...registered].filter((name) => !asked.has(name) && !named.has(name));
    assert.deepEqual(unused, [],
        'a feature module is registered that no source file names; remove the registration (boot/featureModules.js or firstParty/<id>.register.js) and its line in FeatureModuleMap');
});
