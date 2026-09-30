/**
 * Smoke test of the generated co-editing bundle (editorCollab.cjs, built from
 * agent-hub/src/editor/collab/serverEntry.ts by `npm run build:editor-collab`).
 *
 * Proven: the bundle loads from the server and exposes its API; it uses the
 * server's own Yjs (a fragment made with `require('yjs')` here round-trips
 * through it, which fails with a second Yjs copy); a minimal sync from two
 * documents converges; hostile shared content is sanitised on read; relative
 * positions survive a base64 trip; the version diff reports counts.
 *
 * Run: cd server && node --test core/markdown/editorCollab.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Y = require('yjs');
const { JSDOM } = require('jsdom');

const BUNDLE = path.join(__dirname, 'editorCollab.cjs');
const C = require(BUNDLE);
const DOMParserImpl = new JSDOM('').window.DOMParser;

const API = [
    'markdownToAst', 'htmlToAst', 'astToMarkdown', 'astToHtml', 'normalizeLight', 'astToFragment', 'fragmentToAst',
    'createYCache', 'sameInY', 'syncDocToFragment', 'relativeFromPos', 'posFromRelative', 'encodeRelpos',
    'decodeRelpos', 'diffDocs', 'diffHtml', 'diffMarkdown',
];

function fragmentOf(doc) {
    return doc.getXmlFragment(C.FRAGMENT_NAME);
}

test('the bundle exposes the co-editing API and keeps Yjs external', () => {
    for (const name of API) assert.equal(typeof C[name], 'function', name);
    assert.equal(C.FRAGMENT_NAME, 'content');
    const src = fs.readFileSync(BUNDLE, 'utf8');
    assert.match(src.split('\n')[0], /GENERATED/);
    assert.match(src, /require\("yjs"\)/);
    assert.doesNotMatch(src, /Yjs was already imported/);
});

test('Markdown survives a trip through a shared document made with the server Yjs', () => {
    const md = '# Plan\n\nShip **on** Monday with [docs](https://example.com).\n\n- one\n- [x] done\n\n| A | B |\n| --- | --- |\n| 1 | =A2+1 |';
    const ast = C.normalizeLight(C.markdownToAst(md));
    const doc = new Y.Doc();
    C.astToFragment(ast, fragmentOf(doc));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const back = C.fragmentToAst(fragmentOf(peer));
    assert.equal(C.sameInY(C.normalizeLight(back), ast), true);
    assert.equal(C.astToMarkdown(back), C.astToMarkdown(ast));
    assert.match(C.astToHtml(back), /<h1>Plan<\/h1>/);
});

test('two documents syncing edits converge', () => {
    const a = new Y.Doc();
    C.astToFragment(C.markdownToAst('hello world'), fragmentOf(a));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const cacheA = C.createYCache();
    const cacheB = C.createYCache();
    C.fragmentToAst(fragmentOf(a), cacheA);
    C.fragmentToAst(fragmentOf(b), cacheB);
    C.syncDocToFragment(fragmentOf(a), C.markdownToAst('hello brave world'), cacheA);
    C.syncDocToFragment(fragmentOf(b), C.markdownToAst('hello world!'), cacheB);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    assert.equal(C.astToMarkdown(C.fragmentToAst(fragmentOf(a))).trim(), 'hello brave world!');
    assert.deepEqual(C.fragmentToAst(fragmentOf(a)), C.fragmentToAst(fragmentOf(b)));
    cacheA.destroy();
    cacheB.destroy();
});

test('hostile shared content is sanitised on read', () => {
    const doc = new Y.Doc();
    const fragment = fragmentOf(doc);
    doc.transact(() => {
        fragment.insert(0, [new Y.XmlElement('script')]);
        const el = new Y.XmlElement('textblock');
        el.setAttribute('type', 'paragraph');
        const text = new Y.XmlText();
        el.insert(0, [text]);
        fragment.insert(1, [el]);
        text.insert(0, 'click', { link: { href: 'javascript:alert(1)' }, onclick: 'x' });
    });
    const ast = C.fragmentToAst(fragment);
    assert.deepEqual(ast, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'click' }] }] });
    assert.doesNotMatch(C.astToHtml(ast), /javascript|onclick|script/);
});

test('relative positions survive a base64 trip and a concurrent insert', () => {
    const doc = new Y.Doc();
    C.astToFragment(C.markdownToAst('alpha beta'), fragmentOf(doc));
    const b64 = C.encodeRelpos(C.relativeFromPos(fragmentOf(doc), [0], 6));
    C.syncDocToFragment(fragmentOf(doc), C.markdownToAst('the alpha beta'));
    assert.deepEqual(C.posFromRelative(fragmentOf(doc), doc, C.decodeRelpos(b64)), { path: [0], offset: 10 });
    assert.equal(C.decodeRelpos('not a position!'), null);
});

test('the version diff reports words and blocks changed', () => {
    const d = C.diffMarkdown('Intro.\n\nShip on Monday.', 'Intro.\n\nShip on Tuesday.\n\nA new line.');
    assert.deepEqual(d.stats, { wordsAdded: 4, wordsRemoved: 1, blocksChanged: 2 });
    const h = C.diffHtml('<p>one two</p>', '<p>one three</p>', DOMParserImpl);
    assert.deepEqual(h.stats, { wordsAdded: 1, wordsRemoved: 1, blocksChanged: 1 });
    assert.equal(C.htmlToAst('<p>x</p>', DOMParserImpl).content[0].type, 'paragraph');
});
