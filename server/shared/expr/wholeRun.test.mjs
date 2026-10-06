/**
 * A whole-run Condition that reads a list (wholeRun.mjs, BFSF-485 F3/F4).
 *
 * Run: node --test shared/expr/wholeRun.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isWholeRunRoute, wholeRunListReads, loopsAfterWholeRun } from './wholeRun.mjs';
import * as index from './index.mjs';

const SHEETS = 'steps.sheets.output.results';
const ISSUE_EXPR = `contains(${SHEETS}[*].name, "Reiskosten")`;

test('the helpers are exported by index.mjs', () => {
    assert.equal(index.wholeRunListReads, wholeRunListReads);
    assert.equal(index.loopsAfterWholeRun, loopsAfterWholeRun);
    assert.equal(index.isWholeRunRoute, isWholeRunRoute);
});

test('isWholeRunRoute: a condition, or a switch without a list', () => {
    assert.equal(isWholeRunRoute({ type: 'condition', expr: 'true' }), true);
    assert.equal(isWholeRunRoute({ type: 'switch', expr: 'x', cases: [] }), true);
    assert.equal(isWholeRunRoute({ type: 'switch', arrayRef: SHEETS, cases: [] }), false);
    assert.equal(isWholeRunRoute({ type: 'filter', arrayRef: SHEETS }), false);
    assert.equal(isWholeRunRoute(null), false);
});

test('wholeRunListReads: the issue example reads the sheets list as a whole', () => {
    assert.deepEqual(wholeRunListReads({ id: 'c', type: 'condition', expr: ISSUE_EXPR }), [
        { list: SHEETS, path: `${SHEETS}[*].name` },
    ]);
});

test('wholeRunListReads: list-mode routes and other steps read nothing', () => {
    assert.deepEqual(wholeRunListReads({ type: 'filter', arrayRef: SHEETS, expr: ISSUE_EXPR }), []);
    assert.deepEqual(wholeRunListReads({ type: 'switch', arrayRef: SHEETS, cases: [{ name: 'a', expr: ISSUE_EXPR }] }), []);
    assert.deepEqual(wholeRunListReads({ type: 'integration_action', expr: ISSUE_EXPR }), []);
});

test('wholeRunListReads: emptiness and truthy checks are skipped', () => {
    const isList = () => true;
    const skipped = [
        `isEmpty(${SHEETS})`,
        `!isEmpty(${SHEETS})`,
        `len(${SHEETS}) > 0`,
        `count(${SHEETS}) == 0`,
        `${SHEETS}`,
        `!${SHEETS}`,
        `${SHEETS} && true`,
        `isEmpty(${SHEETS}[*].name)`,
        `${SHEETS} ? 1 : 0`,
    ];
    for (const expr of skipped) assert.deepEqual(wholeRunListReads({ type: 'condition', expr }, isList), [], expr);
});

test('wholeRunListReads: a list value counts only when isList says so; switch cases are read; bad text reads nothing', () => {
    const isList = (p) => p === SHEETS;
    assert.deepEqual(wholeRunListReads({ type: 'condition', expr: `contains(${SHEETS}, "x")` }), []);
    assert.deepEqual(wholeRunListReads({ type: 'condition', expr: `contains(${SHEETS}, "x")` }, isList), [{ list: SHEETS, path: SHEETS }]);
    assert.deepEqual(wholeRunListReads({ type: 'condition', expr: 'steps.a.output.count > 2' }, isList), []);
    const sw = { type: 'switch', expr: 'steps.a.output.kind', cases: [{ name: 'r', expr: ISSUE_EXPR }, { name: 'r2', expr: ISSUE_EXPR }, null] };
    assert.deepEqual(wholeRunListReads(sw), [{ list: SHEETS, path: `${SHEETS}[*].name` }]);
    assert.deepEqual(wholeRunListReads({ type: 'condition', expr: 'contains((' }), []);
    assert.deepEqual(wholeRunListReads({ type: 'condition' }), []);
    // A rule that asks "is about" still parses.
    assert.deepEqual(wholeRunListReads({ type: 'condition', expr: `isAbout(steps.m.output.body, "a complaint") && ${ISSUE_EXPR}` }), [
        { list: SHEETS, path: `${SHEETS}[*].name` },
    ]);
});

test('wholeRunListReads: isList may return the list; a list of plain values read whole is a membership test', () => {
    const root = {
        trigger: { output: { labels: ['urgent', 'vip', null, 3], none: [] } },
        steps: { sheets: { output: { results: [{ name: 'Reiskosten' }, { name: 'Q3' }] } } },
    };
    const listAt = (p) => {
        let v = root;
        for (const k of p.split('.')) v = v == null ? undefined : v[k];
        return Array.isArray(v) ? v : null;
    };
    const cond = (expr) => wholeRunListReads({ type: 'condition', expr }, listAt);
    // The skeptic's case: labels passed whole to a function is a membership question.
    assert.deepEqual(cond('contains(trigger.output.labels, "urgent")'), []);
    assert.deepEqual(cond('trigger.output.labels == "vip"'), []);
    // A list of records read whole is still a list read.
    assert.deepEqual(cond(`contains(${SHEETS}, "x")`), [{ list: SHEETS, path: SHEETS }]);
    // An empty list cannot be told apart: it still counts, like isList returning true.
    assert.deepEqual(cond('contains(trigger.output.none, "x")'), [{ list: 'trigger.output.none', path: 'trigger.output.none' }]);
    // Not a list (null) reads nothing; a [*] read never asks isList.
    assert.deepEqual(cond('contains(trigger.output.missing, "x")'), []);
    assert.deepEqual(cond(ISSUE_EXPR), [{ list: SHEETS, path: `${SHEETS}[*].name` }]);
    // loopsAfterWholeRun shares the rule.
    const def = {
        steps: [
            { id: 'cond', type: 'condition', expr: 'contains(trigger.output.labels, "urgent")' },
            { id: 'each', type: 'integration_action', forEach: { overRef: 'trigger.output.labels', itemVar: 'l' } },
        ],
        edges: [{ from: 'cond', to: 'each', label: 'true' }],
    };
    assert.deepEqual(loopsAfterWholeRun(def, 'cond', listAt), []);
});

function issueDefinition() {
    return {
        steps: [
            { id: 'sheets', type: 'integration_action', tool: 'gsheets_list' },
            { id: 'cond', type: 'condition', expr: ISSUE_EXPR },
            { id: 'process', type: 'integration_action', forEach: { overRef: SHEETS, itemVar: 'sheet' }, inputs: {} },
            { id: 'loop', type: 'loop', overRef: `${SHEETS}[*].tabs`, itemVar: 'tab', steps: [] },
            { id: 'filt', type: 'filter', arrayRef: SHEETS, expr: 'true' },
            { id: 'mail', type: 'integration_action', inputs: { body: { kind: 'ref', path: SHEETS } } },
            { id: 'err', type: 'integration_action', forEach: { overRef: SHEETS, itemVar: 's' } },
        ],
        edges: [
            { from: 'sheets', to: 'cond' },
            { from: 'cond', to: 'process', label: 'then' },
            { from: 'cond', to: 'loop', label: 'then' },
            { from: 'cond', to: 'filt', label: 'else' },
            { from: 'cond', to: 'mail', label: 'else' },
            { from: 'cond', to: 'err', label: 'on_error' },
        ],
    };
}

test('loopsAfterWholeRun: steps right after that still run once per item of that list', () => {
    assert.deepEqual(loopsAfterWholeRun(issueDefinition(), 'cond'), [
        { stepId: 'process', reads: SHEETS },
        { stepId: 'loop', reads: SHEETS },
        { stepId: 'filt', reads: SHEETS },
    ]);
});

test('loopsAfterWholeRun: nothing for a route without whole-list reads, a list route or an unknown id', () => {
    const def = issueDefinition();
    def.steps[1] = { id: 'cond', type: 'condition', expr: `!isEmpty(${SHEETS})` };
    assert.deepEqual(loopsAfterWholeRun(def, 'cond'), []);
    assert.deepEqual(loopsAfterWholeRun(issueDefinition(), 'filt'), []);
    assert.deepEqual(loopsAfterWholeRun(issueDefinition(), 'nope'), []);
    assert.deepEqual(loopsAfterWholeRun(null, 'cond'), []);
});
