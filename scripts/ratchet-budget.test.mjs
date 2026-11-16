// The budget step of the theme and vendor-name ratchets: a missing budget is
// written from the count, a rise fails, an equal or lower count passes, and
// --update only ever lowers what is recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateBudget } from './ratchet-budget.mjs';

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-budget-'));
    return { root, budgetFile: path.join(root, '.x-ratchet.json') };
}

function run(base, over) {
    const out = [];
    const err = [];
    const code = gateBudget({
        ...base,
        count: 3,
        rows: [[2, 'a.tsx'], [1, 'b.tsx']],
        label: 'agent-hub',
        what: 'things',
        where: 'under src',
        advice: 'fix them',
        command: 'node scripts/x.mjs',
        update: false,
        list: false,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        ...over,
    });
    return { code, out, err };
}

const recorded = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).count;

test('a missing budget is written from the measured count', () => {
    const s = sandbox();
    const r = run(s);
    assert.equal(r.code, 0);
    assert.equal(recorded(s.budgetFile), 3);
    assert.match(r.out.join('\n'), /Budget written to \.x-ratchet\.json: 3 things/);
});

test('a count above the budget fails and names the advice', () => {
    const s = sandbox();
    run(s, { count: 2 });
    const r = run(s, { count: 3 });
    assert.equal(r.code, 1);
    assert.match(r.err[0], /^❌ agent-hub: 3 things under src, budget is 2 — fix them/);
    assert.equal(recorded(s.budgetFile), 2);
});

test('at budget and under budget both pass, with their own verdict', () => {
    const s = sandbox();
    run(s, { count: 3 });
    assert.match(run(s, { count: 3 }).out[0], /^➖ agent-hub: 3 things under src, at budget/);
    const under = run(s, { count: 1 });
    assert.equal(under.code, 0);
    assert.match(under.out[0], /^✅ .*under the budget of 3/);
});

test('--update lowers the budget but never raises it', () => {
    const s = sandbox();
    run(s, { count: 3 });
    run(s, { count: 1, update: true });
    assert.equal(recorded(s.budgetFile), 1);
    run(s, { count: 5, update: true });
    assert.equal(recorded(s.budgetFile), 1);
});

test('--list prints the rows, largest first, and without --update writes nothing new', () => {
    const s = sandbox();
    const r = run(s, { list: true });
    assert.deepEqual(r.out.slice(0, 2), ['    2  a.tsx', '    1  b.tsx']);
    assert.equal(fs.existsSync(s.budgetFile), false);
});
