// @typecheck strict
/**
 * modules/firstParty/loader.js and a module's provides file, firstParty/<id>.provides.json:
 * declared from the same listing BEFORE the composition is required, so a composition that
 * throws while it loads still leaves its names "failed" (an optional lookup throws instead of
 * answering "absent"); a `provides` in the composition must then say the same.
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const loader = require('./loader');
const moduleState = require('./moduleState');

/**
 * Loader deps over a virtual firstParty/ with compositions and provides files. A value that is a
 * function is called instead of requiring (to throw).
 * @param {Record<string, unknown>} files file name -> what requiring it gives
 */
function depsFor(files) {
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const required = [];
    return {
        errors,
        required,
        log: { info() {}, warn() {}, error: (/** @type {unknown[]} */ ...a) => { errors.push(a.join(' ')); } },
        listTreeDir: () => Object.keys(files).map((name) => ({ name, abs: `/tree/firstParty/${name}` })),
        catalog: { isModuleAvailable: () => true },
        require: (/** @type {string} */ file) => {
            const name = file.slice('/tree/firstParty/'.length);
            required.push(name);
            const value = files[name];
            return typeof value === 'function' ? value() : value;
        },
    };
}

/** id -> state */
const states = () => Object.fromEntries(loader.modules().map((m) => [m.id, m.state]));

beforeEach(() => loader._resetLoaderForTests());

test('the provides file is read before the composition, and a composition that throws leaves its names failed', () => {
    const deps = depsFor({
        'a.js': () => { throw new Error('broken on load'); },
        'a.provides.json': { featureModules: ['a/thing'], runnerPorts: ['aPort'] },
        'b.js': { id: 'b' },
    });
    loader.load(deps);
    assert.deepStrictEqual(states(), { a: 'failed', b: 'loaded' });
    assert.deepStrictEqual(deps.required.slice(0, 2), ['a.provides.json', 'a.js']);
    assert.strictEqual(moduleState.providerOf('featureModules', 'a/thing'), 'a');
    assert.throws(() => moduleState.assertProviderNotFailed('runnerPorts', 'aPort'), { code: 'MODULE_FAILED' });
});

test('a composition without its own provides keeps the names of the file', () => {
    loader.load(depsFor({ 'a.js': { id: 'a' }, 'a.provides.json': { integrationClients: ['aClient'] } }));
    assert.deepStrictEqual(states(), { a: 'loaded' });
    assert.strictEqual(moduleState.providerOf('integrationClients', 'aClient'), 'a');
});

test('a provides in the composition must equal the file (order inside a list does not matter)', () => {
    loader.load(depsFor({
        'same.js': { id: 'same', provides: { featureModules: ['y', 'x'] } },
        'same.provides.json': { featureModules: ['x', 'y'], runnerPorts: [] },
        'other.js': { id: 'other', provides: { featureModules: ['z'] } },
        'other.provides.json': { featureModules: ['w'] },
    }));
    assert.deepStrictEqual(states(), { other: 'failed', same: 'loaded' });
    assert.match(String(loader.modules().find((m) => m.id === 'other')?.detail), /provides differ from firstParty\/other\.provides\.json/);
});

test('a provides file that is not a provides object fails its module, and the composition is not required', () => {
    const deps = depsFor({ 'a.js': { id: 'a' }, 'a.provides.json': { features: ['x'] }, 'b.js': { id: 'b' }, 'b.provides.json': () => { throw new SyntaxError('bad json'); } });
    loader.load(deps);
    assert.deepStrictEqual(states(), { a: 'failed', b: 'failed' });
    assert.ok(!deps.required.includes('a.js') && !deps.required.includes('b.js'));
    assert.match(deps.errors.join('\n'), /firstParty\/a\.provides\.json: provides\.features is not one of/);
    assert.match(deps.errors.join('\n'), /firstParty\/b\.provides\.json: could not be read: bad json/);
});

test('register() stays synchronous: it returns nothing, and a module whose register throws fails alone', () => {
    /** @type {string[]} */
    const ran = [];
    loader.load(depsFor({
        'a.js': { id: 'a', register: () => { ran.push('a'); throw new Error('a broke'); } },
        'b.js': { id: 'b', register: () => { ran.push('b'); } },
    }));
    assert.strictEqual(loader.register(), undefined);
    assert.deepStrictEqual(ran, ['a', 'b']);
    assert.deepStrictEqual(states(), { a: 'failed', b: 'loaded' });
});
