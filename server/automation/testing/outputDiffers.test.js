'use strict';
/**
 * The output-differ registry and the built-in generated_file differ.
 * Run: cd server && node --test automation/testing/outputDiffers.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerOutputDiffer, listOutputDiffers, differFor, cutValue } = require('./outputDiffers');
const { diffJson } = require('./jsonDiff');

const summaries = {
    a: { f1: { name: 'deck.pptx', mime: 'application/x', size: 100, sha256: 'aa', parts: [
        { kind: 'slide', index: 0, title: 'One', textChars: 10, textHash: 'h1' },
        { kind: 'slide', index: 1, title: 'Two', textChars: 20, textHash: 'h2' },
    ] } },
    b: { f2: { name: 'deck.pptx', mime: 'application/x', size: 120, sha256: 'bb', parts: [
        { kind: 'slide', index: 0, title: 'One', textChars: 10, textHash: 'h1' },
        { kind: 'slide', index: 1, title: 'Second', textChars: 25, textHash: 'h9' },
        { kind: 'slide', index: 2, title: 'Three', textChars: 5, textHash: 'h3' },
    ] } },
};
const ctx = { caps: {}, loadFileSummary: async (id, side) => summaries[side][id] || null };

test('the built-in generated_file differ is registered and claims only file handles', () => {
    assert.ok(listOutputDiffers().some(d => d.kind === 'generated_file'));
    assert.strictEqual(differFor({ kind: 'generated_file', fileId: 'f1' }).kind, 'generated_file');
    assert.strictEqual(differFor({ kind: 'generated_file' }), null);
    assert.strictEqual(differFor({ kind: 'other', fileId: 'f1' }), null);
    assert.strictEqual(differFor('generated_file'), null);
    assert.strictEqual(differFor(null), null);
    assert.strictEqual(differFor([{ kind: 'generated_file', fileId: 'x' }]), null);
});

test('register adds a differ, re-registering a kind replaces it, and bad input is refused', () => {
    registerOutputDiffer({ kind: 'sample_x', matches: (v) => v.tag === 1, diff: async () => ({ changes: [] }) });
    assert.strictEqual(differFor({ kind: 'sample_x', tag: 1 }).kind, 'sample_x');
    assert.strictEqual(differFor({ kind: 'sample_x', tag: 2 }), null);
    const before = listOutputDiffers().length;
    registerOutputDiffer({ kind: 'sample_x', matches: (v) => v.tag === 2, diff: async () => ({ changes: [] }) });
    assert.strictEqual(listOutputDiffers().length, before);
    assert.strictEqual(differFor({ kind: 'sample_x', tag: 1 }), null);
    assert.ok(differFor({ kind: 'sample_x', tag: 2 }));
    assert.throws(() => registerOutputDiffer({ kind: '', matches() {}, diff() {} }), TypeError);
    assert.throws(() => registerOutputDiffer({ kind: 'bad', matches: 1, diff() {} }), TypeError);
});

test('a matches() that throws counts as no match', () => {
    registerOutputDiffer({ kind: 'sample_throws', matches: () => { throw new Error('x'); }, diff: async () => ({ changes: [] }) });
    assert.strictEqual(differFor({ kind: 'sample_throws' }), null);
});

test('generated_file: compares name, mime, size, sha256 and parts by index', async () => {
    const differ = differFor({ kind: 'generated_file', fileId: 'f1' });
    const { changes } = await differ.diff({ kind: 'generated_file', fileId: 'f1' }, { kind: 'generated_file', fileId: 'f2' }, ctx);
    assert.deepStrictEqual(changes, [
        { path: 'slides[1].title', change: 'changed', before: '"Two"', after: '"Second"' },
        { path: 'slides[1].textChars', change: 'changed', before: '20', after: '25' },
        { path: 'slides[1].textHash', change: 'changed', before: '"h2"', after: '"h9"' },
        { path: 'slides[2]', change: 'added', after: cutValue(summaries.b.f2.parts[2]) },
    ]);
});

test('generated_file: a file without readable parts is compared by size and hash', async () => {
    const differ = differFor({ kind: 'generated_file', fileId: 'x' });
    const h = (id) => ({ kind: 'generated_file', fileId: id });
    const sums = { a: { name: 'r.pdf', mime: 'application/pdf', size: 5, sha256: 'aa' }, b: { name: 'r.pdf', mime: 'application/pdf', size: 6, sha256: 'bb' } };
    const { changes } = await differ.diff(h('x'), h('y'), { caps: {}, loadFileSummary: async (_id, side) => sums[side] });
    assert.deepStrictEqual(changes.map(c => c.path), ['size', 'sha256']);
});

test('generated_file: identical content is no change; an unreadable side is reported', async () => {
    const same = { name: 'a.pdf', mime: 'application/pdf', size: 5, sha256: 'z' };
    const sameCtx = { caps: {}, loadFileSummary: async () => same };
    const differ = differFor({ kind: 'generated_file', fileId: 'x' });
    const h = (id) => ({ kind: 'generated_file', fileId: id });
    assert.deepStrictEqual((await differ.diff(h('x'), h('y'), sameCtx)).changes, []);
    const half = { caps: {}, loadFileSummary: async (_id, side) => (side === 'a' ? same : null) };
    assert.deepStrictEqual((await differ.diff(h('x'), h('y'), half)).changes, [{ path: 'file', change: 'removed', before: '"a.pdf"' }]);
    const none = { caps: {}, loadFileSummary: async () => null };
    assert.deepStrictEqual((await differ.diff(h('x'), h('y'), none)).changes, []);
});

test('through the JSON walk the file handle is compared by content, not by id', async () => {
    const out = await diffJson(
        { file: { kind: 'generated_file', fileId: 'f1' } },
        { file: { kind: 'generated_file', fileId: 'f2' } },
        { ctx },
    );
    assert.ok(out.changes.every(c => c.path.startsWith('file.')));
    assert.ok(!out.changes.some(c => c.path === 'file.fileId'));
    assert.ok(out.changes.some(c => c.path === 'file.slides[1].title'));
});
