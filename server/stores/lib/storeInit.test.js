/**
 * DB-free unit test for stores/lib/storeInit.js.
 *
 * Three things are load-bearing and are checked here: the memo runs the schema
 * once, it clears itself on failure so a store can recover from a database
 * that was not up yet, and the `../db` facade keeps its override seam — a test
 * double that ships its own makeStoreInit still owns schema creation, while a
 * double that does not keeps getting the real memo instead of crashing the
 * store at require time.
 *
 * Run: cd server && node --test --test-force-exit stores/lib/storeInit.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const { makeStoreInit } = require('./storeInit');

/** Answer `../db` from stores/lib with `exports` for the duration of `fn`. */
function withDbFacade(exports, fn) {
    const id = 'stub:storeInit:../db';
    require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === '../db') return id;
        return original.call(this, request, ...rest);
    };
    try {
        return fn();
    } finally {
        Module._resolveFilename = original;
        delete require.cache[id];
    }
}

test('the schema runs once however many callers await it', async () => {
    let runs = 0;
    const init = makeStoreInit('TestStore', async () => { runs += 1; });
    await Promise.all([init(), init(), init()]);
    await init();
    assert.strictEqual(runs, 1);
});

test('a failed init clears the memo so the next call retries', async () => {
    let attempts = 0;
    const init = makeStoreInit('FlakyStore', async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('DB not ready');
    });
    await assert.rejects(() => init(), /DB not ready/);
    await init();
    assert.strictEqual(attempts, 2);
});

test('every caller of a failing init sees the error, not a silent success', async () => {
    const init = makeStoreInit('BrokenStore', async () => { throw new Error('relation missing'); });
    const results = await Promise.allSettled([init(), init()]);
    assert.deepStrictEqual(results.map(r => r.status), ['rejected', 'rejected']);
});

test('a db double that brings its own makeStoreInit keeps owning schema creation', () => {
    let taken = null;
    const noop = async () => {};
    const init = withDbFacade({ makeStoreInit: (tag, fn) => { taken = { tag, fn }; return noop; } },
        () => makeStoreInit('StubbedStore', async () => { throw new Error('must not run'); }));
    assert.strictEqual(init, noop, 'the double decides what init does');
    assert.strictEqual(taken.tag, 'StubbedStore');
});

test('a four-function db double still gets a working init', async () => {
    // The hermetic store tests replace `../db` with run/getOne/getAll/exec and
    // nothing else. Before the memo moved out of db.js that made every store
    // throw "makeStoreInit is not a function" at require time.
    let runs = 0;
    const init = withDbFacade({ run: async () => {}, getOne: async () => null, getAll: async () => [], exec: async () => {} },
        () => makeStoreInit('BareStore', async () => { runs += 1; }));
    await init();
    await init();
    assert.strictEqual(runs, 1);
});

test('db.makeStoreInit is this same function, so the real facade does not recurse', () => {
    // db.js re-exports this module; without the identity check in makeStoreInit
    // the facade lookup would call straight back into itself.
    const db = require('../../db');
    assert.strictEqual(db.makeStoreInit, makeStoreInit);
});
