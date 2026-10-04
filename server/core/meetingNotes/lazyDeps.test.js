/**
 * lazyDeps tests — collaborators load on first use, an override is never
 * loaded, and init() resets what it does not name.
 *
 * Run: cd server && node --test core/meetingNotes/lazyDeps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { lazyDeps } = require('./lazyDeps');

test('loads each collaborator once, on first use', () => {
    let loads = 0;
    const { deps } = lazyDeps({ thing: () => { loads++; return { v: 1 }; } });
    assert.strictEqual(loads, 0);
    assert.strictEqual(deps.thing.v, 1);
    assert.strictEqual(deps.thing.v, 1);
    assert.strictEqual(loads, 1);
});

test('an override wins and the real loader never runs; init() again restores it', () => {
    let loads = 0;
    const { deps, init } = lazyDeps({ thing: () => { loads++; return 'real'; } });
    init({ thing: 'fake' });
    assert.strictEqual(deps.thing, 'fake');
    assert.strictEqual(loads, 0);
    init();
    assert.strictEqual(deps.thing, 'real');
    assert.strictEqual(loads, 1);
});

test('an unknown name is undefined, not a crash', () => {
    const { deps } = lazyDeps({});
    assert.strictEqual(deps.nope, undefined);
});
