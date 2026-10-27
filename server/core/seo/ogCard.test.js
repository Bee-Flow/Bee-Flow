// @typecheck strict
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCardSvg, renderCard, templateOf, hex, versionOf, TEMPLATES } = require('./ogCard');
const { SHARE_IMAGE_TEMPLATES } = require('../../i18n/defaults/cmsDefaults');
const { wrap, measure } = require('./ogText');

const design = { colors: { primary: '#F5A623', secondary: '#1F2937', background: '#FAF8F4', textPrimary: '#1C1917', textSecondary: '#57534E' } };

test('the template list matches the one the design settings accept', () => {
    assert.deepEqual([...TEMPLATES], SHARE_IMAGE_TEMPLATES);
    assert.equal(templateOf('nonsense'), 'light');
});

test('colours must be hex: anything else cannot reach the SVG', () => {
    assert.equal(hex('#ABC', '#000000'), '#aabbcc');
    assert.equal(hex('red" onload="x', '#000000'), '#000000');
    assert.equal(hex('url(#x)', '#111111'), '#111111');
    const svg = buildCardSvg({ title: 'T', design: { colors: { primary: '"/><script>alert(1)</script>', background: 'javascript:1' } } });
    assert.ok(!svg.includes('<script'));
    assert.ok(!svg.includes('javascript'));
});

test('the title is outlines, never markup: a hostile title is inert', () => {
    const svg = buildCardSvg({ title: '</svg><script>alert(1)</script> & "quotes"', eyebrow: '<b>x</b>', brand: '<i>b</i>', design });
    assert.ok(!svg.includes('<script') && !svg.includes('<b>') && !svg.includes('<i>'));
    assert.equal((svg.match(/<svg/g) || []).length, 1);
});

test('long titles shrink and then end in an ellipsis; an overlong word is cut, not overflowed', () => {
    const lines = wrap('heading', 'Een extreem lange titel '.repeat(12), 52, 880, 4);
    assert.equal(lines.length, 4);
    assert.ok(lines[3].endsWith('…'));
    for (const l of lines) assert.ok(measure('heading', l, 52) <= 880 + 1);
    const cut = wrap('heading', 'W'.repeat(80), 72, 880, 3);
    for (const l of cut) assert.ok(measure('heading', l, 72) <= 881);
});

test('each template draws; brand uses the primary colour as the background and readable ink', () => {
    assert.match(buildCardSvg({ title: 'Prijzen', design, template: 'brand' }), /<rect width="1200" height="630" fill="#f5a623"\/>/);
    assert.match(buildCardSvg({ title: 'Prijzen', design, template: 'dark' }), /fill="#1f2937"/);
    assert.match(buildCardSvg({ title: 'Prijzen', design, template: 'light' }), /fill="#faf8f4"/);
    assert.ok(!buildCardSvg({ title: 'x', design, motif: false }).includes('<polygon'));
    assert.ok(buildCardSvg({ title: 'x', design, motif: true }).includes('<polygon'));
});

test('renders a 1200x630 PNG, and an equal identity is served from the cache', async () => {
    const sharp = require('sharp');
    const input = { title: 'Vergelijking: Copilot alternatief', eyebrow: 'Vergelijken', brand: 'Voorbeeld', design, template: 'light', motif: true };
    const a = await renderCard('t|1', input);
    const meta = await sharp(a).metadata();
    assert.equal(meta.format, 'png');
    assert.deepEqual([meta.width, meta.height], [1200, 630]);
    assert.equal(await renderCard('t|1', input), a);
});

test('an unreadable logo costs the logo, not the card', async () => {
    const png = await renderCard('t|logo', { title: 'Titel', design, loadLogo: async () => Buffer.from('not an image') });
    assert.ok(png.length > 1000);
});

test('versionOf is the publish time in ms, empty when unpublished', () => {
    assert.equal(versionOf('2026-10-16T10:00:00.000Z'), String(Date.parse('2026-10-16T10:00:00.000Z')));
    assert.equal(versionOf(null), '');
    assert.equal(versionOf('garbage'), '');
});

test('a pathological title is bounded: a 2000-character word and a long URL render fast', async () => {
    const t0 = process.hrtime.bigint();
    const lines = wrap('heading', 'W'.repeat(2000), 84, 880, 3);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `wrap took ${ms} ms`);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].endsWith('…'));
    const t1 = process.hrtime.bigint();
    buildCardSvg({ title: `https://example.test/${'a'.repeat(1500)}`, eyebrow: 'e', brand: 'b', design });
    assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 600);
});

test('a title beyond the character cap ends in an ellipsis, a title within every limit does not', () => {
    const { wrapLines: wl } = require('./ogText');
    assert.equal(wl('heading', 'ab '.repeat(300), 52, 880, 4).truncated, true);
    const short = wl('heading', 'Een korte titel', 84, 880, 3);
    assert.deepEqual(short, { lines: ['Een korte titel'], truncated: false });
});

test('the logo is loaded once per card, inside the render, and never for a cached card', async () => {
    let loads = 0;
    const input = { title: 'Gecached', design, loadLogo: async () => { loads++; return null; } };
    await Promise.all([renderCard('t|lazy', input), renderCard('t|lazy', input)]);
    await renderCard('t|lazy', input);
    assert.equal(loads, 1);
});
