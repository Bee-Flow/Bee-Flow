/**
 * Unit tests for the pure part of drive-builder.js: matchExpectation, which
 * judges a finished build's definition + SSE transcript against a brief's
 * `expect`, and formatCallLine, the --print-calls row. No container, no
 * model: the script lazy-requires jsonwebtoken and the config store inside
 * main() and guards execution with require.main === module.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { matchExpectation, formatCallLine, resolveExpectedPath } = require('./drive-builder');
const brief = require('./builder-briefs/invoices-facturen.json');

// Ids in the shape draftGraph.newId() mints (prefix + 6 hex).
const IDS = { list: 'a_1f3c9e', read: 'a_7b2d41', extract: 'ex_c05a1b', add: 'dt_9e4f27' };
const FIELD_NAMES = ['datum', 'leverancier', 'factuurnummer', 'excl_btw', 'btw', 'totaal'];

/** A definition that answers the invoices brief the way the expectation describes. */
function passingDef() {
    const values = {};
    for (const f of FIELD_NAMES) values[f] = { kind: 'ref', path: `loop.row.output.${f}` };
    return {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [
            { id: IDS.list, type: 'integration_action', tool: 'nextcloud_list_files', label: 'Scan map', sideEffect: false,
                inputs: { path: { kind: 'literal', value: '/Invoices-Test' } } },
            { id: IDS.read, type: 'integration_action', tool: 'nextcloud_read_file', label: 'Lees factuur', sideEffect: false,
                forEach: { overRef: `steps.${IDS.list}.output.items`, itemVar: 'f' },
                inputs: { path: { kind: 'ref', path: 'loop.f.path' } } },
            { id: IDS.extract, type: 'data_extraction', label: 'Extract data',
                forEach: { overRef: `steps.${IDS.read}.output.results`, itemVar: 'doc' },
                source: { kind: 'ref', path: 'loop.doc.output.content' },
                fields: FIELD_NAMES.map((name) => ({ name, type: name === 'datum' ? 'date' : (['excl_btw', 'btw', 'totaal'].includes(name) ? 'number' : 'string'), description: '', required: false })) },
            { id: IDS.add, type: 'datatable', label: 'Rij toevoegen', op: 'add_row', datatableId: 'tbl_ac8bd9ea1182',
                forEach: { overRef: `steps.${IDS.extract}.output.results`, itemVar: 'row' },
                where: {}, values },
        ],
        edges: [
            { from: 'trg', to: IDS.list },
            { from: IDS.list, to: IDS.read },
            { from: IDS.read, to: IDS.extract },
            { from: IDS.extract, to: IDS.add },
        ],
    };
}

function okCall(name) { return { event: 'tool_call', data: { name, arguments: {}, result: { added: { id: 'x' } } } }; }
function errCall(name, error) { return { event: 'tool_call', data: { name, arguments: {}, result: { error, _fixHint: 'Reject reason: test' } } } }

/** A transcript of a clean three-round build. */
function passingEvents({ iterations = 3, finalized = true } = {}) {
    return [
        { event: 'round_start', data: { iter: 1 } },
        okCall('builder_propose_trigger'), okCall('builder_inspect'),
        { event: 'usage', data: { iter: 1 } },
        { event: 'round_start', data: { iter: 2 } },
        okCall('builder_add_steps'), { event: 'draft', data: { definition: passingDef(), automationId: 'auto_1' } },
        { event: 'usage', data: { iter: 2 } },
        { event: 'round_start', data: { iter: 3 } },
        okCall('builder_finalize'), { event: 'finalized', data: { automationId: 'auto_1' } },
        // A passing build is a NAMED build (the briefs expect `titled`): the
        // route sends `metadata` after builder_set_metadata or its own fallback.
        { event: 'metadata', data: { automationId: 'auto_1', title: 'Facturen inlezen', description: '' } },
        { event: 'usage', data: { iter: 3 } },
        { event: 'done', data: { automationId: 'auto_1', finalized, iterations, usage: {} } },
    ];
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

test('requiring the driver does not run main or reach for /app', () => {
    const loaded = Object.keys(require.cache).filter((k) => k.includes('jsonwebtoken') || k.endsWith(path.join('stores', 'configStore.js')));
    assert.deepStrictEqual(loaded, []);
});

test('a chain that answers the brief passes the brief\'s own expectation', () => {
    const verdict = matchExpectation(passingDef(), passingEvents(), brief.expect);
    assert.deepStrictEqual(verdict, { ok: true, failures: [] });
});

test('no expectation is a pass, and a missing definition is a failure', () => {
    assert.deepStrictEqual(matchExpectation(passingDef(), passingEvents(), null), { ok: true, failures: [] });
    const verdict = matchExpectation(null, passingEvents(), brief.expect);
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.failures.some((f) => /no draft definition/.test(f)), verdict.failures.join('\n'));
});

test('the wrong datatable id is a mismatch that names both ids', () => {
    const def = passingDef();
    def.steps[3].datatableId = 'tbl_000000000000';
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.failures.length, 1);
    assert.match(verdict.failures[0], /chain\[3\] \(dt_9e4f27\) datatableId: expected "tbl_ac8bd9ea1182", got "tbl_000000000000"/);
});

test('a missing forEach on a looped step is reported as missing, not as a wrong path', () => {
    const def = passingDef();
    delete def.steps[1].forEach;
    def.steps[1].inputs.path = { kind: 'literal', value: '/Invoices-Test/a.pdf' };
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.failures.some((f) => /chain\[1\] \(a_7b2d41\) forEach: expected over steps\.a_1f3c9e\.output\.items, got none/.test(f)), verdict.failures.join('\n'));
    // The item binding cannot be judged without an itemVar — said so, not guessed.
    assert.ok(verdict.failures.some((f) => /inputs\.path: .*\$item.*no forEach/.test(f)), verdict.failures.join('\n'));
});

test('a forEach over the wrong step is a mismatch', () => {
    const def = passingDef();
    def.steps[3].forEach.overRef = `steps.${IDS.read}.output.results`;
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.strictEqual(verdict.ok, false);
    assert.deepStrictEqual(verdict.failures, [
        `chain[3] (dt_9e4f27) forEach: expected over steps.${IDS.extract}.output.results, got steps.${IDS.read}.output.results`,
    ]);
});

test('a branching graph fails the chain walk instead of picking a branch', () => {
    const def = passingDef();
    def.steps.push({ id: 'ai_55aa01', type: 'ai_step', prompt: 'x', inputs: {} });
    def.edges.push({ from: IDS.list, to: 'ai_55aa01' });
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.failures.some((f) => /branching at a_1f3c9e: edges to a_7b2d41, ai_55aa01/.test(f)), verdict.failures.join('\n'));
    // The walk stopped at the fork, so the chain is short — reported too.
    assert.ok(verdict.failures.some((f) => /chain length: expected 4/.test(f)), verdict.failures.join('\n'));
});

test('$item resolves to each step\'s OWN itemVar, so a binding to another loop\'s var fails', () => {
    const def = passingDef();
    // The read step iterates as `f`, but binds from `item` — a var no loop defines here.
    def.steps[1].inputs.path = { kind: 'ref', path: 'loop.item.path' };
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.deepStrictEqual(verdict.failures, [
        'chain[1] (a_7b2d41) inputs.path: expected ref loop.f.path, got ref loop.item.path',
    ]);

    // Renaming the var consistently is fine: the expectation names $item, not "f".
    const renamed = passingDef();
    renamed.steps[1].forEach.itemVar = 'bestand';
    renamed.steps[1].inputs.path = { kind: 'ref', path: 'loop.bestand.path' };
    assert.deepStrictEqual(matchExpectation(renamed, passingEvents(), brief.expect), { ok: true, failures: [] });
});

test('$k resolves to the id of chain step k', () => {
    assert.strictEqual(resolveExpectedPath('$0.output.items', ['a_1', 'a_2'], null), 'steps.a_1.output.items');
    assert.strictEqual(resolveExpectedPath('steps.$1.output.results', ['a_1', 'a_2'], null), 'steps.a_2.output.results');
    assert.strictEqual(resolveExpectedPath('loop.$item.path', ['a_1'], 'f'), 'loop.f.path');
    assert.throws(() => resolveExpectedPath('loop.$item.path', ['a_1'], null), /\$item.*no forEach/);
    assert.throws(() => resolveExpectedPath('$5.output.x', ['a_1'], null), /\$5/);
});

test('a literal where a ref was expected, and a ref where a literal was expected, both mismatch', () => {
    const def = passingDef();
    def.steps[0].inputs.path = { kind: 'ref', path: 'trigger.output.path' };
    def.steps[2].source = { kind: 'literal', value: 'content' };
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.deepStrictEqual(verdict.failures, [
        'chain[0] (a_1f3c9e) inputs.path: expected literal "/Invoices-Test", got ref trigger.output.path',
        'chain[2] (ex_c05a1b) source: expected ref loop.doc.output.content, got literal "content"',
    ]);
});

test('field names and values keys are compared as sets, order-free, with missing and extra named', () => {
    const def = passingDef();
    def.steps[2].fields = def.steps[2].fields.filter((f) => f.name !== 'btw').reverse();
    def.steps[3].values.kvk = { kind: 'literal', value: 'x' };
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.deepStrictEqual(verdict.failures, [
        'chain[2] (ex_c05a1b) fields: missing btw',
        'chain[3] (dt_9e4f27) values keys: extra kvk',
    ]);
});

test('type, tool and op mismatches are reported per row', () => {
    const def = passingDef();
    def.steps[1].tool = 'nextcloud_download_file';
    def.steps[3].op = 'save_row';
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.deepStrictEqual(verdict.failures, [
        'chain[1] (a_7b2d41) tool: expected "nextcloud_read_file", got "nextcloud_download_file"',
        'chain[3] (dt_9e4f27) op: expected "add_row", got "save_row"',
    ]);
});

test('the status filter the prompt mandates between fan-outs is collapsed; any other filter is a real extra step', () => {
    // builderPrompt.js directs `filter item.status === 'success'` after a
    // forEach before chaining the next one; invoices-facturen.json describes
    // the four-step shape. A build that obeyed the prompt was reported
    // MISMATCH (chain length 5 vs 4).
    const withFilter = (expr) => {
        const def = passingDef();
        const filt = { id: 'flt_0a1b2c', type: 'filter', label: 'Only read files', arrayRef: `steps.${IDS.read}.output.results`, expr };
        def.steps.splice(2, 0, filt);           // list, read, FILTER, extract, add
        def.steps[3].forEach.overRef = 'steps.flt_0a1b2c.output.items';
        def.edges = [
            { from: 'trg', to: IDS.list },
            { from: IDS.list, to: IDS.read },
            { from: IDS.read, to: 'flt_0a1b2c' },
            { from: 'flt_0a1b2c', to: IDS.extract },
            { from: IDS.extract, to: IDS.add },
        ];
        return def;
    };
    for (const expr of ["item.status === 'success'", 'item.status == "success"', "  item.status==='success' "]) {
        assert.deepStrictEqual(matchExpectation(withFilter(expr), passingEvents(), brief.expect), { ok: true, failures: [] }, expr);
    }
    const other = matchExpectation(withFilter('item.output.content.length > 0'), passingEvents(), brief.expect);
    assert.strictEqual(other.ok, false);
    assert.ok(other.failures.some((f) => /chain length: expected 4 \(.*\), got 5 \(integration_action, integration_action, filter, data_extraction, datatable\)/.test(f)), other.failures.join('\n'));
});

test('a short chain reports its length and the missing rows', () => {
    const def = passingDef();
    def.steps.pop();
    def.edges.pop();
    const verdict = matchExpectation(def, passingEvents(), brief.expect);
    assert.ok(verdict.failures.some((f) => /chain length: expected 4 \(integration_action, integration_action, data_extraction, datatable\), got 3/.test(f)), verdict.failures.join('\n'));
    assert.ok(verdict.failures.some((f) => /chain\[3\] \(none\): expected a datatable step, got nothing/.test(f)), verdict.failures.join('\n'));
});

test('maxRounds and maxFailedCalls judge the transcript, finalized judges done', () => {
    const tooMany = matchExpectation(passingDef(), passingEvents({ iterations: 9 }), brief.expect);
    assert.deepStrictEqual(tooMany.failures, ['rounds: expected at most 8, got 9']);

    const events = passingEvents();
    events.splice(5, 0, errCall('builder_add_steps', 'steps[1] ($read_file): required input "path" is not bound — the step would fail'));
    const failed = matchExpectation(passingDef(), events, brief.expect);
    assert.strictEqual(failed.failures.length, 1);
    assert.match(failed.failures[0], /^failed calls: expected at most 0, got 1 — builder_add_steps: steps\[1\]/);

    // A finalize refused for validation errors reaches the wire as {error}
    // (chatStream swaps the diagnostic in BEFORE emitting tool_call); a later
    // successful finalize does not hide it.
    const refusedFinalize = passingEvents();
    refusedFinalize.splice(7, 0, { event: 'tool_call', data: { name: 'builder_finalize', arguments: {}, result: { error: 'Cannot finalize: definition has validation errors. Address the errors below and try again.', validation: { ok: false, errors: [{ code: 'ref.unknown_step' }] } } } });
    const finalizeCounted = matchExpectation(passingDef(), refusedFinalize, brief.expect);
    assert.deepStrictEqual(finalizeCounted.failures, ['failed calls: expected at most 0, got 1 — builder_finalize: Cannot finalize: definition has validation errors. Address the errors below and try again.']);

    const unfinalized = matchExpectation(passingDef(), passingEvents({ finalized: false }), brief.expect);
    assert.deepStrictEqual(unfinalized.failures, ['finalized: expected true, got false']);

    // Without a done event the rounds come from the usage events, and finalized is false.
    const cut = passingEvents().filter((e) => e.event !== 'done');
    const verdict = matchExpectation(passingDef(), cut, { ...clone(brief.expect), maxRounds: 2 });
    assert.deepStrictEqual(verdict.failures, ['finalized: expected true, got false', 'rounds: expected at most 2, got 3']);
});

test('formatCallLine shows round, verdict, repeat count and the first 80 error chars', () => {
    assert.strictEqual(formatCallLine(2, { name: 'builder_add_steps', result: { added: {} } }), 'r2 builder_add_steps ok repeat=1');
    const longErr = 'steps[1] ($read_file): nextcloud_read_file: required input "path" is not bound — the step would fail at run time. Inside this forEach bind it';
    const line = formatCallLine(3, { name: 'builder_add_steps', result: { error: longErr, _repeated: 4 } });
    assert.strictEqual(line, `r3 builder_add_steps ERR repeat=4 ${longErr.slice(0, 80)}`);
    // A multi-line error stays on one line.
    assert.strictEqual(formatCallLine(1, { name: 'x', result: { error: 'a\n  b' } }), 'r1 x ERR repeat=1 a b');
});

test('playbook judge key: triggerKind reads the definition\'s trigger', () => {
    const { matchExpectation } = require('./drive-builder');
    const def = { trigger: { kind: 'manual' }, steps: [], edges: [] };
    const events = [{ event: 'done', data: { finalized: true } }];
    assert.deepEqual(matchExpectation(def, events, { triggerKind: 'manual' }).failures, []);
    assert.match(matchExpectation({ ...def, trigger: { kind: 'nextcloud_file' } }, events, { triggerKind: 'manual' }).failures.join('\n'), /trigger kind: expected manual, got nextcloud_file/);
});

// ── expect.titled / expect.maxFirstRoundPromptTokens (2026-09-17) ───────────

const { finalTitle, firstRoundPromptTokens } = require('./drive-builder');

test('titled: the last metadata event names the routine; the finalize echo and set_metadata echo are the fallbacks', () => {
    const base = passingEvents().filter((e) => e.event !== 'metadata');
    assert.strictEqual(finalTitle(base), null);
    const viaFinalize = [...base, { event: 'tool_call', data: { name: 'builder_finalize', arguments: {}, result: { automation: { id: 'a', title: 'From finalize' }, ok: true } } }];
    assert.strictEqual(finalTitle(viaFinalize), 'From finalize');
    const viaSet = [{ event: 'tool_call', data: { name: 'builder_set_metadata', arguments: { title: 'x' }, result: { title: 'From set' } } }, ...base];
    assert.strictEqual(finalTitle(viaSet), 'From set');
    const viaMeta = [...viaFinalize, { event: 'metadata', data: { automationId: 'a', title: 'Named by the server', description: '' } }];
    assert.strictEqual(finalTitle(viaMeta), 'Named by the server', 'the metadata event wins, whatever came before');
});

test('titled fails on no name, the default name and a name over 60 chars', () => {
    const expect = { titled: true };
    const unnamed = passingEvents().filter((e) => e.event !== 'metadata');
    assert.match(matchExpectation(passingDef(), unnamed, expect).failures.join('\n'), /titled: nothing named the routine/);
    const dflt = [...passingEvents(), { event: 'metadata', data: { title: 'Untitled automation' } }];
    assert.match(matchExpectation(passingDef(), dflt, expect).failures.join('\n'), /still "Untitled automation"/);
    const long = [...passingEvents(), { event: 'metadata', data: { title: 'x'.repeat(61) } }];
    assert.match(matchExpectation(passingDef(), long, expect).failures.join('\n'), /61 chars, expected at most 60/);
    const good = [...passingEvents(), { event: 'metadata', data: { title: 'Facturen inlezen' } }];
    assert.deepStrictEqual(matchExpectation(passingDef(), good, expect), { ok: true, failures: [] });
});

test('maxFirstRoundPromptTokens reads the FIRST usage event and fails without one', () => {
    const evs = passingEvents();
    evs.find((e) => e.event === 'usage').data.prompt_tokens = 14_200;
    evs.filter((e) => e.event === 'usage')[1].data.prompt_tokens = 30_000;
    assert.strictEqual(firstRoundPromptTokens(evs), 14_200, 'the first round, not the largest');
    assert.deepStrictEqual(matchExpectation(passingDef(), evs, { maxFirstRoundPromptTokens: 15_000 }), { ok: true, failures: [] });
    assert.match(matchExpectation(passingDef(), evs, { maxFirstRoundPromptTokens: 14_000 }).failures.join('\n'), /expected at most 14000, got 14200/);
    assert.match(matchExpectation(passingDef(), passingEvents(), { maxFirstRoundPromptTokens: 14_000 }).failures.join('\n'), /no usage event carried prompt_tokens/);
});
