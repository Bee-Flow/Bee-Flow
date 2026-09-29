const test = require('node:test');
const assert = require('node:assert/strict');
const { matchExpectation, formatCallLine, componentsOf } = require('./drive-app-builder');

const DEF = { screens: [{ id: 's1', sections: [{ id: 'sec', children: [{ id: 'a', type: 'stat' }, { id: 'b', type: 'chart' }, { id: 'c', type: 'card', children: [{ id: 'd', type: 'data_grid' }] }] }] }] };
const EVENTS = [
    { event: 'round_start', data: {} },
    { event: 'tool_call', data: { name: 'app_link_datatable', ok: true } },
    { event: 'data_model', data: { tables: [{ id: 't', key: 'facturen', name: 'Facturen', rowCount: 57, linked: { kind: 'nextcloud', mode: 'read' } }] } },
    { event: 'round_start', data: {} },
    { event: 'tool_call', data: { name: 'app_add_components', ok: false, error: 'Unknown parentId', result: '{"_repeated":2}' } },
    { event: 'round_start', data: {} },
    { event: 'tool_call', data: { name: 'app_add_components', ok: true } },
    { event: 'done', data: { finalized: true } },
];

test('matchExpectation passes the Facturen shape and names every miss', () => {
    const expect = { finalized: true, maxFailedCalls: 1, maxRounds: 3, maxRepeated: 2, linkedTable: { key: 'facturen', minRows: 1 }, components: ['stat', 'chart', 'data_grid'], minComponents: 4, screens: 1, noTools: ['app_seed_records'] };
    assert.deepEqual(matchExpectation(DEF, EVENTS, expect), { ok: true, failures: [] });
    const strict = matchExpectation(DEF, EVENTS, { ...expect, maxFailedCalls: 0, maxRounds: 2, maxRepeated: 1, components: ['kanban'], linkedTable: { key: 'orders' }, noTools: ['app_link_datatable'], minComponents: 9 });
    assert.equal(strict.ok, false);
    assert.equal(strict.failures.length, 7);
    assert.match(strict.failures.join('\n'), /failed calls: expected at most 0, got 1/);
    assert.match(strict.failures.join('\n'), /component type kanban: none/);
    assert.match(strict.failures.join('\n'), /linked table .*orders.*: none/);
    assert.match(strict.failures.join('\n'), /app_link_datatable must not succeed/);
    assert.equal(matchExpectation(null, EVENTS, { components: ['stat'] }).failures[0], 'no draft definition was emitted, so components cannot be checked');
    assert.deepEqual(matchExpectation(DEF, EVENTS, null), { ok: true, failures: [] });
});

test('componentsOf walks nested children; formatCallLine reads the repeat counter off the result', () => {
    assert.deepEqual(componentsOf(DEF).map((c) => c.type), ['stat', 'chart', 'card', 'data_grid']);
    assert.equal(formatCallLine(2, { name: 'app_add_components', ok: false, error: 'Unknown parentId "x"', result: '{"_repeated":2}' }), 'r2 app_add_components ERR repeat=2 Unknown parentId "x"');
    assert.equal(formatCallLine(1, { name: 'app_finalize', ok: true }), 'r1 app_finalize ok repeat=1');
});

test('the invoice-tracker expectations: own tables with rows, a minimum of screens, and no form twice on one screen', () => {
    const brief = require('./builder-briefs/invoice-tracker.json');
    const def = {
        meta: { name: 'Invoice tracker', description: '', icon: 'Receipt' },
        screens: [
            { id: 's1', sections: [{ id: 'sec1', children: [{ id: 'f1', type: 'form', props: { name: 'supplier_form' }, children: [{ id: 'i1', type: 'input_text' }] }, { id: 'g1', type: 'data_grid' }] }] },
            { id: 's2', sections: [{ id: 'sec2', children: [{ id: 'f2', type: 'form', props: { name: 'inv_form' }, children: Array.from({ length: 6 }, (_, i) => ({ id: `j${i}`, type: 'input_text' })) }, { id: 'g2', type: 'data_grid' }] }] },
        ],
    };
    const events = [
        // What the route reports on round 0: the brief carries the measured
        // maxPromptChars ceiling (49.0–49.7k with a stub owner context), and a
        // round_start without promptChars would fail it.
        { event: 'round_start', data: { iter: 0, promptChars: 49_700 } },
        { event: 'tool_call', data: { name: 'app_upsert_table', ok: true } },
        { event: 'tool_call', data: { name: 'app_seed_records', ok: true } },
        { event: 'data_model', data: { tables: [{ id: 't1', key: 'suppliers', rowCount: 5 }, { id: 't2', key: 'invoices', rowCount: 8 }] } },
        { event: 'done', data: { finalized: true } },
    ];
    assert.deepEqual(matchExpectation(def, events, brief.expect), { ok: true, failures: [] });
    assert.equal(brief.expect.maxPromptChars, 62000, 'the ceiling the three app briefs share');
    // The measured failure shape: no tables created, the form batch landed twice.
    const twice = JSON.parse(JSON.stringify(def));
    twice.screens[0].sections[0].children.push({ id: 'f1b', type: 'form', props: { name: 'supplier_form' } });
    const bad = matchExpectation(twice, [{ event: 'data_model', data: { tables: [] } }, { event: 'done', data: { finalized: false } }], brief.expect);
    const text = bad.failures.join('\n');
    assert.match(text, /own tables: expected at least 2, got 0/);
    assert.match(text, /duplicate forms on one screen: s1:supplier_form ×2/);
    assert.match(text, /finalized: expected true, got false/);
    const empty = matchExpectation(def, [{ event: 'data_model', data: { tables: [{ id: 't1', key: 'suppliers', rowCount: 0 }, { id: 't2', key: 'invoices', rowCount: 3 }] } }, { event: 'done', data: { finalized: true } }], brief.expect);
    assert.match(empty.failures.join('\n'), /own tables with fewer than 1 rows: suppliers=0/);
    assert.match(matchExpectation({ screens: [def.screens[0]] }, events, brief.expect).failures.join('\n'), /screens: expected at least 2, got 1/);
});

test('playbook judge keys: linkedTable.mode and actionSteps (nested in sequences)', () => {
    const def = { screens: [], actions: { act_1: { kind: 'sequence', steps: [{ kind: 'request_approval', prompt: { kind: 'static', value: 'ok?' } }, { kind: 'refresh' }] }, act_2: { kind: 'toast', message: 'x' } } };
    const events = [{ event: 'data_model', data: { tables: [{ id: 't', key: 'facturen', rowCount: 3, linked: { kind: 'studio', mode: 'readwrite' } }] } }, { event: 'done', data: { finalized: true } }];
    assert.deepEqual(matchExpectation(def, events, { linkedTable: { key: 'facturen', mode: 'readwrite' }, actionSteps: ['request_approval', 'refresh', 'toast'] }), { ok: true, failures: [] });
    const bad = matchExpectation(def, events, { linkedTable: { key: 'facturen', mode: 'read' }, actionSteps: ['navigate'] });
    assert.match(bad.failures.join('\n'), /expected mode read, got readwrite/);
    assert.match(bad.failures.join('\n'), /action step navigate: none in any action \(have sequence, request_approval, refresh, toast\)/);
});

test('expect.name and expect.maxPromptChars: a finished build is named and its first round stayed within the prefix budget', () => {
    const named = { ...DEF, meta: { name: 'Facturen', description: '', icon: 'Receipt' } };
    const events = [
        { event: 'round_start', data: { iter: 0, promptChars: 38_000 } },
        { event: 'round_start', data: { iter: 1, promptChars: 41_000 } },
        { event: 'done', data: { finalized: true } },
    ];
    assert.deepEqual(matchExpectation(named, events, { name: { notUntitled: true, matches: '^factur' }, maxPromptChars: 40_000 }), { ok: true, failures: [] });
    const untitled = matchExpectation({ ...DEF, meta: { name: 'Untitled app' } }, events, { name: { notUntitled: true } });
    assert.match(untitled.failures.join('\n'), /name: expected a real app name, got "Untitled app"/);
    const wrong = matchExpectation(named, events, { name: { matches: '^Orders' }, maxPromptChars: 30_000 });
    assert.match(wrong.failures.join('\n'), /name: expected \/\^Orders\/i, got "Facturen"/);
    assert.match(wrong.failures.join('\n'), /promptChars: expected at most 30000 on round 0, got 38000/);
    assert.match(matchExpectation(null, events, { name: { notUntitled: true } }).failures[0], /no draft definition was emitted, so the app name/);
    assert.match(matchExpectation(named, [{ event: 'done', data: {} }], { maxPromptChars: 1 }).failures[0], /no round_start with promptChars/);
});
