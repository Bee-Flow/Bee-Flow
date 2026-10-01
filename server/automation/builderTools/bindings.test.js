/**
 * The AI builder's binding canonicaliser and repair (bindings.js), against
 * the confirmed bugs it used to cause:
 *
 *   - `_normalizeRefPath` turned every bracket into a dot and then cut the
 *     path at the first character it did not expect, so `items[0].subject`,
 *     `results[*].output.a`, `body["content-type"]` and `row["Due date"]`
 *     were STORED as paths the runtime resolves to undefined (or to another
 *     field), with no error;
 *   - a literal object with a `path` key (a file {path, name}) was read as a
 *     ref, cut to '' and refused;
 *   - builder_update_step re-canonicalised EVERY input of the step, so an AI
 *     edit of one input rewrote the user's own bracketed refs;
 *   - forEach.overRef and a set's arrayRef went through the same damage.
 *
 * Every path is also resolved with the runtime's walkPath, so "kept" means
 * "still reads the value", not just "string unchanged".
 *
 * Run: cd server && node --test automation/builderTools/bindings.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { validateAndFixBindings, sanitizeForEach, repairRefPath } = require('./bindings');
const { applyToolCall, emptyDefinition } = require('../builderTools');
const { walkPath } = require('../bind');

const GMAIL = { trigger: { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } } };

const STATE = {
    trigger: { output: { subject: 'S', attachments: [{ data: 'D', filename: 'a.pdf' }], body: { 'content-type': 'text/plain', content: 'wrong field' }, 'Order date': '2026-10-01' } },
    steps: {
        s1: { output: { items: [{ subject: 'hi' }], results: [{ output: { a: 1, attachments: [{ n: 1 }] } }, { output: { a: 2, attachments: [{ n: 2 }] } }] } },
        http1: { output: { body: { 'content-type': 'application/json' } } },
    },
    loop: { row: { 'Due date': 'x', 'e-mail': 'y' } },
};

function pathOf(path, draft = GMAIL) {
    const r = validateAndFixBindings({ x: { kind: 'ref', path } }, draft);
    return { path: r.inputs.x.path, error: r.error, repairs: r.repairs || [] };
}

test('a path the runtime already reads is stored exactly as written', () => {
    for (const p of [
        'steps.s1.output.items[0].subject',
        'steps.s1.output.results[*].output.a',
        'steps.s1.output.results[*].output.attachments',
        'trigger.output.attachments[0].data',
        'trigger.output.body["content-type"]',
        'trigger.output["Order date"]',
        "loop.row['Due date']",
        'loop.row["e-mail"]',
        'steps.http1.output.body["content-type"]',
    ]) {
        const before = walkPath(p, STATE);
        assert.notStrictEqual(before, undefined, `fixture: ${p} must resolve`);
        const r = pathOf(p);
        assert.strictEqual(r.path, p, p);
        assert.strictEqual(r.error, null, p);
        assert.deepStrictEqual(r.repairs, [], p);
        assert.deepStrictEqual(walkPath(r.path, STATE), before, p);
    }
});

test('the mangled forms are repaired into the spelling the runtime reads', () => {
    const cases = [
        ['$steps.s1.output.items[0].subject', 'steps.s1.output.items[0].subject'],
        ['steps[s1].output[items][0].subject', 'steps.s1.output.items[0].subject'],
        ['.steps.s1.output.items', 'steps.s1.output.items'],
        [' steps . s1 . output . items ', 'steps.s1.output.items'],
        ['{{steps.s1.output.items}}', 'steps.s1.output.items'],
        ['steps.s1.output.items.0.subject', 'steps.s1.output.items[0].subject'],
        ['trigger.output.attachments.0.data', 'trigger.output.attachments[0].data'],
        ['trigger.output.body.content-type', 'trigger.output.body["content-type"]'],
    ];
    for (const [raw, want] of cases) {
        const r = pathOf(raw);
        assert.strictEqual(r.path, want, raw);
        assert.strictEqual(r.error, null, raw);
        assert.notStrictEqual(walkPath(r.path, STATE), undefined, `${raw} → ${r.path} reads a value`);
    }
    // The spelling repair is named, so the model learns [0]; the old silent
    // transforms ($, leading dot, whitespace, steps[x]) stay silent.
    assert.match(pathOf('steps.s1.output.items.0.subject').repairs.join(' '), /read as "steps\.s1\.output\.items\[0\]\.subject" — write an index as \[0\]/);
    assert.deepStrictEqual(pathOf('$steps.s1.output.items').repairs, []);
});

test('JSON debris after a path is cut off and named', () => {
    const r = pathOf('loop.row.e\\"}}}},tempId:');
    assert.strictEqual(r.path, 'loop.row.e');
    assert.match(r.repairs.join(' '), /carried JSON debris after the real path — read as "loop\.row\.e"/);
});

test('a path that is broken in a way nobody can guess is refused, not stored', () => {
    const r = pathOf('steps.s1.output.items[0');
    assert.match(r.error, /is not a path the runtime can read/);
});

test('trigger.<field> gets its .output, at any depth', () => {
    assert.strictEqual(pathOf('trigger.subject').path, 'trigger.output.subject');
    assert.strictEqual(pathOf('trigger.attachments[0].filename').path, 'trigger.output.attachments[0].filename');
    assert.strictEqual(pathOf('trigger.kind').path, 'trigger.kind', 'run metadata is a real reading of trigger.<key>');
    assert.strictEqual(pathOf('subject').path, 'trigger.output.subject');
});

test('repairRefPath keeps a canonical path byte for byte', () => {
    for (const p of ['steps.s1.output.items[0].subject', 'steps.$tmp.output', 'trigger.output["a b"]', 'vars.rate']) {
        assert.deepStrictEqual(repairRefPath(p), { path: p, debris: '' });
    }
});

test('a literal object with a path key stays a literal; only a lone {path} that reads as a ref is one', () => {
    const r = validateAndFixBindings({
        file: { path: '/Invoices/a.pdf', name: 'a.pdf' },
        files: [{ path: '/a.pdf', name: 'a' }, { path: '/b.pdf', name: 'b' }],
        folder: { path: 'Invoices/2026' },
        q: { path: 'steps.s1.output.items[0].subject' },
        bare: { path: 'subject' },
    }, GMAIL);
    assert.strictEqual(r.error, null, r.error);
    assert.deepStrictEqual(r.inputs.file, { kind: 'literal', value: { path: '/Invoices/a.pdf', name: 'a.pdf' } });
    assert.deepStrictEqual(r.inputs.files, { kind: 'literal', value: [{ path: '/a.pdf', name: 'a' }, { path: '/b.pdf', name: 'b' }] });
    assert.deepStrictEqual(r.inputs.folder, { kind: 'literal', value: { path: 'Invoices/2026' } });
    assert.deepStrictEqual(r.inputs.q, { kind: 'ref', path: 'steps.s1.output.items[0].subject' });
    assert.deepStrictEqual(r.inputs.bare, { kind: 'ref', path: 'trigger.output.subject' });
});

test('a lone {path} that is not a ref and not a file path is refused, not sent as an object', () => {
    // A manual trigger declares no fields, so 'subject' names nothing. Kept as
    // a literal, the tool would get the object {path:'subject'} as its `to`.
    const manual = { trigger: { kind: 'manual' } };
    for (const [path, msg] of [
        ['subject', /has unknown root "subject"/],
        ['step.x.output.y', /has unknown root "step"/],
        ['steps.a.output.items[0', /is not a path the runtime can read/],
    ]) {
        const r = validateAndFixBindings({ to: { path } }, manual);
        assert.match(r.error || '', msg, path);
        assert.strictEqual(r.inputs.to.kind, 'ref', path);
    }
    assert.match(validateAndFixBindings({ to: { path: 'subject' } }, manual).error, /send it as \{kind:"literal"/);
    // Inside a map or a list the same attempt is checked member by member.
    const nested = validateAndFixBindings({ values: { a: { path: 'subject' }, b: { kind: 'literal', value: 1 } } }, manual);
    assert.match(nested.error || '', /inputs\.values\.a: ref path "subject" has unknown root/);
});

test('trigger.<key> that is both run metadata and a declared payload field reads the payload', () => {
    // google-sheets spreadsheet.new declares `id`, nextcloud file.new `kind`,
    // approval.requested `source`: left alone these read the trigger node's
    // id, 'app_event' and the trigger's source instead.
    const sheets = { trigger: { kind: 'app_event', appEvent: { provider: 'google-sheets', event: 'spreadsheet.new' } } };
    const nextcloud = { trigger: { kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'file.new' } } };
    const approvals = { trigger: { kind: 'app_event', appEvent: { provider: 'approvals', event: 'approval.requested' } } };
    assert.strictEqual(pathOf('trigger.id', sheets).path, 'trigger.output.id');
    assert.strictEqual(pathOf('trigger.kind', nextcloud).path, 'trigger.output.kind');
    assert.strictEqual(pathOf('trigger.source', approvals).path, 'trigger.output.source');
    const state = { trigger: { id: 'trg', kind: 'app_event', output: { id: 'sheet-1', kind: 'file' } } };
    assert.strictEqual(walkPath(pathOf('trigger.id', sheets).path, state), 'sheet-1');
    assert.strictEqual(walkPath(pathOf('trigger.kind', nextcloud).path, state), 'file');
    // A metadata key the payload does not declare is metadata, and output stays output.
    assert.strictEqual(pathOf('trigger.kind', sheets).path, 'trigger.kind');
    assert.strictEqual(pathOf('trigger.output.id', sheets).path, 'trigger.output.id');
});

test('template placeholders get the same spelling repair, and only when the whole placeholder is a path', () => {
    const r = validateAndFixBindings({ t: { kind: 'template', value: 'A {{steps.s1.output.items.0.subject}} B {{steps.s1.output.items[0].subject}} C {{steps.s1.output.n + 1}}' } }, GMAIL);
    assert.strictEqual(r.inputs.t.value, 'A {{steps.s1.output.items[0].subject}} B {{steps.s1.output.items[0].subject}} C {{steps.s1.output.n + 1}}');
});

test('forEach.overRef keeps its [*] flatten', () => {
    const { forEach, error } = sanitizeForEach({ overRef: 'steps.s1.output.results[*].output.attachments', itemVar: 'att' }, GMAIL);
    assert.strictEqual(error, undefined);
    assert.strictEqual(forEach.overRef, 'steps.s1.output.results[*].output.attachments');
    assert.deepStrictEqual(walkPath(forEach.overRef, STATE), [{ n: 1 }, { n: 2 }]);
    assert.strictEqual(sanitizeForEach({ overRef: 'steps.s1.output.results.0.output.attachments' }, GMAIL).forEach.overRef,
        'steps.s1.output.results[0].output.attachments');
});

function wrap() {
    return { userId: 'u_test', def: emptyDefinition(), _inspectedTools: new Set(['nextcloud_list_files', 'nextcloud_read_file', 'nextcloud_upload_file']) };
}

test('an AI edit of one input leaves the other bindings of the step as they were', async () => {
    const dw = wrap();
    const list = (await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices' } } }, dw)).added;
    const up = (await applyToolCall('builder_add_action', { tool: 'nextcloud_upload_file', inputs: { path: { kind: 'literal', value: '/x.txt' } } }, dw)).added;
    // What the user mapped by hand, in the editor's own spelling; and one
    // binding a model or an import left behind with an unknown root.
    const step = dw.def.steps.find(s => s.id === up.id);
    step.inputs.content = { kind: 'ref', path: `steps.${list.id}.output.items[0]["file name"]` };
    step.inputs.contentType = { kind: 'ref', path: `steps.${list.id}.output.items[*].mime` };
    step.inputs.legacy = { kind: 'ref', path: 'nope.field' };

    const r = await applyToolCall('builder_update_step', { stepId: up.id, patch: { inputs: { path: { kind: 'literal', value: '/y.txt' } } } }, dw);
    assert.ok(!r.error, r.error);
    const after = dw.def.steps.find(s => s.id === up.id).inputs;
    assert.deepStrictEqual(after.path, { kind: 'literal', value: '/y.txt' });
    assert.deepStrictEqual(after.content, { kind: 'ref', path: `steps.${list.id}.output.items[0]["file name"]` });
    assert.deepStrictEqual(after.contentType, { kind: 'ref', path: `steps.${list.id}.output.items[*].mime` });
    assert.deepStrictEqual(after.legacy, { kind: 'ref', path: 'nope.field' }, 'a key the patch does not send is neither rewritten nor a reason to refuse it');

    // The keys the patch DOES send are still checked and repaired.
    const bad = await applyToolCall('builder_update_step', { stepId: up.id, patch: { inputs: { path: { kind: 'ref', path: 'nope.x' } } } }, dw);
    assert.match(bad.error, /unknown root "nope"/);
    const fixed = await applyToolCall('builder_update_step', { stepId: up.id, patch: { inputs: { path: { kind: 'ref', path: `steps.${list.id}.output.items.0.path` } } } }, dw);
    assert.ok(!fixed.error, fixed.error);
    assert.strictEqual(dw.def.steps.find(s => s.id === up.id).inputs.path.path, `steps.${list.id}.output.items[0].path`);

    // null still deletes a key in merge mode.
    await applyToolCall('builder_update_step', { stepId: up.id, patch: { inputs: { legacy: null } } }, dw);
    assert.ok(!('legacy' in dw.def.steps.find(s => s.id === up.id).inputs));
});

test('a set step stores its list (arrayRef) the way the check repaired it', async () => {
    const dw = wrap();
    const list = (await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices' } } }, dw)).added;
    const r = await applyToolCall('builder_add_set', { arrayRef: `$steps.${list.id}.output.items`, fields: { n: { kind: 'expr', value: 'item.name' } } }, dw);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.added.arrayRef, `steps.${list.id}.output.items`);
    const u = await applyToolCall('builder_update_step', { stepId: r.added.id, patch: { arrayRef: `steps.${list.id}.output.results.0.items` } }, dw);
    assert.ok(!u.error, u.error);
    assert.strictEqual(dw.def.steps.find(s => s.id === r.added.id).arrayRef, `steps.${list.id}.output.results[0].items`);
});

test('an ai_step input named after a data root is refused where the model can rename it', async () => {
    const dw = wrap();
    const r = await applyToolCall('builder_add_ai_step', { prompt: 'S={{trigger.output.subject}}', inputs: { trigger: { kind: 'literal', value: 'x' } } }, dw);
    assert.match(r.error || '', /cannot be named "trigger"/);
    const ok = await applyToolCall('builder_add_ai_step', { prompt: 'S={{trigger.output.subject}}', inputs: { triggerData: { kind: 'literal', value: 'x' } } }, dw);
    assert.ok(!ok.error, ok.error);
    const u = await applyToolCall('builder_update_step', { stepId: ok.added.id, patch: { inputs: { steps: { kind: 'literal', value: 'y' } } } }, dw);
    assert.match(u.error || '', /cannot be named "steps"/);
});

// ── v2 picks (M2): accepted and spelled the one stored way; not yet written
// by the builder prompt, but a definition is data, and an import or an MCP
// patch can carry them.

test('a compact pick is expanded to the stored form', () => {
    const { inputs: fixed, error } = validateAndFixBindings({ to: { pick: 'steps.get.output.rows[*].email', take: 'all' } }, emptyDefinition());
    assert.equal(error, null);
    assert.deepStrictEqual(fixed.to, { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['rows', 'email'] }, take: 'all', as: 'native', label: 'Email' });
});

test('a stored pick and a compose pass through', () => {
    const pick = { kind: 'pick', v: 1, from: { root: 'trigger', path: ['naam'] }, take: 'one', as: 'text', label: 'Naam' };
    const compose = { kind: 'compose', v: 1, parts: ['Hoi ', { pick: 'trigger.output.naam' }] };
    const { inputs: fixed, error } = validateAndFixBindings({ a: pick, b: compose }, emptyDefinition());
    assert.equal(error, null);
    assert.deepStrictEqual(fixed.a, pick);
    assert.deepStrictEqual(fixed.b, { kind: 'compose', v: 1, parts: ['Hoi ', { from: { root: 'trigger', path: ['naam'] }, take: 'one', as: 'text', label: 'Naam' }] });
});

// The compact forms are what the model is taught (M5): expanding them is no
// repair, so nothing is said about it.
test('the compact form is stamped with the version, and no repair is named for it', () => {
    const { inputs: fixed, repairs } = validateAndFixBindings({ to: { pick: 'trigger.output.naam' }, body: { compose: ['Hoi ', { pick: 'trigger.output.naam' }] } }, emptyDefinition());
    assert.equal(fixed.to.v, 1);
    assert.deepStrictEqual(fixed.body, { kind: 'compose', v: 1, parts: ['Hoi ', { from: { root: 'trigger', path: ['naam'] }, take: 'one', as: 'text', label: 'Naam' }] });
    assert.equal(repairs, undefined);
});

// resolve.mjs reads a pick or a compose only when v === 1; without it the
// object is data. The builder must not make it live behind the author's back.
test('a pick or a compose without v is refused, not given the version', () => {
    const { inputs: fixed, error } = validateAndFixBindings({
        b: { kind: 'pick', from: { root: 'steps', id: 's1', path: ['x'] }, take: 'one', as: 'native' },
        c: { kind: 'compose', parts: ['Hoi'] },
    }, emptyDefinition());
    assert.equal(fixed.b.v, undefined);
    assert.equal(fixed.c.v, undefined);
    assert.match(error, /inputs\.b: the pick binding is not valid \(pick_version\)/);
    assert.match(error, /inputs\.c: the compose binding is not valid \(compose_version\)/);
});

test('a compact pick whose path does not read is refused, not sent to the tool as an object', () => {
    for (const raw of [{ pick: 'subject', take: 'all' }, { pick: 'step.x.output.y' }]) {
        const { inputs: fixed, error } = validateAndFixBindings({ a: raw }, emptyDefinition());
        assert.equal(fixed.a.kind, 'pick');
        assert.match(error || '', /^inputs\.a: the pick binding is not valid \(source_shape\)\. The path "[^"]+" is not one the runtime can read/);
    }
    const nested = validateAndFixBindings({ values: { Naam: { pick: 'subject' } } }, emptyDefinition());
    assert.match(nested.error || '', /inputs\.values\.Naam: the pick binding is not valid/);
});

test('an invalid pick is refused with the shape to use, not stored as a literal', () => {
    const { inputs: fixed, error } = validateAndFixBindings({ a: { kind: 'pick', v: 1, from: { root: 'steps', path: [] }, take: 'some', as: 'native' } }, emptyDefinition());
    assert.equal(fixed.a.kind, 'pick');
    assert.match(error, /^inputs\.a: the pick binding is not valid \(source_id, pick_take\)/);
});

test('a map of picks is resolved member by member, not frozen as one literal', () => {
    const { inputs: fixed } = validateAndFixBindings({ values: { Naam: { pick: 'trigger.output.naam' }, Vast: 'x' } }, emptyDefinition());
    assert.equal(fixed.values.kind, undefined);
    assert.equal(fixed.values.Naam.kind, 'pick');
    assert.deepStrictEqual(fixed.values.Vast, { kind: 'literal', value: 'x' });
});
