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

test('a destructured parameter the block already documents by position gets no second tag; names parse past nested braces', () => {
    const text = '/**\n * @param {{ a: string }} args\n * @param {string} args.a\n */\nfunction f({ a }, b) {}\n';
    const host = text.indexOf('function');
    const { edits } = lowerToJsDoc(text, [
        { kind: 'interface', start: host, name: 'FArgs', members: [{ key: 'a', optional: false, type: 'string' }] },
        { kind: 'param', name: null, index: 0, optional: false, type: 'FArgs', host },
        { kind: 'param', name: 'b', index: 1, optional: false, type: 'number', host },
    ]);
    const out = applyEdits(text, edits);
    assert.doesNotMatch(out, /param0/);
    assert.match(out, / \* @param \{number\} b\n \*\/\nfunction f/);
    // a tag whose type has nested braces still counts as documenting its name
    const nested = '/**\n * @param {{ a: { b: string } }} args\n */\nfunction g(args) {}\n';
    const { edits: again } = lowerToJsDoc(nested, [{ kind: 'param', name: 'args', index: 0, type: 'X', host: nested.indexOf('function') }]);
    assert.deepEqual(again, []);
    // a `let` in the middle of a line gets its @type inline, not at the start of the line
    const inline = 'function h() { let t = null; return t; }\n';
    const { edits: mid } = lowerToJsDoc(inline, [{ kind: 'var', type: 'number | null', host: inline.indexOf('let') }]);
    assert.equal(applyEdits(inline, mid), 'function h() { let /** @type {number | null} */ t = null; return t; }\n');
});

test('a typedef or typedef import the text already holds is not added again; a generic import is written inline', () => {
    const text = "/** @typedef {import('./x').T} T */\n/**\n * @typedef {Object} FArgs\n * @property {string} a\n */\nfunction f({ a }, tok) {}\n";
    const host = text.indexOf('function');
    const { edits } = lowerToJsDoc(text, [
        { kind: 'interface', start: host, name: 'FArgs', members: [{ key: 'a', optional: false, type: 'string' }] },
        { kind: 'param', name: 'tok', index: 1, optional: false, type: 'WithImplicitCoercion<string> | T', host },
        { kind: 'imports', imports: [['T', './x', false], ['WithImplicitCoercion', 'buffer', true]] },
    ]);
    const out = applyEdits(text, edits);
    assert.equal(out.match(/@typedef/g).length, 2);
    assert.match(out, /@param \{import\('buffer'\)\.WithImplicitCoercion<string> \| T\} tok/);
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
