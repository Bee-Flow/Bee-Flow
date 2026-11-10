/**
 * Taking the screenshot (appStudioRenderShot.mts): what is photographed for each target,
 * always with animations disabled, and the fallbacks when a crop cannot be made.
 *
 * Run: node --test services/appStudioRenderShot.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shoot, waitForFonts, STILL_CSS } = require('./appStudioRenderShot.mts');

function fakePage({ box = { width: 100, height: 40 }, root = true } = {}) {
    const calls = [];
    const shootable = (name) => ({ screenshot: async (opts) => { calls.push([name, opts]); return Buffer.from(name); } });
    return {
        calls,
        page: {
            ...shootable('page'),
            $: async (sel) => { calls.push(['$', sel]); return root ? shootable('root') : null; },
            locator: (sel) => {
                calls.push(['locator', sel]);
                return { first: () => ({ ...shootable('node'), boundingBox: async (opts) => { calls.push(['box', opts]); return box; } }) };
            },
            evaluate: async (_fn, ms) => { calls.push(['evaluate', ms]); return true; },
        },
    };
}

test('the default target is #root, with animations disabled and the caret hidden', async () => {
    const { page, calls } = fakePage();
    const out = await shoot(page, null);
    assert.equal(out.png.toString(), 'root');
    assert.equal(out.note, null);
    const [, opts] = calls.find((c) => c[0] === 'root');
    assert.deepEqual(opts, { type: 'png', animations: 'disabled', caret: 'hide' });
});

test('an open modal photographs the whole page (the dialog is a portal on <body>)', async () => {
    const { page, calls } = fakePage();
    const out = await shoot(page, { fullPage: true });
    assert.equal(out.png.toString(), 'page');
    assert.equal(calls.find((c) => c[0] === 'page')[1].fullPage, true);
});

test('nodeId crops to the component, waiting a bounded time for it', async () => {
    const { page, calls } = fakePage();
    const out = await shoot(page, { nodeId: 'cmp_table1' });
    assert.equal(out.png.toString(), 'node');
    assert.deepEqual(calls.find((c) => c[0] === 'locator'), ['locator', '[data-node-id="cmp_table1"]']);
    assert.ok(calls.find((c) => c[0] === 'box')[1].timeout <= 1000);
});

test('an invisible component falls back to the screen and says so', async () => {
    const { page } = fakePage({ box: null });
    const out = await shoot(page, { nodeId: 'cmp_table1' });
    assert.equal(out.png.toString(), 'root');
    assert.match(out.note, /cmp_table1 is not visible/);
});

test('an id with characters outside the id alphabet never reaches a selector', async () => {
    const { page, calls } = fakePage();
    const out = await shoot(page, { nodeId: 'x"] , body [a="' });
    assert.equal(out.png.toString(), 'root');
    assert.ok(!calls.some((c) => c[0] === 'locator'));
});

test('without #root the viewport is photographed', async () => {
    const { page } = fakePage({ root: false });
    assert.equal((await shoot(page, null)).png.toString(), 'page');
});

test('the font wait is bounded, and the still style takes out animation and transition', async () => {
    const { page, calls } = fakePage();
    await waitForFonts(page);
    assert.ok(calls.find((c) => c[0] === 'evaluate')[1] <= 5000);
    assert.ok(STILL_CSS.includes('animation:none!important') && STILL_CSS.includes('transition:none!important'));
});
