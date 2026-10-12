'use strict';

/**
 * Run: cd server && node --test automation/patterns/sources/common.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { toMs, inWindow, checkToolResult, opaqueKey, sourceError, throwIfAborted, queryRows } = require('./common');

test('toMs reads dates, ISO and RFC 2822 strings, unix seconds and ms', () => {
    const ms = Date.UTC(2026, 9, 3, 12, 0);
    assert.strictEqual(toMs(new Date(ms)), ms);
    assert.strictEqual(toMs(new Date(ms).toISOString()), ms);
    assert.strictEqual(toMs(new Date(ms).toUTCString()), ms);
    assert.strictEqual(toMs(ms / 1000), ms);
    assert.strictEqual(toMs(String(ms / 1000)), ms);
    assert.strictEqual(toMs(ms), ms);
    assert.ok(Number.isNaN(toMs(null)) && Number.isNaN(toMs('')) && Number.isNaN(toMs('soon')));
});

test('inWindow allows a little clock skew at the top only', () => {
    const win = { since: 1000, now: 10_000 };
    assert.strictEqual(inWindow(999, win), false);
    assert.strictEqual(inWindow(1000, win), true);
    assert.strictEqual(inWindow(10_000 + 60_000, win), true);
    assert.strictEqual(inWindow(10_000 + 10 * 60_000, win), false);
    assert.strictEqual(inWindow(NaN, win), false);
});

test('checkToolResult turns connector errors into codes', () => {
    assert.deepStrictEqual(checkToolResult({ results: [] }, 't'), { results: [] });
    assert.throws(() => checkToolResult(null, 't'), (e) => e.code === 'error');
    assert.throws(() => checkToolResult({ error: 'Nextcloud authentication failed (401)' }, 't'), (e) => e.code === 'auth');
    assert.throws(() => checkToolResult({ error: 'Not connected to Gmail — user must log in with Google' }, 't'), (e) => e.code === 'auth');
    assert.throws(() => checkToolResult({ error: 'Mailbox list failed (500)' }, 't'), (e) => e.code === 'error');
});

test('opaqueKey is stable, scoped by kind, and hides the value', () => {
    assert.strictEqual(opaqueKey('series', 'abc'), opaqueKey('series', 'abc'));
    assert.notStrictEqual(opaqueKey('series', 'abc'), opaqueKey('folder', 'abc'));
    assert.match(opaqueKey('folder', '/Klanten/Jansen'), /^folder:[0-9a-f]{16}$/);
});

test('sourceError and throwIfAborted', () => {
    assert.strictEqual(sourceError('timeout').code, 'timeout');
    const ac = new AbortController();
    throwIfAborted(ac.signal);
    ac.abort();
    assert.throws(() => throwIfAborted(ac.signal), (e) => e.code === 'aborted');
});

test('queryRows: a missing table or column is no rows, anything else throws', async () => {
    const failing = (code) => ({ query: async () => { throw Object.assign(new Error(code), { code }); } });
    assert.deepStrictEqual(await queryRows(failing('42P01'), 'x', []), []);
    assert.deepStrictEqual(await queryRows(failing('42703'), 'x', []), []);
    await assert.rejects(queryRows(failing('57014'), 'x', []), /57014/);
    assert.deepStrictEqual(await queryRows({ query: async () => ({ rows: [{ a: 1 }] }) }, 'x', []), [{ a: 1 }]);
});
