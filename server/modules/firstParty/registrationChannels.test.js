// @typecheck strict
/**
 * modules/firstParty/registrationChannels.js: a module's contribution runs when the core file of
 * its channel loads (or at once when it already has), again when that file loads again, and the
 * modules register once per process, held while boot loads the core files.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const loader = require('./loader');
const channels = require('./registrationChannels');

/** @type {string[]} */
let ran;

/** The loader over one fake module whose register() contributes to two channels. */
function fakeModules() {
    loader.load({
        listTreeDir: () => [{ name: 'm.js', abs: '/tree/firstParty/m.js' }],
        catalog: { isModuleAvailable: () => true },
        log: { info() {}, warn() {}, error() {} },
        require: () => ({
            id: 'm',
            register: () => {
                ran.push('register');
                channels.contribute('core/a', () => { ran.push('a'); });
                channels.contribute('core/b', () => { ran.push('b'); });
            },
        }),
    });
}

beforeEach(() => {
    ran = [];
    channels._resetChannelsForTests();
    loader._resetLoaderForTests();
    fakeModules();
});
afterEach(() => {
    channels._resetChannelsForTests();
    loader._resetLoaderForTests();
});

test('opening a channel registers the modules once; a closed channel waits for its core file', () => {
    channels.openChannel('core/a');
    assert.deepStrictEqual(ran, ['register', 'a']);
    channels.openChannel('core/b');
    assert.deepStrictEqual(ran, ['register', 'a', 'b']);
    channels.registerModules();
    assert.deepStrictEqual(ran, ['register', 'a', 'b'], 'register() runs once');
});

test('opening a channel again runs its contributions again, as reloading the core file re-ran its lines', () => {
    channels.openChannel('core/a');
    channels.openChannel('core/a');
    assert.deepStrictEqual(ran, ['register', 'a', 'a']);
});

test('held: the core files open their channels first, the modules register on release, inside the fence', () => {
    channels.holdModuleRegistration();
    channels.openChannel('core/a');
    channels.openChannel('core/b');
    assert.deepStrictEqual(ran, []);
    channels.releaseModuleRegistration();
    assert.deepStrictEqual(ran, ['register', 'a', 'b']);
    assert.deepStrictEqual(channels.channelSummary(), [
        { name: 'core/a', open: true, contributions: 1 },
        { name: 'core/b', open: true, contributions: 1 },
    ]);
});

test('a contribution that throws at register time fails its module (the loader fence)', () => {
    loader._resetLoaderForTests();
    loader.load({
        listTreeDir: () => [{ name: 'bad.js', abs: '/x' }],
        catalog: { isModuleAvailable: () => true },
        log: { info() {}, warn() {}, error() {} },
        require: () => ({ id: 'bad', register: () => channels.contribute('core/a', () => { throw new Error('row broke'); }) }),
    });
    channels.holdModuleRegistration();
    channels.openChannel('core/a');
    channels.releaseModuleRegistration();
    assert.strictEqual(loader.modules()[0]?.state, 'failed');
    assert.match(String(loader.modules()[0]?.detail), /register\(\) threw: row broke/);
});

test('a contribution is a function, a channel a name', () => {
    assert.throws(() => channels.contribute('core/a', /** @type {any} */ (null)), TypeError);
    assert.throws(() => channels.openChannel(''), TypeError);
});
