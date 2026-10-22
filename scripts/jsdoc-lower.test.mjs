import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits } from './ts-callsite-types.mjs';
import { lowerToJsDoc } from './jsdoc-lower.mjs';

test('parameters become @param tags in a new block; an optional one is [name]', () => {
    const text = "'use strict';\nfunction f(a, b) { return a; }\n";
    const host = text.indexOf('function');
    const { edits } = lowerToJsDoc(text, [
        { kind: 'param', name: 'a', index: 0, optional: false, type: 'string', host },
        { kind: 'param', name: 'b', index: 1, optional: true, type: 'number', host },
    ]);
    assert.equal(applyEdits(text, edits), "'use strict';\n/**\n * @param {string} a\n * @param {number} [b]\n */\nfunction f(a, b) { return a; }\n");
});

test('an existing JSDoc block takes the new tags before its end, and keeps the ones it has', () => {
    const text = '/**\n * Adds.\n * @param {number} a\n */\nfunction add(a, b) {}\n';
    const host = text.indexOf('function');
    const { edits } = lowerToJsDoc(text, [
        { kind: 'param', name: 'a', index: 0, type: 'string', host },
        { kind: 'param', name: 'b', index: 1, type: 'number', host },
    ]);
    assert.equal(applyEdits(text, edits), '/**\n * Adds.\n * @param {number} a\n * @param {number} b\n */\nfunction add(a, b) {}\n');
});

test('an interface becomes a typedef above the function and its own JSDoc', () => {
    const text = '/** Starts. */\nfunction start({ port }) {}\n';
    const host = text.indexOf('function');
    const { edits } = lowerToJsDoc(text, [
        { kind: 'interface', start: host, name: 'StartArgs', members: [{ key: 'port', optional: true, type: 'number' }] },
        { kind: 'param', name: null, index: 0, optional: true, type: 'StartArgs', host },
    ]);
    assert.equal(applyEdits(text, edits), '/**\n * @typedef {Object} StartArgs\n * @property {number} [port]\n */\n/**\n * Starts.\n * @param {StartArgs} [param0]\n */\nfunction start({ port }) {}\n');
});

test('variables get @type, a caught error a JSDoc cast, imports a typedef import; useState<T> is dropped', () => {
    const text = "const LABELS = { a: 'A' };\ntry { x(); } catch (e) { log(e.message); }\n";
    const e = text.indexOf('e.message');
    const { edits, dropped } = lowerToJsDoc(text, [
        { kind: 'var', type: 'Record<string, string>', host: 0 },
        { kind: 'castOpen', start: e, type: 'Error' }, { kind: 'castClose', start: e + 1, type: 'Error' },
        { kind: 'imports', imports: [['User', './users']] },
        { kind: 'typeArg', type: 'string' },
    ]);
    assert.equal(applyEdits(text, edits), "/** @typedef {import('./users').User} User */\n/** @type {Record<string, string>} */\nconst LABELS = { a: 'A' };\ntry { x(); } catch (e) { log(/** @type {Error} */ (e).message); }\n");
    assert.deepEqual(dropped, ['typeArg']);
});
