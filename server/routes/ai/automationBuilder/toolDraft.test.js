/**
 * toolDraft.js — reading the steps out of a tool call that is still streaming.
 *
 * The input is a PREFIX of the arguments JSON cut at any byte, so every case
 * here is either a real builder call cut somewhere awkward or something that
 * is not JSON at all. The scanner must never throw, never JSON.parse, report
 * steps in order (loop bodies flattened after their loop), and flag what is
 * still open.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/toolDraft.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    scanToolDraft, deriveDraftKey, makeDraftThrottle, makeProgressThrottle, MAX_STEPS, MAX_LABEL,
} = require('./toolDraft');

// A real builder_add_steps call: 3 entries, the middle one a loop with a
// two-step body → 5 steps on the canvas, in this order.
const ADD_STEPS = JSON.stringify({
    steps: [
        { tempId: 'search', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'is:unread' } }, label: 'Find unread mail' } },
        {
            tempId: 'each', type: 'loop', spec: {
                overRef: 'steps.$search.output.messages', itemVar: 'msg', label: 'For each message', body: [
                    { type: 'condition', expr: 'contains(lower(loop.msg.subject), "invoice")', label: 'Invoice?' },
                    { type: 'integration_action', tool: 'gmail_label', label: 'Tag "invoice"' },
                ],
            },
        },
        { tempId: 'notify', type: 'notification', spec: { title: 'Done', body: 'Processed {{steps.$each.output.count}}', label: 'Notify me' } },
    ],
});
const cutBefore = (needle, from = 0) => {
    const at = ADD_STEPS.indexOf(needle, from);
    assert.notStrictEqual(at, -1, `fixture lost "${needle}"`);
    return ADD_STEPS.slice(0, at);
};

test('the complete builder_add_steps call → 5 steps in order, loop body flattened after its loop, none partial', () => {
    const r = scanToolDraft('builder_add_steps', ADD_STEPS);
    assert.strictEqual(r.count, 5);
    assert.deepStrictEqual(r.inspect, []);
    assert.deepStrictEqual(r.steps, [
        { type: 'integration_action', tool: 'gmail_search', label: 'Find unread mail', partial: false },
        { type: 'loop', tool: null, label: 'For each message', partial: false },
        { type: 'condition', tool: null, label: 'Invoice?', partial: false },
        { type: 'integration_action', tool: 'gmail_label', label: 'Tag "invoice"', partial: false },
        { type: 'notification', tool: null, label: 'Notify me', partial: false },
    ]);
});

test('cut mid-key inside the first entry: the entry counts as one open step that says nothing yet', () => {
    const r = scanToolDraft('builder_add_steps', cutBefore('pId":"search"'));
    assert.strictEqual(r.count, 1);
    assert.deepStrictEqual(r.steps[0], { type: null, tool: null, label: null, partial: true });
});

test('cut mid-label: the typed part of the label is shown, the step is partial, tool and type are already known', () => {
    const r = scanToolDraft('builder_add_steps', cutBefore('ead mail'));
    assert.strictEqual(r.count, 1);
    assert.deepStrictEqual(r.steps[0], { type: 'integration_action', tool: 'gmail_search', label: 'Find unr', partial: true });
});

test('cut between entries: the closed entry is final, nothing has opened for the next', () => {
    const src = cutBefore('{"tempId":"each"');
    assert.ok(src.endsWith(','), 'cut sits right after the comma');
    const r = scanToolDraft('builder_add_steps', src);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.steps[0].partial, false);
    assert.strictEqual(r.steps[0].label, 'Find unread mail');
});

test('cut inside the loop body: the loop is open, its finished body step is final, the open one is partial', () => {
    const r = scanToolDraft('builder_add_steps', cutBefore('"label":"Tag'));
    assert.strictEqual(r.count, 4);
    assert.deepStrictEqual(r.steps.map(s => [s.type, s.tool, s.partial]), [
        ['integration_action', 'gmail_search', false],
        ['loop', null, true],
        ['condition', null, false],
        ['integration_action', 'gmail_label', true],
    ]);
    assert.strictEqual(r.steps[3].label, null, 'label key not reached yet');
});

test('a half-typed tool name is NOT a tool (null until the string closes); type is', () => {
    const r = scanToolDraft('builder_add_steps', cutBefore('l_search'));
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.steps[0].type, 'integration_action');
    assert.strictEqual(r.steps[0].tool, null);
    assert.strictEqual(r.steps[0].partial, true);
});

test('every prefix of the real call scans without throwing, and the step count never goes down', () => {
    let last = 0;
    for (let i = 0; i <= ADD_STEPS.length; i++) {
        const r = scanToolDraft('builder_add_steps', ADD_STEPS.slice(0, i));
        assert.ok(r.count >= last, `count dropped at cut ${i}: ${last} → ${r.count}`);
        assert.ok(r.count <= 5, `over-counted at cut ${i}`);
        assert.strictEqual(r.steps.length, r.count);
        last = r.count;
    }
    assert.strictEqual(last, 5);
});

test('builder_add_action without a type key → type "action", tool and label from the root object', () => {
    const src = '{"tool":"slack_post_message","inputs":{"channel":{"kind":"literal","value":"#ops"},"label":{"kind":"literal","value":"decoy"}},"label":"Post to ops"}';
    const r = scanToolDraft('builder_add_action', src);
    assert.deepStrictEqual(r.steps, [{ type: 'action', tool: 'slack_post_message', label: 'Post to ops', partial: false }]);
    assert.strictEqual(r.count, 1);
});

test('builder_add_action while streaming: one open step from the first brace, fields as they land', () => {
    assert.deepStrictEqual(scanToolDraft('builder_add_action', '{').steps, [{ type: 'action', tool: null, label: null, partial: true }]);
    assert.deepStrictEqual(scanToolDraft('builder_add_action', '{"tool":"slack_po').steps[0], { type: 'action', tool: null, label: null, partial: true });
    assert.deepStrictEqual(scanToolDraft('builder_add_action', '{"tool":"slack_post_message","label":"Post to o').steps[0],
        { type: 'action', tool: 'slack_post_message', label: 'Post to o', partial: true });
    assert.strictEqual(scanToolDraft('builder_add_action', '').count, 0, 'nothing before the brace');
});

test('single add tools infer their type from the name', () => {
    const cases = [
        ['builder_add_ai_step', '{"prompt":"Classify","label":"Classify mail"}', 'ai_step'],
        ['builder_add_condition', '{"expr":"x > 1","label":"Big?"}', 'condition'],
        ['builder_add_set', '{"label":"Vars"}', 'set'],
        ['builder_add_datatable', '{"label":"Log row"}', 'datatable'],
        ['builder_add_code_step', '{"label":"Transform"}', 'code_step'],
    ];
    for (const [name, src, type] of cases) {
        const r = scanToolDraft(name, src);
        assert.strictEqual(r.count, 1, name);
        assert.strictEqual(r.steps[0].type, type, name);
        assert.strictEqual(r.steps[0].partial, false, name);
    }
});

test('builder_add_loop → the loop plus its body steps, title used when a body step has no label', () => {
    const src = '{"overRef":"steps.a.output.rows","itemVar":"row","maxIterations":50,"body":[{"type":"condition","expr":"loop.row.total > 1000"},{"type":"notification","title":"Large amount","body":"{{loop.row.id}}"}],"label":"Check rows"}';
    const r = scanToolDraft('builder_add_loop', src);
    assert.deepStrictEqual(r.steps, [
        { type: 'loop', tool: null, label: 'Check rows', partial: false },
        { type: 'condition', tool: null, label: null, partial: false },
        { type: 'notification', tool: null, label: 'Large amount', partial: false },
    ]);
});

test('builder_inspect_tool batch form: names in order; an unterminated last name only once it has 3+ chars', () => {
    assert.deepStrictEqual(scanToolDraft('builder_inspect_tool', '{"tools":["gmail_search","gmail_compose","cal').inspect,
        ['gmail_search', 'gmail_compose', 'cal']);
    assert.deepStrictEqual(scanToolDraft('builder_inspect_tool', '{"tools":["gmail_search","gm').inspect, ['gmail_search']);
    assert.deepStrictEqual(scanToolDraft('builder_inspect_tool', '{"tools":["gmail_search","gmail_compose"]}').inspect,
        ['gmail_search', 'gmail_compose']);
    const r = scanToolDraft('builder_inspect_tool', '{"tools":[');
    assert.deepStrictEqual(r, { steps: [], count: 0, capped: false, inspect: [] });
});

test('builder_inspect_tool legacy single form, and both forms together', () => {
    assert.deepStrictEqual(scanToolDraft('builder_inspect_tool', '{"tool":"gmail_search"}').inspect, ['gmail_search']);
    assert.deepStrictEqual(scanToolDraft('builder_inspect_tool', '{"tool":"gm').inspect, [], 'too short to be a name yet');
    assert.deepStrictEqual(scanToolDraft('builder_inspect_tool', '{"tools":["a_tool"],"tool":"b_tool"}').inspect, ['a_tool', 'b_tool']);
    assert.strictEqual(scanToolDraft('builder_inspect_tool', '{"tool":"x"}').count, 0);
});

test('escaped quotes and backslashes inside a label decode correctly, open or closed', () => {
    const full = '{"tool":"x_tool","label":"Say \\"hi\\" to \\\\ all"}';
    assert.strictEqual(scanToolDraft('builder_add_action', full).steps[0].label, 'Say "hi" to \\ all');
    // Cut right after the escaped quote — the backslash must not be read as the string's end.
    const cut = '{"tool":"x_tool","label":"Say \\"hi\\';
    const r = scanToolDraft('builder_add_action', cut);
    assert.strictEqual(r.steps[0].partial, true);
    assert.strictEqual(r.steps[0].tool, 'x_tool');
    assert.strictEqual(r.steps[0].label, 'Say "hi');
    // A \u escape and a newline collapse into the label text.
    assert.strictEqual(scanToolDraft('builder_add_action', '{"label":"caf\\u00e9\\nbar"}').steps[0].label, 'café bar');
});

test('garbage and non-object roots → the empty result, never a throw', () => {
    const empty = { steps: [], count: 0, capped: false, inspect: [] };
    for (const src of ['', 'not json at all', '[1,2', '{{{{', '"just a string"', ']}', '{"a":', null, undefined, 12345, { a: 1 }]) {
        assert.deepStrictEqual(scanToolDraft('builder_add_steps', src), empty, JSON.stringify(src));
    }
    assert.deepStrictEqual(scanToolDraft('builder_add_action', '["not","an","object"]'), empty);
    assert.deepStrictEqual(scanToolDraft(undefined, '{"tool":"x"}'), empty);
    assert.deepStrictEqual(scanToolDraft(123, '{"tool":"x"}'), empty);
});

test('tools that do not describe steps → empty steps and inspect, whatever their arguments say', () => {
    const stepish = '{"tool":"gmail_search","label":"Looks like a step"}';
    for (const name of ['some_other_tool', 'builder_dry_run', 'builder_summarise', 'builder_finalize', 'builder_remove_step', 'builder_propose_trigger', 'app_add_screen']) {
        assert.deepStrictEqual(scanToolDraft(name, stepish), { steps: [], count: 0, capped: false, inspect: [] }, name);
    }
});

test('builder_replace_step → one step typed by newType, fields from spec', () => {
    const r = scanToolDraft('builder_replace_step', '{"stepId":"s1","newType":"ai_step","spec":{"prompt":"Sort it","label":"Classify"}}');
    assert.deepStrictEqual(r.steps, [{ type: 'ai_step', tool: null, label: 'Classify', partial: false }]);
    const open = scanToolDraft('builder_replace_step', '{"stepId":"s1","newType":"integration_action","spec":{"tool":"gmail_send","label":"Se');
    assert.deepStrictEqual(open.steps, [{ type: 'integration_action', tool: 'gmail_send', label: 'Se', partial: true }]);
});

test('builder_update_step / builder_update_steps → one step per patch, type unknown, fields from the patch', () => {
    const one = scanToolDraft('builder_update_step', '{"stepId":"s1","patch":{"label":"Renamed","tool":"gmail_send"},"inputsMode":"merge"}');
    assert.deepStrictEqual(one.steps, [{ type: null, tool: 'gmail_send', label: 'Renamed', partial: false }]);
    const many = scanToolDraft('builder_update_steps', '{"updates":[{"stepId":"a","patch":{"label":"One"}},{"stepId":"b","patch":{"label":"Tw');
    assert.strictEqual(many.count, 2);
    assert.deepStrictEqual(many.steps[0], { type: null, tool: null, label: 'One', partial: false });
    assert.deepStrictEqual(many.steps[1], { type: null, tool: null, label: 'Tw', partial: true });
});

test("the contract's `spec[]` spelling of builder_add_steps is read too", () => {
    const r = scanToolDraft('builder_add_steps', '{"spec":[{"type":"set","label":"A"},{"type":"wait","label":"B"}]}');
    assert.deepStrictEqual(r.steps.map(s => s.type), ['set', 'wait']);
});

test('caps: at most 40 steps, labels cut to 80 characters and whitespace-collapsed', () => {
    const many = { steps: Array.from({ length: 45 }, (_, i) => ({ type: 'set', spec: { label: `S${i}` } })) };
    const r = scanToolDraft('builder_add_steps', JSON.stringify(many));
    assert.strictEqual(r.count, MAX_STEPS);
    assert.strictEqual(r.steps.length, 40);
    const long = scanToolDraft('builder_add_action', JSON.stringify({ tool: 't', label: '  x'.repeat(100) }));
    assert.strictEqual(long.steps[0].label.length, MAX_LABEL);
    assert.ok(!/\s{2}/.test(long.steps[0].label));
    assert.strictEqual(scanToolDraft('builder_add_action', '{"tool":"t","label":"   "}').steps[0].label, null, 'blank label is no label');
});

// ─── deriveDraftKey ──────────────────────────────────────────────────────────

test('deriveDraftKey changes when a step appears, a tool becomes known or a label finishes — not while a label is typed', () => {
    const k = (name, src) => deriveDraftKey(scanToolDraft(name, src));
    const a = k('builder_add_action', '{');
    const b = k('builder_add_action', '{"tool":"slack_po');
    assert.strictEqual(a, b, 'a half tool name is not a derived change');
    const c = k('builder_add_action', '{"tool":"slack_post_message"');
    assert.notStrictEqual(b, c, 'tool became known');
    const d = k('builder_add_action', '{"tool":"slack_post_message","label":"Po');
    const e = k('builder_add_action', '{"tool":"slack_post_message","label":"Post to o');
    assert.strictEqual(d, e, 'label typing rides the throttle, not the key');
    const f = k('builder_add_action', '{"tool":"slack_post_message","label":"Post to ops"}');
    assert.notStrictEqual(e, f, 'the object closed');
    assert.notStrictEqual(k('builder_add_steps', cutBefore('{"tempId":"each"')), k('builder_add_steps', cutBefore('pId":"each"')), 'a new step opened');
    assert.notStrictEqual(k('builder_inspect_tool', '{"tools":["gmail_search"'), k('builder_inspect_tool', '{"tools":["gmail_search","gmail_compose"'));
    assert.strictEqual(typeof deriveDraftKey({}), 'string');
    assert.strictEqual(deriveDraftKey(), deriveDraftKey({ steps: [], inspect: [] }));
});

// ─── throttles ───────────────────────────────────────────────────────────────

test('makeDraftThrottle: emits at once, holds the same key for 250 ms, lets a changed key through immediately', () => {
    let t = 1000;
    const gate = makeDraftThrottle({ now: () => t });
    assert.strictEqual(gate('A'), true, 'first call always emits');
    t += 100;
    assert.strictEqual(gate('A'), false, 'same key inside the window');
    assert.strictEqual(gate('B'), true, 'a changed key does not wait');
    t += 100;
    assert.strictEqual(gate('B'), false);
    t += 149;   // 249 ms since B was emitted
    assert.strictEqual(gate('B'), false, 'still inside the window');
    t += 1;     // 250 ms
    assert.strictEqual(gate('B'), true, 'window elapsed');
    t += 10;
    assert.strictEqual(gate('B'), false, 'the window restarted on the emit');
});

test('makeProgressThrottle: ≤ 1 per 250 ms, the completing chunk always passes', () => {
    let t = 0;
    const gate = makeProgressThrottle({ now: () => t });
    assert.strictEqual(gate(), true);
    t = 100; assert.strictEqual(gate(), false);
    t = 249; assert.strictEqual(gate(), false);
    t = 250; assert.strictEqual(gate(), true);
    t = 260; assert.strictEqual(gate(true), true, 'forced (prefill complete) passes inside the window');
    t = 300; assert.strictEqual(gate(), false, 'the forced emit restarted the window');
    t = 510; assert.strictEqual(gate(), true);
    const custom = makeProgressThrottle({ now: () => 0, intervalMs: 1000 });
    assert.strictEqual(custom(), true);
    assert.strictEqual(custom(), false);
});

// ── The ceiling is a ceiling, not a total ────────────────────────────
//
// The scan reads at most MAX_STEPS (40) cards out of a streaming call. It used
// to report that ceiling as `count` with nothing to distinguish it from a real
// total, and the canvas printed "Step 40 of 40" over a build whose batch size
// nobody knew — measured on a live build, 2026-09-16. `capped` is the client's
// way to tell the two apart.

test('a batch under the ceiling is never marked capped', () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({ type: 'datatable', spec: { label: `S${i}` } }));
    const r = scanToolDraft('builder_add_steps', JSON.stringify({ steps }));
    assert.strictEqual(r.count, 5);
    assert.strictEqual(r.capped, false);
});

test('a batch over the ceiling reports the ceiling AND says it is one', () => {
    const steps = Array.from({ length: 64 }, (_, i) => ({ type: 'datatable', spec: { label: `S${i}` } }));
    const r = scanToolDraft('builder_add_steps', JSON.stringify({ steps }));
    assert.strictEqual(r.steps.length, 40, 'still capped at 40 cards');
    assert.strictEqual(r.count, 40);
    assert.strictEqual(r.capped, true, 'and the client is told the 40 is the ceiling');
});

test('nested bodies count toward the ceiling and can trip it on their own', () => {
    // One loop whose body holds more cards than the scan will read.
    const body = Array.from({ length: 50 }, (_, i) => ({ type: 'set', spec: { label: `B${i}` } }));
    const r = scanToolDraft('builder_add_steps', JSON.stringify({ steps: [{ type: 'loop', spec: { label: 'Loop', body } }] }));
    assert.strictEqual(r.steps.length, 40);
    assert.strictEqual(r.capped, true);
});

test('a batch of exactly 40 is full, not capped', () => {
    const steps = Array.from({ length: 40 }, (_, i) => ({ type: 'datatable', spec: { label: `S${i}` } }));
    const r = scanToolDraft('builder_add_steps', JSON.stringify({ steps }));
    assert.strictEqual(r.count, 40);
    assert.strictEqual(r.capped, false, '40 read out of 40 sent is a real total');
});
