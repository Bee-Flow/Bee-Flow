/**
 * docxHouseStyle — which Word house style applies, and what it becomes.
 *
 * DB-free: the house-style store is stubbed.
 *
 * Run: node --test core/documents/docxHouseStyle.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const calls = [];
const STYLE = { id: 'hs-1', name: 'Kantoorstijl', styleMeta: {} };
installResolveStub({
    '../../stores/houseStyleStore': {
        getById: async (id, orgId) => { calls.push(['byId', id, orgId]); return id === 'hs-1' && orgId === 'org-1' ? STYLE : null; },
        getDefaultForOrg: async (orgId) => {
            calls.push(['default', orgId]);
            if (orgId === 'org-broken') throw new Error('db down');
            return orgId === 'org-1' ? STYLE : null;
        },
    },
});

const { resolveHouseStyle, buildDocxStylingFromHouseStyle, applyInlineStyles, NO_SUCH_STYLE } = require('./docxHouseStyle');

test('resolveHouseStyle: none, an explicit id, the org default', async () => {
    calls.length = 0;
    assert.strictEqual(await resolveHouseStyle('org-1', 'none'), null);
    assert.deepStrictEqual(calls, [], "'none' asks the store nothing");

    assert.strictEqual(await resolveHouseStyle('org-1', 'hs-1'), STYLE);
    assert.strictEqual(await resolveHouseStyle('org-2', 'hs-1'), NO_SUCH_STYLE, "another org's style is not yours");
    assert.strictEqual(await resolveHouseStyle(null, 'hs-1'), NO_SUCH_STYLE);

    assert.strictEqual(await resolveHouseStyle('org-1'), STYLE);
    assert.strictEqual(await resolveHouseStyle('org-3', null), null);
    assert.strictEqual(await resolveHouseStyle(null, null), null);
    assert.strictEqual(await resolveHouseStyle('org-broken'), null, 'a store failure is no style, not an error');
});

test('buildDocxStylingFromHouseStyle: defaults without a style, the style\'s values with one', () => {
    const plain = buildDocxStylingFromHouseStyle(null);
    assert.strictEqual(plain.opts.font, 'Calibri');
    assert.strictEqual(plain.opts.fontSize, 22, 'half-points');
    assert.deepStrictEqual(plain.opts.margin, { top: 1440, right: 1440, bottom: 1440, left: 1440 });
    assert.strictEqual(plain.opts.headerHTML, undefined);
    assert.match(plain.css, /font-family: "Calibri"/);

    const styled = buildDocxStylingFromHouseStyle({
        styleMeta: {
            defaultFont: 'Georgia', defaultFontSize: 12,
            headings: { h1: { font: 'Arial', size: 24, bold: true, color: '#ff0000' } },
            header: { text: 'Acme <BV>' }, footer: { text: 'Vertrouwelijk' },
        },
    });
    assert.strictEqual(styled.opts.font, 'Georgia');
    assert.strictEqual(styled.opts.fontSize, 24);
    assert.match(styled.css, /h1 \{ font-family: "Arial", sans-serif; font-size: 24pt; font-weight: bold; color: #ff0000;/);
    assert.strictEqual(styled.opts.header, true);
    assert.match(styled.opts.headerHTML, /Acme &lt;BV&gt;/, 'header text is escaped');
    assert.strictEqual(styled.opts.footer, true);
    assert.match(styled.opts.footerHTML, /Vertrouwelijk/);
});

test('heading styles come back inline (html-to-docx ignores <style>) and applyInlineStyles puts them on the tags', () => {
    const { inline } = buildDocxStylingFromHouseStyle({
        styleMeta: { headings: { h2: { font: 'Times New Roman', size: 30, bold: true, color: '#ff0000' } } },
    });
    assert.strictEqual(inline.h2, "font-family:'Times New Roman';font-size:30pt;font-weight:bold;color:#ff0000");
    const html = applyInlineStyles('<h2>A</h2><h2 class="x" style="color:blue">B</h2><header><h1>T</h1></header>', inline);
    assert.match(html, /<h2 style="font-family:'Times New Roman';font-size:30pt;font-weight:bold;color:#ff0000">A<\/h2>/);
    assert.match(html, /<h2 class="x" style="[^"]*color:#ff0000;color:blue">B/, "the tag's own style comes last and wins");
    assert.match(html, /<header><h1 style="font-family:'Calibri'/, '<header> is not an h tag; the h1 inside gets the default');
    assert.strictEqual(applyInlineStyles('<h2>A</h2>', null), '<h2>A</h2>');
});

test('font names and colours from an uploaded template cannot break out of CSS or an attribute', () => {
    const styled = buildDocxStylingFromHouseStyle({
        styleMeta: {
            defaultFont: `Evil'"><script>`, header: { text: 'x' },
            headings: { h1: { font: 'A"><b>', size: 20, color: 'red;"><x' } },
        },
    });
    for (const out of [styled.css, styled.inline.h1]) assert.doesNotMatch(out, /[<>]/);
    assert.doesNotMatch(styled.inline.h1, /"/);
    assert.match(styled.opts.headerHTML, /^<p style="font-family:'Evilscript',sans-serif;[^"<>]*">x<\/p>$/);
    assert.match(styled.inline.h1, /color:redx$/, "no ; to start another declaration");
    assert.strictEqual(styled.opts.font, 'Evilscript');
});
