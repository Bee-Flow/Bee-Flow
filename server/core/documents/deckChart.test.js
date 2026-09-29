/**
 * The visual collectors: every shape a chart's data may arrive in becomes
 * ONE model, numbers are read the way people write them, and a bad cell is a
 * gap rather than a failure.
 *
 * Run: node --test --test-force-exit core/documents/deckChart.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dc = require('./deckChart');

test('parseNumber reads currencies, both thousands conventions, percentages and suffixes', () => {
    assert.strictEqual(dc.parseNumber('€ 1.554,25'), 1554.25);
    assert.strictEqual(dc.parseNumber('1,554.25'), 1554.25);
    assert.strictEqual(dc.parseNumber('12%'), 12);
    assert.strictEqual(dc.parseNumber('1,5'), 1.5);
    assert.strictEqual(dc.parseNumber('1.5'), 1.5);
    assert.strictEqual(dc.parseNumber('2.795'), 2795, 'a lone dot with three digits after it is a thousands separator');
    assert.strictEqual(dc.parseNumber('1,2M'), 1.2e6);
    assert.strictEqual(dc.parseNumber('3k'), 3000);
    assert.strictEqual(dc.parseNumber('-7'), -7);
    assert.strictEqual(dc.parseNumber(42), 42);
    assert.strictEqual(dc.parseNumber('Noord'), null);
    assert.strictEqual(dc.parseNumber(''), null);
    assert.strictEqual(dc.parseNumber('1.2.3'), null);
});

test('rows of objects: the first text column labels, every numeric column is a series', () => {
    const w = [];
    const c = dc.chartFromAny([{ maand: 'jan', omzet: '€ 12', kosten: 3, opmerking: 'x' }, { maand: 'feb', omzet: 15, kosten: '4,5', opmerking: 'y' }], { type: 'line' }, w);
    assert.strictEqual(c.type, 'line');
    assert.deepStrictEqual(c.labels, ['jan', 'feb']);
    assert.deepStrictEqual(c.series.map((s) => s.name), ['omzet', 'kosten']);
    assert.deepStrictEqual(c.series[1].values, [3, 4.5]);
    assert.deepStrictEqual(w, []);
});

test('named columns win; an unknown column is skipped with a warning, never an error', () => {
    const w = [];
    const rows = [{ regio: 'N', stad: 'A', omzet: 1, kosten: 2 }, { regio: 'Z', stad: 'B', omzet: 3, kosten: 4 }];
    const c = dc.chartFromAny({ type: 'bar', data: rows, labels: 'stad', values: 'kosten,nope' }, {}, w);
    assert.deepStrictEqual(c.labels, ['A', 'B']);
    assert.deepStrictEqual(c.series.map((s) => s.name), ['kosten']);
    assert.ok(w.some((x) => /"nope"/.test(x)));
});

test('the ```chart line grammar: settings, a labels line, one series per line', () => {
    const c = dc.chartFromAny('type: area\nunit: %\nstacked: true\nlabels: Q1, Q2, Q3\nOmzet: 10, 20, 30\nKosten: 5; 8; 12', {}, []);
    assert.strictEqual(c.type, 'area');
    assert.strictEqual(c.unit, '%');
    assert.strictEqual(c.stacked, true);
    assert.deepStrictEqual(c.labels, ['Q1', 'Q2', 'Q3']);
    assert.deepStrictEqual(c.series[1].values, [5, 8, 12]);
    // "Label: value" lines without a labels line = one series
    const one = dc.chartFromAny('Noord: 1554\nZuid: € 2.795', { type: 'pie' }, []);
    assert.deepStrictEqual(one.labels, ['Noord', 'Zuid']);
    assert.deepStrictEqual(one.series, [{ name: '', values: [1554, 2795] }]);
});

test('a markdown table, a matrix, a {columns, rows} table and a {labels, series} spec all collect', () => {
    const md = dc.chartFromAny('| Regio | Omzet | Kosten |\n|---|---|---|\n| N | 1 | 2 |\n| Z | 3 | 4 |', {}, []);
    assert.deepStrictEqual(md.labels, ['N', 'Z']);
    assert.strictEqual(md.series.length, 2);
    const matrix = dc.chartFromAny([['Regio', 'Omzet'], ['N', 1], ['Z', 3]], {}, []);
    assert.deepStrictEqual(matrix.series[0].values, [1, 3]);
    const table = dc.chartFromAny({ columns: ['Regio', 'Omzet'], rows: [['N', 1], ['Z', 3]] }, { type: 'donut' }, []);
    assert.strictEqual(table.type, 'donut');
    const spec = dc.chartFromAny({ labels: ['a', 'b'], series: [{ name: 's', values: ['1', 'x'] }] }, {}, []);
    assert.deepStrictEqual(spec.series[0].values, [1, null], 'a bad cell is a gap');
    const json = dc.chartFromAny('[{"m":"a","v":1},{"m":"b","v":2}]', {}, []);
    assert.deepStrictEqual(json.labels, ['a', 'b']);
});

test('caps and refusals: pie keeps one series, series/labels are capped, no numbers = no chart', () => {
    const w = [];
    const pie = dc.chartFromAny({ labels: ['a'], series: [{ name: 'x', values: [1] }, { name: 'y', values: [2] }] }, { type: 'pie' }, w);
    assert.strictEqual(pie.series.length, 1);
    assert.ok(w.some((x) => /one series/.test(x)));
    const many = dc.chartFromAny({ labels: Array.from({ length: 40 }, (_, i) => `l${i}`), series: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, values: Array(40).fill(1) })) }, {}, []);
    assert.strictEqual(many.labels.length, dc.CHART_LIMITS.maxLabels);
    assert.strictEqual(many.series.length, dc.CHART_LIMITS.maxSeries);
    const w2 = [];
    assert.strictEqual(dc.chartFromAny([{ a: 'x' }, { a: 'y' }], {}, w2), null);
    assert.ok(w2.some((x) => /no numbers/.test(x)));
    assert.strictEqual(dc.chartFromAny(null, {}, []), null);
    assert.strictEqual(dc.chartFromAny('', {}, []), null);
    assert.strictEqual(dc.chartType('doughnut'), 'donut');
    assert.strictEqual(dc.chartType('nonsense'), 'column');
});

test('stats: lines, objects, a flat object; capped at four', () => {
    assert.deepStrictEqual(dc.statsFromAny('€ 1,2M | Omzet | +12%\n48 | Klanten | | users'), [
        { value: '€ 1,2M', label: 'Omzet', delta: '+12%', icon: null }, { value: '48', label: 'Klanten', delta: null, icon: 'users' },
    ]);
    assert.deepStrictEqual(dc.statsFromAny([{ value: 3.4, label: 'NPS', trend: 'up', icon: 'star' }]), [{ value: '3.4', label: 'NPS', delta: 'up', icon: 'star' }]);
    assert.deepStrictEqual(dc.statsFromAny({ Omzet: '1M', Klanten: 48 }), [{ value: '1M', label: 'Omzet', delta: null, icon: null }, { value: '48', label: 'Klanten', delta: null, icon: null }]);
    const w = [];
    assert.strictEqual(dc.statsFromAny('1|a\n2|b\n3|c\n4|d\n5|e', w).length, 4);
    assert.ok(w.length === 1);
    assert.deepStrictEqual(dc.statsFromAny(''), []);
});

test('steps: bullets become "Title — text" pairs, sub-bullets fold into the text, capped at six', () => {
    const steps = dc.stepsFromAny([{ text: 'Kick-off — scope', level: 0 }, { text: 'Bouw: sprints', level: 0 }, { text: 'extra', level: 1 }, { text: 'Live', level: 0 }]);
    assert.deepStrictEqual(steps, [{ title: 'Kick-off', text: 'scope' }, { title: 'Bouw', text: 'sprints extra' }, { title: 'Live', text: null }]);
    assert.deepStrictEqual(dc.stepsFromAny([{ title: 'A', description: 'b' }]), [{ title: 'A', text: 'b' }]);
    assert.strictEqual(dc.stepsFromAny('- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 7').length, 6);
    assert.strictEqual(dc.slideStyle('Accent'), 'accent');
    assert.strictEqual(dc.slideStyle('neon'), null);
});
