// @typecheck
/**
 * Characterisation (golden) test for the sheet assistant's tool executor: one
 * scripted model run over a two-tab workbook calls every tool through every
 * branch that changes its answer (unknown tab, other tab, bad range, too many
 * cells, empty input, the caps, the active-sheet rule, each pivot refusal and
 * the three aggregations), then a viewer's run. The golden holds every tool
 * answer in order and the run's result (changes, charts with their id
 * normalised, reply).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/documents/sheetAssist/sheetAssistant.executeTool.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeSheetAssistant } = require('./sheetAssistant');
const { evaluateSheet } = require('../../../shared/expr/sheet.mjs');

const GOLDEN = path.join(__dirname, 'sheetAssistant.executeTool.characterisation.golden.json');

const SALES = {
    A1: 'Product', B1: 'Region', C1: 'Sales', D1: 'Label',
    A2: 'Apple', B2: 'North', C2: '10', D2: '=A2&"!"',
    A3: 'Banana', B3: 'North', C3: '20', D3: '=UPPER(B3)',
    A4: 'Apple', B4: 'South', C4: 'n/a',
    A5: '', B5: 'East', C5: '5',
    A6: 'Cherry', B6: 'West', C6: '=C2+C3',
    A7: 'Apple', B7: 'North', C7: '25',
    ...Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`H${i + 1}`, `needle ${i}`])),
};
const TABS = [{ id: 't1', name: 'Sales', datatableId: 'dt1' }, { id: 't2', name: 'Targets', datatableId: 'dt2' }];
const DATA = { dt1: SALES, dt2: { A1: '40', A2: 'Goal' } };
const LONG = 'x'.repeat(10_001);

/** @type {Array<[string, any]>} */
const CALLS = [
    ['no_such_tool', {}],
    ['read_range', { range: 'A1:D3' }],
    ['read_range', { range: 'A1', sheet: 'Nope' }],
    ['read_range', { range: 'not a range' }],
    ['read_range', { range: 'A1:Z100' }],
    ['read_range', { range: 'A1:A2', sheet: 'Targets' }],
    ['read_range', { range: 'A1', sheet: 't2' }],
    ['find', { text: 'apple' }],
    ['find', { text: 'BANANA!' }],
    ['find', { text: 'NORTH' }],
    ['find', { text: '' }],
    ['find', { text: 'zzz' }],
    ['find', { text: 'needle' }],
    ['find', { text: 'goal', sheet: 'Targets' }],
    ['find', { text: 'x', sheet: 'Nope' }],
    ['evaluate', { formulas: ['SUM(C2:C3)', '=COUNTA(A1:A7)', null] }],
    ['evaluate', { formulas: Array.from({ length: 22 }, (_, i) => `=${i}`) }],
    ['evaluate', { formulas: '=1' }],
    ['evaluate', { formulas: ['=A1*2'], sheet: 'Targets' }],
    ['evaluate', { formulas: ['=1'], sheet: 'Nope' }],
    ['set_cells', { cells: { E1: 'Total', E2: '=C2*2', E3: null } }],
    ['set_cells', { cells: ['A1'] }],
    ['set_cells', { cells: 'A1' }],
    ['set_cells', { cells: { 'A1:B2': 'x' } }],
    ['set_cells', { cells: { ZZ9: 'x' } }],
    ['set_cells', { cells: { F1: LONG } }],
    ['set_cells', { cells: { F1: '=1/0' } }],
    ['set_cells', { cells: { F2: '42' } }],
    ['set_cells', { cells: { A1: 'x' }, sheet: 'Targets' }],
    ['set_cells', { cells: { A1: 'x' }, sheet: 'Nope' }],
    ['set_cells', { cells: { A1: 'Product' }, sheet: 'Sales' }],
    ['fill_formula', { range: 'G2:G4', formula: '=C2+1' }],
    ['fill_formula', { range: 'bad', formula: '=1' }],
    ['fill_formula', { range: 'G2:G3', formula: '=1', sheet: 'Targets' }],
    ['fill_formula', { range: 'G2:G3', formula: '=1', sheet: 'Nope' }],
    ['clear_range', { range: 'F1:F2' }],
    ['clear_range', { range: 'bad' }],
    ['clear_range', { range: 'A1', sheet: 't2' }],
    ['clear_range', { range: 'A1', sheet: 'Nope' }],
    ['add_chart', { type: 'bar', dataRange: 'C2:C3', categoriesRange: 'A2:A3', anchor: 'J2', title: 'Sales' }],
    ['add_chart', { type: 'nope', dataRange: 'C2:C3', anchor: 'J2' }],
    ['add_chart', undefined],
    ['create_pivot', { sourceRange: 'bad', rowField: 'Product', valuesField: 'Sales', aggregation: 'SUM', targetCell: 'L2' }],
    ['create_pivot', { sourceRange: 'A1:C7', rowField: 'Product', valuesField: 'Sales', aggregation: 'SUM', targetCell: 'L2:M3' }],
    ['create_pivot', { sourceRange: 'A1:C7', rowField: 'Product', valuesField: 'Sales', aggregation: 'MEDIAN', targetCell: 'L2' }],
    ['create_pivot', { sourceRange: 'A1:C7', rowField: 'Nope', valuesField: 'Sales', aggregation: 'SUM', targetCell: 'L2' }],
    ['create_pivot', { sourceRange: 'A1:C7', rowField: 'Product', valuesField: 'Nope', aggregation: 'SUM', targetCell: 'L2' }],
    ['create_pivot', { sourceRange: 'A1:C1', rowField: 'Product', valuesField: 'Sales', aggregation: 'SUM', targetCell: 'L2' }],
    ['create_pivot', { sourceRange: 'A1:C7', rowField: ' product ', valuesField: 'SALES', aggregation: 'SUM', targetCell: 'L2' }],
    ['create_pivot', { sourceRange: 'A1:C7', rowField: 'Region', valuesField: 'Sales', aggregation: 'count', targetCell: 'L10' }],
    ['create_pivot', { sourceRange: 'A1:D7', rowField: 'Label', valuesField: 'Sales', targetCell: 'L20' }],
    ['create_pivot', { sourceRange: 'A1:C7', rowField: 'Product', valuesField: 'Sales', aggregation: 'Average', targetCell: 'L30' }],
    ['create_pivot', { sourceRange: 'A1:C7', rowField: 'Product', valuesField: 'Sales', aggregation: 'SUM', targetCell: 'L40', sheet: 'Targets' }],
];
const VIEWER_CALLS = /** @type {Array<[string, any]>} */ ([
    ['set_cells', { cells: { A1: 'x' } }],
    ['add_chart', { type: 'bar', dataRange: 'C2:C3', anchor: 'J2' }],
    ['read_range', { range: 'A1' }],
    ['find', { text: 'apple' }],
    ['evaluate', { formulas: ['=1+1'] }],
]);

/**
 * One run of the assistant over the two-tab workbook, calling `calls` in order.
 * @param {Array<[string, any]>} calls
 * @param {Record<string, unknown>} [docExtra]
 */
async function runCalls(calls, docExtra = {}) {
    /** @type {string[]} */
    const answers = [];
    const assistant = makeSheetAssistant({
        cells: {
            async readSheet(/** @type {string} */ _owner, /** @type {'dt1' | 'dt2'} */ table) { return { cells: { ...DATA[table] } }; },
            async writeCells(/** @type {string} */ _owner, /** @type {string} */ _table, /** @type {any} */ cells) { return { cells }; },
        },
        evaluate: evaluateSheet,
        resolveModel: async () => ({ modelId: 'm1', options: {}, tier: 'fast' }),
        privacy: async ({ text }) => ({ action: 'allow', text, tokenMap: null }),
        logUsage: async () => {},
        llm: {
            async runToolLoop(/** @type {string} */ _m, /** @type {any} */ _msgs, /** @type {any} */ _tools, /** @type {any} */ _o, /** @type {(n: string, a: any) => Promise<string>} */ executeTool) {
                for (const [name, args] of calls) answers.push(await executeTool(name, args));
                return { content: 'Done.', toolCallRounds: 1, usage: {} };
            },
        },
    });
    const doc = { id: 'd1', userId: 'owner', name: 'Shop', docType: 'spreadsheet', settings: { sheet: { tabs: TABS } }, ...docExtra };
    const out = await assistant.ask(doc, { message: 'Go', userId: 'u1', orgId: null, tabId: 't1' });
    const charts = out.charts.map((/** @type {any} */ c) => ({ ...c, id: /^chart-\d+-[0-9a-z]+$/.test(c.id) ? 'chart-<id>' : c.id }));
    return { answers: Object.fromEntries(answers.map((a, i) => [`${i}:${calls[i][0]}`, a])), result: { ...out, charts } };
}

test('executeTool: every tool answer and the run result match the golden', async () => {
    const actual = { editor: await runCalls(CALLS), viewer: await runCalls(VIEWER_CALLS, { projectRole: 'viewer' }) };
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(actual.viewer, golden.viewer);
    assert.deepEqual(Object.keys(actual.editor.answers), Object.keys(golden.editor.answers));
    for (const k of Object.keys(golden.editor.answers)) assert.equal(actual.editor.answers[k], golden.editor.answers[k], k);
    assert.deepEqual(actual.editor.result, golden.editor.result);
});
