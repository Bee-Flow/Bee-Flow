// @typecheck
'use strict';

/**
 * Characterisation (golden) test for applyChainStep: for each scenario what
 * it returns (the flat rows, or in trace mode the rows per grain and the
 * grain index of every flat row), the tool calls it made with their bound
 * arguments, what is left of the call budget, and the error it throws.
 *
 * Scenarios reach each branch: a step without a tool, argument binding
 * (paths, absent values, objects, pinned arguments), rows that are not
 * objects, rows carried with an earlier error, the budget running out, a
 * failing call (recorded on the row) and a missing connection (thrown), the
 * three ways a result is folded (extend with key collisions, nest, a result
 * that is not an object), expand (from the result or the row, an empty list,
 * elements that are not objects, fields about the parent, collisions), a
 * result kept as a table of its own, the row cap, and all of those again in
 * trace mode with and without incoming grain rows.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test appStudio/connectors/chain.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { applyChainStep } = require('./chain');
const { MAX_CONNECTOR_ROWS } = require('./shared');

const GOLDEN = path.join(__dirname, 'chain.characterisation.golden.json');

const ROWS = [
    { id: 'm1', subject: 'One', from: { address: 'a@example.test' }, attachments: [{ id: 'r1', name: 'row.pdf' }] },
    { id: 'm2', subject: 'Two', from: { address: 'b@example.test' } },
    { id: 'm3', subject: 'Three', threadId: null },
];
/** What the tool answers per message id. */
const ANSWERS = {
    m1: { id: 'full-m1', body: 'Hello', attachments: [{ id: 'a1', name: 'x.pdf', subject: 'att' }, { id: 'a2', name: 'y.pdf' }] },
    m2: { id: 'full-m2', body: 'World', attachments: [] },
    m3: { id: 'full-m3', body: 'Third', attachments: ['plain.txt', null, { id: 'a3' }] },
};
const READ = { tool: 'gmail_read', argsFrom: { messageId: 'id' } };

/**
 * name → { step, rows?, budget?, opts?, answers?, fails? }. `answers` maps a
 * message id to what the tool returns; `fails` to the error it throws.
 * @type {Record<string, { step: any, rows?: any, budget?: number, opts?: Record<string, any>, answers?: Record<string, any>, fails?: Record<string, any> }>}
 */
const BASE = {
    // the step itself
    noTool: { step: {} },
    toolNotAString: { step: { tool: 7 } },
    noRows: { step: READ, rows: [] },
    // binding
    bindsFromPaths: { step: { tool: 'crm_lookup', argsFrom: { messageId: 'id', sender: 'from.address', missing: 'nope.deep', thread: 'threadId', whole: 'from', list: 'attachments[]' } } },
    pinnedArgsWin: { step: { tool: 'gmail_read', argsFrom: { messageId: 'id', format: 'subject' }, fixedArgs: { format: 'full', extra: 1 } } },
    argsFromNotAnObject: { step: { tool: 'gmail_read', argsFrom: ['id'], fixedArgs: 'x' } },
    // rows that are not called
    rowsThatAreNotObjects: { step: READ, rows: [null, 'text', 5, ['a'], ROWS[0]] },
    carriedError: { step: READ, rows: [{ id: 'm1', _error: 'earlier step failed' }, ROWS[1]] },
    budgetRunsOut: { step: READ, budget: 2 },
    budgetEmpty: { step: READ, budget: 0 },
    budgetSkipsCarriedRows: { step: READ, budget: 1, rows: [{ id: 'm1', _error: 'x' }, null, ROWS[1], ROWS[2]] },
    carriedRowAfterTheBudgetRanOut: { step: READ, budget: 1, rows: [ROWS[0], { id: 'm9', _error: 'earlier' }, ROWS[1]] },
    // failures
    callFails: { step: READ, fails: { m2: new Error('Message not found') } },
    callFailsLongMessage: { step: READ, fails: { m1: new Error('x'.repeat(400)) } },
    callAnswersAnError: { step: READ, answers: { ...ANSWERS, m2: { error: 'quota exceeded' } } },
    connectionMissing: { step: READ, fails: { m2: Object.assign(new Error('connect first'), { status: 409, code: 'connection_required' }) } },
    callFailsClassified: { step: READ, fails: { m1: Object.assign(new Error('teapot'), { status: 418, code: 'other' }) } },
    // folding
    extend: { step: READ },
    extendNoAlias: { step: { tool: 'lookup', argsFrom: { messageId: 'id' } } },
    nest: { step: { ...READ, merge: 'nest' } },
    nestWithAlias: { step: { ...READ, merge: 'nest', alias: 'message' } },
    resultNotAnObject: { step: READ, answers: { m1: 'plain text', m2: null, m3: [1, 2] } },
    resultNothing: { step: READ, answers: {} },
    nestResultNothing: { step: { ...READ, merge: 'nest' }, answers: {} },
    resultKeysAnObjectInherits: { step: READ, answers: { m1: { toString: 'own text', constructor: 'own', id: 'x' }, m2: {}, m3: {} } },
    aliasEmptyFallsBackToTool: { step: { ...READ, alias: '' }, answers: { m1: 7, m2: 8, m3: 9 } },
    // expand
    expand: { step: { ...READ, expand: 'attachments' } },
    expandFromTheRow: { step: { ...READ, expand: 'attachments' }, answers: { m1: { body: 'only a body' }, m2: 'text', m3: null } },
    expandNotAList: { step: { ...READ, expand: 'body' } },
    expandNested: { step: { ...READ, expand: 'payload.parts' }, answers: { m1: { payload: { parts: [{ id: 'p1' }] } }, m2: { payload: {} }, m3: { payload: { parts: [] } } } },
    expandWithNest: { step: { ...READ, expand: 'attachments', merge: 'nest', alias: 'att' } },
    expandOnlyTheList: { step: { ...READ, expand: 'attachments' }, answers: { m1: { attachments: [{ id: 'a1' }] }, m2: { attachments: [{ subject: 'collides' }] }, m3: { attachments: [] } } },
    // a table of its own
    ownTable: { step: { ...READ, ownTable: true } },
    ownTableResultNotAnObject: { step: { ...READ, ownTable: true }, answers: { m1: 'text', m2: null, m3: { id: 'x' } } },
    ownTableLosesToExpand: { step: { ...READ, ownTable: true, expand: 'attachments' } },
    ownTableWithAnExpandThatIsNotAList: { step: { ...READ, ownTable: true, expand: 'body' } },
    ownTableTruthyOnly: { step: { ...READ, ownTable: 'yes' } },
    // mixed outcomes
    mixed: { step: { ...READ, expand: 'attachments' }, budget: 3, rows: [{ id: 'm0', _error: 'earlier' }, ROWS[0], ROWS[1], ROWS[2], { id: 'm4' }], fails: { m2: new Error('gone') } },
    mixedOwnTable: { step: { ...READ, ownTable: true }, budget: 3, rows: [{ id: 'm0', _error: 'earlier' }, ROWS[0], ROWS[1], ROWS[2], { id: 'm4' }], fails: { m2: new Error('gone') } },
    mixedEnrich: { step: READ, budget: 3, rows: [{ id: 'm0', _error: 'earlier' }, 'text', ROWS[0], ROWS[1], ROWS[2], { id: 'm4' }], fails: { m2: new Error('gone') } },
    // the row cap
    rowCapOnExpand: { step: { tool: 'big_list', argsFrom: { messageId: 'id' }, expand: 'items' }, rows: [{ id: 'big' }, { id: 'm1' }], budget: 5, answers: { big: { items: Array.from({ length: MAX_CONNECTOR_ROWS + 5 }, (_, i) => ({ n: i })) }, m1: { items: [{ n: -1 }] } } },
    rowCapOnRows: { step: { tool: 'echo_row', argsFrom: { messageId: 'id' } }, rows: Array.from({ length: MAX_CONNECTOR_ROWS + 3 }, (_, i) => ({ id: `r${i}` })), budget: MAX_CONNECTOR_ROWS + 10, answers: {} },
    rowCapReachedByASkippedRow: { step: { tool: 'echo_row', argsFrom: { messageId: 'id' } }, rows: Array.from({ length: MAX_CONNECTOR_ROWS + 3 }, (_, i) => ({ id: `r${i}` })), budget: MAX_CONNECTOR_ROWS - 1, answers: {} },
};

// Every scenario again in trace mode, and the ones with child grains once more over incoming grain rows.
const GRAIN_ROWS = [{ id: 'g-m1', subject: 'Grain one' }, { id: 'g-m2' }, { id: 'g-m3' }];
/** @type {typeof BASE} */
const CASES = { ...BASE };
for (const [name, c] of Object.entries(BASE)) CASES[`${name}/trace`] = { ...c, opts: { trace: true } };
for (const name of ['extend', 'nest', 'expand', 'expandFromTheRow', 'ownTable', 'callFails', 'budgetRunsOut', 'resultNotAnObject']) {
    CASES[`${name}/grains`] = { ...BASE[name], opts: { trace: true, grainRows: GRAIN_ROWS, rowGrainIndex: [0, 1, 2] } };
    CASES[`${name}/grainsShifted`] = { ...BASE[name], opts: { trace: true, grainRows: GRAIN_ROWS, rowGrainIndex: [2, -1] } };
    CASES[`${name}/grainsNoIndex`] = { ...BASE[name], opts: { trace: true, grainRows: GRAIN_ROWS.slice(0, 2) } };
}
CASES['expand/grainsWithoutTrace'] = { ...BASE.expand, opts: { grainRows: GRAIN_ROWS, rowGrainIndex: [0, 1, 2] } };

/** A long list as its length, first and last element, so the golden stays readable. @param {unknown} value */
const compact = (value) => JSON.parse(JSON.stringify(value === undefined ? '<undefined>' : value, (_k, v) => {
    if (v === undefined) return '<undefined>';
    if (Array.isArray(v) && v.length > 40) return { '<list>': v.length, first: v[0], last: v[v.length - 1] };
    if (typeof v === 'string' && v.length > 250) return `<${v.length} chars>`;
    return v;
}));

/** @param {string} name */
async function runCase(name) {
    const c = CASES[name];
    /** @type {unknown[]} */
    const calls = [];
    const answers = c.answers || ANSWERS;
    const deps = {
        executeTool: async (/** @type {string} */ tool, /** @type {Record<string, any>} */ args, /** @type {Record<string, any>} */ ctx) => {
            calls.push({ tool, args, as: ctx.userId, org: ctx.orgId });
            const id = args.messageId;
            if (c.fails && id in c.fails) throw c.fails[id];
            return answers[id];
        },
    };
    const budget = { remaining: c.budget ?? 50 };
    const rows = structuredClone(c.rows ?? ROWS);
    const before = JSON.stringify(rows);
    /** @type {Record<string, unknown>} */
    let outcome;
    try {
        const result = await applyChainStep(c.step, rows, budget, { userId: 'owner-1', session: {}, orgId: 'org-1' }, deps, { id: 'app-1', name: 'App' }, { id: 'conn-1' }, c.opts);
        // A grain list is a list: a key that is not an index would be a write outside it.
        const strayKeys = Array.isArray(result) || !result.parentRows ? [] : Object.keys(result.parentRows).filter((k) => !/^\d+$/.test(k));
        outcome = { result: compact(result), sameRows: result === rows, ...(strayKeys.length ? { strayKeys } : {}) };
    } catch (err) {
        const e = /** @type {any} */ (err);
        outcome = { threw: { message: e.message, status: e.status, code: e.code } };
    }
    return { ...outcome, calls: compact(calls), budgetLeft: budget.remaining, rowsUntouched: JSON.stringify(rows) === before };
}

test('applyChainStep: rows, grains, tool calls and budget per scenario match the golden file', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const name of Object.keys(CASES)) actual[name] = await runCase(name);
    const text = `${JSON.stringify(actual, null, 1)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, text);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const name of Object.keys(CASES)) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(actual[name])), golden[name], `scenario ${name}`);
    }
    assert.deepStrictEqual(Object.keys(golden), Object.keys(CASES));
});
