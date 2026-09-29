/**
 * The SVG chart the PDF deck embeds: every type draws, nothing but the
 * theme's colours and escaped text goes in, and a legend appears only when
 * there is something to tell apart.
 *
 * Run: node --test --test-force-exit core/documents/deckChartSvg.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { chartSvg, _test } = require('./deckChartSvg');
const { chartFromAny } = require('./deckChart');
const { resolveDeckTheme } = require('./deckThemeOptions');

const th = resolveDeckTheme({ enabled: true, accent: '#F5A623', ink: '#1A1A1A' });
const two = chartFromAny({ labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Omzet', values: [10, 20, 30] }, { name: 'Kosten', values: [5, 8, 12] }] }, {}, []);

test('column and bar: one rect per value, category labels, a legend for two series', () => {
    const svg = chartSvg(two, th);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 480"'));
    assert.strictEqual((svg.match(/<path d="M/g) || []).length, 6, 'six capped bars');
    assert.strictEqual((svg.match(/<rect /g) || []).length, 2, 'two legend swatches');
    assert.doesNotMatch(svg, /stroke-dasharray/, 'hairline solid grid');
    assert.ok(svg.includes('>Q2<') && svg.includes('>Omzet<') && svg.includes('>Kosten<'));
    assert.ok(svg.includes(`fill="${th.chartColors[0]}"`) && svg.includes(`fill="${th.chartColors[1]}"`));
    const bar = chartSvg({ ...two, type: 'bar' }, th);
    assert.strictEqual((bar.match(/<path d="M/g) || []).length, 6);
    // One series: no legend
    const one = chartSvg(chartFromAny('a: 1\nb: 2', {}, []), th);
    assert.strictEqual((one.match(/<rect /g) || []).length, 0);
    assert.strictEqual((one.match(/<path d="M/g) || []).length, 2);
    // A stack: the interior segments are plain rects parted by a surface stroke; only the top is capped.
    const stacked = chartSvg({ ...two, stacked: true }, th);
    assert.strictEqual((stacked.match(/<rect [^>]*stroke="#FFFFFF" stroke-width="2"/g) || []).length, 3);
    assert.strictEqual((stacked.match(/<path d="M[^>]*stroke="#FFFFFF"/g) || []).length, 3);
});

test('stacked columns, negatives and the nice scale', () => {
    const neg = chartFromAny({ labels: ['a', 'b'], series: [{ name: 'x', values: [-5, 12] }, { name: 'y', values: [3, -2] }] }, { stacked: true }, []);
    const svg = chartSvg(neg, th);
    assert.ok(svg.includes('>-5<') || svg.includes('>-10<'), 'a negative tick is drawn');
    const scale = _test.niceScale(0, 37);
    assert.strictEqual(scale.max, 40);
    assert.deepStrictEqual(scale.ticks, [0, 10, 20, 30, 40]);
    assert.strictEqual(_test.fmt(1554.25), '1554.3');
    assert.strictEqual(_test.fmt(2500000), '2.5M');
    assert.strictEqual(_test.fmt(12, '%'), '12%');
});

test('line and area: a path per series, points, an area fill', () => {
    const line = chartSvg({ ...two, type: 'line' }, th);
    assert.strictEqual((line.match(/<path d="M/g) || []).length, 2);
    assert.strictEqual((line.match(/<circle /g) || []).length, 6);
    const area = chartSvg({ ...two, type: 'area' }, th);
    assert.ok(area.includes('fill-opacity="0.16"'), 'an unstacked area is a wash');
    assert.match(line, /<circle [^>]*r="4" fill="#[0-9A-F]{6}" stroke="#FFFFFF" stroke-width="2"/, 'markers carry a surface ring');
    // Many points: values only at the endpoints
    const busy = chartSvg(chartFromAny({ labels: Array.from({ length: 10 }, (_, i) => `d${i}`), series: [{ name: 'a', values: Array(10).fill(33) }, { name: 'b', values: Array(10).fill(44) }] }, { type: 'line' }, []), th);
    assert.strictEqual((busy.match(/>33</g) || []).length, 1, 'ten points: only the endpoint is labelled');
});

test('pie and donut: one path per non-zero slice, percentages readable on their slice, labels listed', () => {
    const pie = chartSvg(chartFromAny('A: 40\nB: 35\nC: 25\nD: 0', { type: 'pie' }, []), th);
    assert.strictEqual((pie.match(/<path d="M/g) || []).length, 3);
    assert.ok(pie.includes('>40%<') && /<text[^>]*>A <tspan/.test(pie), 'the label list names each slice with its value');
    const donut = chartSvg(chartFromAny('A: 70\nB: 30', { type: 'donut' }, []), th);
    assert.ok(/A[\d.]+ [\d.]+ 0 [01] 0 /.test(donut), 'a donut slice has an inner arc');
    const empty = chartSvg({ type: 'pie', labels: ['a'], series: [{ name: '', values: [0] }] }, th);
    assert.ok(empty.includes('—'));
});

test('text is escaped and nothing external or scripted can get in', () => {
    const c = chartFromAny({ labels: ['<script>alert(1)</script>', 'b & c'], series: [{ name: '"x"', values: [1, 2] }, { name: 'y', values: [1, 1] }] }, { title: 'T<' }, []);
    const svg = chartSvg(c, th);
    assert.ok(!svg.includes('<script'));
    assert.ok(svg.includes('&lt;script&gt;') && svg.includes('b &amp; c') && svg.includes('&quot;x&quot;') && svg.includes('T&lt;'));
    assert.ok(!/href=|url\(/.test(svg));
    assert.strictEqual(chartSvg(null, th), '');
});
