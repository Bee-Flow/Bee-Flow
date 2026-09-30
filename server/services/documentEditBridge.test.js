'use strict';

/**
 * The editing bridge inside the designed-document frame
 * (services/documentEditBridge.js), run in jsdom exactly as the composer
 * serves it: what it reports, what it does on the editor's messages, and the
 * rule that everything it draws stays OUTSIDE the body that is saved.
 *
 * jsdom has no MessageEvent.source for postMessage, so the editor's messages
 * are dispatched with the frame's parent (in jsdom: the window itself) as
 * their source, the one check the bridge makes.
 *
 * Run: cd server && node --test services/documentEditBridge.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { composeDocument } = require('./documentCompose');

const BODY = '<h1>Offer</h1><section data-doc-section="pricing"><h2>Pricing</h2><p>Price {{amount}} per month</p></section>'
    + '<section data-doc-section="terms"><p>Terms apply. Price is final.</p></section>';

async function frame(body = BODY) {
    const dom = new JSDOM(composeDocument({ bodyHtml: body, css: '' }, { mode: 'preview' }), { runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    const out = [];
    // A JSON copy: the frame's objects belong to another realm.
    window.addEventListener('message', (e) => { if (!e.source) out.push(JSON.parse(JSON.stringify(e.data))); });
    for (let i = 0; i < 100 && !out.some((m) => m.__beeflowDocReady); i++) await new Promise((r) => setTimeout(r, 20));
    const send = async (data) => {
        window.dispatchEvent(new window.MessageEvent('message', { data, source: window }));
        await new Promise((r) => setTimeout(r, 20));
    };
    const last = (key) => [...out].reverse().find((m) => m && m[key]);
    return { window, document: window.document, out, send, last };
}

test('on load it says it is ready, with the outline and the counts', async () => {
    const f = await frame();
    assert.ok(f.last('__beeflowDocReady'));
    assert.deepStrictEqual(f.last('__beeflowDocOutline').items, [
        { index: 0, level: 1, text: 'Offer', sectionId: null },
        { index: 1, level: 2, text: 'Pricing', sectionId: 'pricing' },
        { index: 2, level: 2, text: 'Terms apply. Price is final.', sectionId: 'terms' },
    ], 'h1–h3, and a section without a heading by its text');
    const stats = f.last('__beeflowDocStats');
    assert.strictEqual(stats.pages, 1);
    assert.ok(stats.words > 0);
});

test('a flush reports the body with placeholders as typed, never the protection spans', async () => {
    const f = await frame();
    await f.send({ __beeflowDocEdit: true, editing: true });
    assert.strictEqual(f.document.body.getAttribute('contenteditable'), 'true');
    assert.ok(f.document.querySelector('[data-doc-token]'), 'tokens are protected while editing');
    await f.send({ __beeflowDocFlush: true, requestId: 'r1' });
    const dirty = f.last('__beeflowDocDirty');
    assert.strictEqual(dirty.requestId, 'r1');
    assert.strictEqual(dirty.html, BODY);
});

test('other people are drawn outside the body, so they are never saved', async () => {
    const f = await frame();
    await f.send({ __beeflowDocPeers: true, peers: [{ sectionId: 'pricing', label: 'Anna is editing', tone: 1 }, { sectionId: 'missing', label: 'x' }] });
    const layer = f.document.getElementById('bf-peer-layer');
    assert.ok(layer && layer.parentElement === f.document.documentElement, 'a child of <html>, not of <body>');
    assert.strictEqual(layer.querySelectorAll('.bf-peer').length, 1, 'only for a section that exists');
    assert.strictEqual(layer.textContent, 'Anna is editing');
    await f.send({ __beeflowDocFlush: true, requestId: 'r2' });
    assert.strictEqual(f.last('__beeflowDocDirty').html, BODY);
    assert.doesNotMatch(f.document.body.innerHTML, /Anna/);
});

test('changes by others are put into their sections, and says which it could not find', async () => {
    const f = await frame();
    await f.send({ __beeflowDocPatch: true, sections: { pricing: '<h2>Pricing</h2><p>New {{amount}}</p>', gone: '<p>x</p>' } });
    const patched = f.last('__beeflowDocPatched');
    assert.deepStrictEqual(patched, { __beeflowDocPatched: true, applied: ['pricing'], missing: ['gone'] });
    await f.send({ __beeflowDocFlush: true, requestId: 'r3' });
    assert.match(f.last('__beeflowDocDirty').html, /<p>New \{\{amount\}\}<\/p>/);
});

test('find counts matches across the body and steps through them', async () => {
    const f = await frame();
    await f.send({ __beeflowDocFind: true, query: 'price', step: 1 });
    assert.deepStrictEqual(f.last('__beeflowDocFound'), { __beeflowDocFound: true, count: 2, index: 0 }, 'case-insensitive, whole body');
    await f.send({ __beeflowDocFind: true, query: 'price', step: -1 });
    assert.strictEqual(f.last('__beeflowDocFound').index, 1, 'backwards wraps around');
    await f.send({ __beeflowDocFind: true, query: '' });
    assert.deepStrictEqual(f.last('__beeflowDocFound'), { __beeflowDocFound: true, count: 0, index: -1 });
});

test('shortcuts pressed inside the frame reach the editor', async () => {
    const f = await frame();
    const press = (init) => f.document.body.dispatchEvent(new f.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    press({ key: 's', ctrlKey: true });
    press({ key: 'H', metaKey: true, shiftKey: true });
    press({ key: 'm', ctrlKey: true, altKey: true });
    press({ key: 'Escape' });
    press({ key: 'x', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(f.out.filter((m) => m.__beeflowDocKey).map((m) => m.key), ['save', 'history', 'comment', 'escape']);
});

test('a theme colour is applied to the desk only when it looks like a colour', async () => {
    const f = await frame();
    await f.send({ __beeflowDocTheme: true, desk: 'rgb(20, 22, 26)' });
    assert.strictEqual(f.document.documentElement.style.background, 'rgb(20, 22, 26)');
    await f.send({ __beeflowDocTheme: true, desk: 'url(https://tracker.example/x)' });
    assert.strictEqual(f.document.documentElement.style.background, 'rgb(20, 22, 26)', 'no url() sneaks in');
});

test('messages that do not come from the editor are ignored', async () => {
    const f = await frame();
    f.window.dispatchEvent(new f.window.MessageEvent('message', { data: { __beeflowDocEdit: true, editing: true } }));
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(f.document.body.getAttribute('contenteditable'), 'false');
});

test('a section with somebody\'s caret in it is never replaced under them', async () => {
    const f = await frame();
    await f.send({ __beeflowDocEdit: true, editing: true });
    const p = f.document.querySelector('[data-doc-section="pricing"] p');
    const range = f.document.createRange();
    range.setStart(p.firstChild, 2);
    range.collapse(true);
    f.document.getSelection().removeAllRanges();
    f.document.getSelection().addRange(range);
    await f.send({ __beeflowDocPatch: true, sections: { pricing: '<p>theirs</p>', terms: '<p>new terms</p>' } });
    assert.deepStrictEqual(f.last('__beeflowDocPatched'), { __beeflowDocPatched: true, applied: ['terms'], missing: ['pricing'] });
    assert.match(f.document.body.innerHTML, /Price/);
});
