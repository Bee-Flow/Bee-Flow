/**
 * refCheck — deep feedback on every path the AI binds.
 *
 * REGRESSION (findings C2 / audit:server-static-paths, 2026-10): the builder
 * checked a path's ROOT only (and loop refs one dot-split level deep, against
 * element [0] of a list). `steps.x.output.total` for an extraction that
 * declares `totaal`, a key read straight off a list, a field one level down
 * inside the only list, `headers.subject` on a name/value list — all were
 * saved silently and resolved to nothing at run time. A per-item field that
 * only entry 2 carries was REFUSED. These pin the repair-or-explain contract:
 * one obvious fix that keeps the meaning → applied and named; none → refused
 * with a "did you mean" when the shape is COMPLETE (what the step declares),
 * a warning when it is not (one observed run, a description); an unknown
 * shape → no complaint at all. refCheck.certainty.test.js pins the line
 * between the two (code review 2026-10).
 *
 * Run: cd server && node --test automation/builderTools/refCheck.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAndFixBindings, sanitizeForEach, checkTextPlaceholders } = require('./bindings');
const { checkLoopRef } = require('./outputFields');
const { rememberStepShape } = require('./refCheck');

const ref = path => ({ kind: 'ref', path });
const EX = { id: 'ex', type: 'data_extraction', fields: [{ name: 'datum', type: 'date' }, { name: 'totaal', type: 'number' }] };
const READ = { id: 'r', type: 'integration_action', tool: 'gmail_read' };
// Two steps whose output nothing declares (an ai_step without an
// outputSchema): what they hold is only known from a dry run. They used to be
// code steps, until refCheck learned the code step's own envelope (below).
const CODE = { id: 'c', type: 'ai_step' };
const HTTP = { id: 'h', type: 'ai_step' };
const LIST = { id: 'l', type: 'integration_action', tool: 'nextcloud_list_files' };
const FAN = { id: 'fan', type: 'integration_action', tool: 'nextcloud_read_file', forEach: { overRef: 'steps.l.output.items', itemVar: 'f' } };
const graph = (trigger = { id: 'trg', kind: 'manual' }) => ({ trigger, steps: [EX, READ, CODE, HTTP, LIST, FAN], edges: [] });

/** A draft wrap that has seen a dry run of those steps (what they really returned). */
function seenWrap() {
    const dw = { def: graph() };
    rememberStepShape(dw, CODE, {
        messages: [
            { id: 'm1', payload: { headers: [{ name: 'From', value: 'a@x.nl' }, { name: 'Subject', value: 'Invoice' }], parts: [{ body: { data: 'QQ' } }] } },
            { id: 'm2', payload: { headers: [{ name: 'From', value: 'b@x.nl' }, { name: 'Subject', value: 'Quote' }] }, labelIds: ['INBOX'] },
        ],
        results: [{ id: 1, subject: 'calendar invite' }, { id: 2, subject: 'mail', body: 'text only on entry 2' }],
    });
    rememberStepShape(dw, HTTP, { status: 200, body: '{"data":{"items":[{"id":1,"sku":"A-1"}]}}' });
    return dw;
}

function check(path, dw = seenWrap(), opts = {}) {
    const r = validateAndFixBindings({ v: ref(path) }, dw.def, { draftWrap: dw, ...opts });
    return { path: r.inputs.v && r.inputs.v.path, error: r.error, notes: (r.notes || []).join('\n') };
}

test('a path that resolves is kept and nothing is said', () => {
    for (const p of [
        'steps.ex.output.totaal',
        'steps.c.output.messages[0].payload.headers[name="Subject"].value',
        'steps.c.output.messages[*].labelIds',
        'steps.r.output.attachments[0].filename',
        'steps.fan.output.results[*].output.content',
    ]) {
        const r = check(p);
        assert.equal(r.error, null, `${p}: ${r.error}`);
        assert.equal(r.path, p);
        assert.equal(r.notes, '', p);
    }
});

test('a field only a LATER list entry has is a real field (union of entries, not entry 0)', () => {
    const r = check('steps.c.output.results[0].body');
    assert.equal(r.error, null, r.error);
    assert.equal(r.notes, '');
    const fe = { overRef: 'steps.c.output.results', itemVar: 'm' };
    assert.deepEqual(checkLoopRef(seenWrap().def, 'loop.m.body', fe, seenWrap()), { ok: true });
});

// One dry run is one observed run: a typo inside it is NAMED (warning with
// a did-you-mean), not refused — a key it lacked may be optional.
test('JSON text is walked like the run walks it; a typo inside it is caught', () => {
    assert.equal(check('steps.h.output.body.data.items[0].sku').error, null);
    const bad = check('steps.h.output.body.data.itemz[0].sku');
    assert.equal(bad.error, null);
    assert.match(bad.notes, /has no "itemz"/);
    assert.match(bad.notes, /Did you mean steps\.h\.output\.body\.data\.items/);
});

test('one obvious fix is applied and named', () => {
    const cases = [
        ['steps.ex.totaal', 'steps.ex.output.totaal', /sits under \.output/],
        ['steps.ex.output.Totaal', 'steps.ex.output.totaal', /spelled "totaal"/],
        ['steps.r.output.attachments.filename', 'steps.r.output.attachments[0].filename', /\[0\] is the first entry/],
        ['steps.c.output.messages[0].payload.headers.subject', 'steps.c.output.messages[0].payload.headers[name="Subject"].value', /name\/value pairs/],
        ['steps.fan.output.results[0].content', 'steps.fan.output.results[0].output.content', /\[0\]|output/],
    ];
    for (const [from, to, why] of cases) {
        const r = check(from);
        assert.equal(r.error, null, `${from}: ${r.error}`);
        assert.equal(r.path, to, from);
        assert.match(r.notes, why, from);
        assert.match(r.notes, new RegExp(`read "${from.replace(/[.[\]*$]/g, '\\$&')}" as`), from);
    }
});

// A key moved into the one list that has it is a guess on a shape that is
// not complete (the curated gmail_read shape): said, not applied.
test('a key that only sits inside the one list is a did-you-mean on a described shape', () => {
    const r = check('steps.r.output.filename');
    assert.equal(r.error, null);
    assert.equal(r.path, 'steps.r.output.filename');
    assert.match(r.notes, /Did you mean steps\.r\.output\.attachments\[0\]\.filename\?/);
});

// An index is a path the run reads: rewriting `headers[1]` to a match read
// another entry whenever two shared a name, and froze sample values into the
// definition (code review 2026-10). Picking by name is advice.
test('an index into a name/value list is kept; picking by name is advice', () => {
    const dw = { def: graph() };
    rememberStepShape(dw, CODE, { payload: { headers: [{ name: 'From', value: 'a' }, { name: 'Subject', value: 's' }] } });
    const r = check('steps.c.output.payload.headers[1].value', dw);
    assert.equal(r.path, 'steps.c.output.payload.headers[1].value');
    assert.match(r.notes, /bind steps\.c\.output\.payload\.headers\[name="Subject"\]\.value/);
    assert.doesNotMatch(r.notes, /order differs per record/, 'one sample shows no order');
});

test('a miss on an authoritative shape is refused with a "did you mean"', () => {
    const r = check('steps.ex.output.total');
    assert.match(r.error, /^inputs\.v: "steps\.ex\.output\.total" does not resolve: steps\.ex\.output has no "total"\. Did you mean steps\.ex\.output\.totaal\?/);
    assert.match(r.error, /has: datum, totaal/);
    // A dry run is one observed run: its key sets warn, never refuse.
    const deep = check('steps.c.output.messages[0].payload.part[0].body.data');
    assert.equal(deep.error, null);
    assert.match(deep.notes, /Did you mean steps\.c\.output\.messages\[0\]\.payload\.parts/);
    const scalar = check('steps.ex.output.totaal.value');
    assert.match(scalar.error, /is a number, so it has no "value"/);
});

test('a miss on a described (curated) shape is a warning, and the binding is kept', () => {
    const r = check('steps.r.output.bodyText');
    assert.equal(r.error, null);
    assert.equal(r.path, 'steps.r.output.bodyText');
    assert.match(r.notes, /has no "bodyText"/);
    assert.match(r.notes, /binding was kept/);
});

test('an unknown shape never complains', () => {
    const dw = { def: graph() };   // no dry run: the ai_step's output is unknown
    for (const p of ['steps.c.output.anything.at[3].all', 'steps.nope.output.x', 'vars.rows[0]', 'loop.x.y']) {
        const r = check(p, dw);
        assert.equal(r.error, null, p);
        assert.equal(r.notes, '', p);
    }
});

test('trigger paths: .output is inserted, a case slip on a declared field is fixed, an undeclared field passes', () => {
    const g = graph({ id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } });
    const dw = { def: g };
    assert.equal(check('trigger.subject', dw).path, 'trigger.output.subject');
    assert.equal(check('trigger.output.Subject', dw).path, 'trigger.output.subject');
    const att = check('trigger.output.attachments[0].attachmentId', dw);
    assert.equal(att.path, 'trigger.output.attachments[0].attachmentId', 'the poller adds attachments; the declaration omits them');
    assert.equal(att.notes, '');
    assert.equal(check('trigger.kind', dw).path, 'trigger.kind', 'trigger meta stays where it is');
});

test('where a LIST is wanted (forEach.overRef) a key on a list becomes [*] and an object becomes its one list', () => {
    const g = seenWrap();
    const a = sanitizeForEach({ overRef: 'steps.r.output.attachments.filename', itemVar: 'a' }, g.def, g);
    assert.equal(a.forEach.overRef, 'steps.r.output.attachments[*].filename');
    const b = sanitizeForEach({ overRef: 'steps.r.output', itemVar: 'a' }, g.def, g);
    assert.equal(b.forEach.overRef, 'steps.r.output.attachments');
    assert.match(b.notes.join('\n'), /^forEach\.overRef: read "steps\.r\.output" as "steps\.r\.output\.attachments"/);
});

test('loop refs are checked deep and token-based against the forEach item', () => {
    const dw = seenWrap();
    const fe = { overRef: 'steps.c.output.messages', itemVar: 'm' };
    assert.deepEqual(checkLoopRef(dw.def, 'loop.m.payload.headers[name="Subject"].value', fe, dw), { ok: true });
    const fixed = checkLoopRef(dw.def, 'loop.m.payload.headers.subject', fe, dw);
    assert.equal(fixed.ok, true);
    assert.equal(fixed.path, 'loop.m.payload.headers[name="Subject"].value');
    const miss = checkLoopRef(dw.def, 'loop.m.payload.part[0].body', fe, dw);
    assert.equal(miss.ok, false);
    assert.equal(miss.missing, 'payload.part');
    assert.ok(miss.suggestions.some(s => s.startsWith('loop.m.payload.parts')), miss.suggestions.join());
});

test('text fields with placeholders get the same check (an ai_step prompt)', () => {
    const dw = seenWrap();
    const bad = checkTextPlaceholders('Summarise {{steps.ex.output.total}}', dw.def, { draftWrap: dw, label: 'prompt' });
    assert.match(bad.error, /^prompt: .*Did you mean steps\.ex\.output\.totaal/);
    const fixed = checkTextPlaceholders('From {{ steps.ex.totaal }}', dw.def, { draftWrap: dw, label: 'prompt' });
    assert.equal(fixed.text, 'From {{steps.ex.output.totaal}}');
    assert.match(fixed.notes.join('\n'), /^prompt: read/);
    const prose = checkTextPlaceholders('Use {{ mustache }} syntax', dw.def, { draftWrap: dw, label: 'prompt' });
    assert.equal(prose.error, null, 'prose braces are a note, not a refusal');
});

test('loop.<var> in an ai_step\'s inputs and prompt is checked against what its forEach iterates', async () => {
    const { applyToolCall, emptyDefinition } = require('../builderTools');
    const dw = { userId: 'u_test', def: emptyDefinition() };
    dw.def.steps.push(LIST, FAN);
    const r = await applyToolCall('builder_add_ai_step', {
        prompt: 'Summarise {{loop.r.content}}',
        inputs: { name: ref('loop.r.item.Name') },
        forEach: { overRef: 'steps.fan.output.results', itemVar: 'r' },
    }, dw);
    assert.ok(!r.error, r.error);
    assert.equal(r.added.prompt, 'Summarise {{loop.r.output.content}}');
    assert.equal(r.added.inputs.name.path, 'loop.r.item.name');
    assert.match(r._warnings.join('\n'), /prompt: binding "loop\.r\.content" read as "loop\.r\.output\.content"/);
    const bad = await applyToolCall('builder_add_ai_step', {
        prompt: 'x', inputs: { n: ref('loop.r.index.value') },
        forEach: { overRef: 'steps.fan.output.results', itemVar: 'r' },
    }, dw);
    assert.match(bad.error, /^inputs\.n: "loop\.r\.index\.value" does not resolve: loop\.r\.index is a number/);
});

test('a synthesised dry-run output is a sample: a miss on it warns, never refuses', () => {
    const dw = { def: graph() };
    rememberStepShape(dw, CODE, { results: [{ id: 'msg-1', subject: 'Sample' }], _dryRunSynthesised: true, _dryRunFallback: 'not_connected' });
    const r = check('steps.c.output.results[0].threadId', dw);
    assert.equal(r.error, null);
    assert.match(r.notes, /has no "threadId"/);
    const stamp = check('steps.c.output._dryRunFallback', dw);
    assert.match(stamp.notes, /has no "_dryRunFallback"/, 'the stamps are not fields of the step');
});

test('name/value lists: a key that is an entry name is suggested as a match; an index into lists of differing order gets advice', () => {
    const dw = seenWrap();   // two messages whose headers are in the SAME order
    const miss = check('steps.c.output.messages[0].payload.subject', dw);
    assert.match(miss.notes, /Did you mean .*steps\.c\.output\.messages\[0\]\.payload\.headers\[name="Subject"\]\.value/);
    const mixed = { def: graph() };
    rememberStepShape(mixed, CODE, { messages: [
        { headers: [{ name: 'From', value: 'a' }, { name: 'Subject', value: 's' }] },
        { headers: [{ name: 'Subject', value: 't' }, { name: 'From', value: 'b' }] },
    ] });
    const idx = check('steps.c.output.messages[0].headers[1].value', mixed);
    assert.equal(idx.error, null);
    assert.equal(idx.path, 'steps.c.output.messages[0].headers[1].value', 'kept: which name it meant is not known');
    assert.match(idx.notes, /order differs per record — \[1\] picks a different entry each time; select one by name, e\.g\. steps\.c\.output\.messages\[0\]\.headers\[name="From"\]/);
});

// A spelling guess (total → totaal) is a did-you-mean only: the patch the
// identical resend applies is reserved for a fix that keeps the meaning
// (refCheck.certainty.test.js: the same key in exactly one other place).
test('a refusal whose only candidate is a spelling guess carries no suggested patch', () => {
    const r = validateAndFixBindings({ v: ref('steps.ex.output.total') }, seenWrap().def, { draftWrap: seenWrap() });
    assert.match(r.error, /Did you mean steps\.ex\.output\.totaal\?/);
    assert.equal(r._suggestedPatch, undefined);
});

// REGRESSION (flowlet "Get ticketlist", 2026-10-09): a code step's output is
// execCode's envelope { result, logs, httpCalls } (automation/codeOutput.js),
// but refCheck called it unknown, so `steps.<code>.output.count` was saved for
// a returned `{ count }` and read nothing at run time.
test('a code step: a field of what the code returned is read under output.result', () => {
    const FMT = { id: 'fmt', type: 'code', outputSchema: { count: 'number', tickets: 'array' } };
    const RAW = { id: 'raw', type: 'code' };
    const dw = { def: { trigger: { id: 'trg', kind: 'manual' }, steps: [FMT, RAW], edges: [] } };
    const r = check('steps.fmt.output.count', dw);
    assert.equal(r.error, null);
    assert.equal(r.path, 'steps.fmt.output.result.count');
    assert.match(r.notes, /a code step hands on what its code returned under \.result/);
    // Without an outputSchema the result is unknown, but the envelope is not.
    assert.equal(check('steps.raw.output.tickets[0].id', dw).path, 'steps.raw.output.result.tickets[0].id');
    // What the picker writes, and the envelope's own fields, are left alone.
    for (const p of ['steps.fmt.output.result.count', 'steps.raw.output.result', 'steps.raw.output.logs']) {
        const kept = check(p, dw);
        assert.equal(kept.path, p);
        assert.equal(kept.notes, '', p);
    }
    // A list is what the code returned, not its envelope.
    assert.equal(check('steps.raw.output', dw, { wantList: true }).path, 'steps.raw.output.result');
});
