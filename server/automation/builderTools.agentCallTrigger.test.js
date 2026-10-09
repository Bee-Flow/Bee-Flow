/**
 * Authoring the declared-input triggers through the REAL builder tools:
 * agent_call (tool name, description, arguments), form fields and app_trigger
 * params — written by builder_propose_trigger, edited in place by
 * builder_update_trigger, and visible afterwards to the ref checks, the
 * bare-name repair and the draft state the model reads back.
 *
 * Before this the builder dropped every agent_call field on the floor, could
 * not patch a form or an app trigger, lost an app_pick field's `source`, and
 * checked nothing against the inputs an author had declared.
 *
 * Run: node --test automation/builderTools.agentCallTrigger.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition, TOOL_SCHEMAS } = require('./builderTools');
const { triggerFieldsFor, declaredTriggerFields, buildTriggerOutputsCatalog } = require('./builderTools/triggerCatalog');
const { fieldsAtRef } = require('./builderTools/outputFields');
const { renderAgentDraftState, summariseDefinition } = require('./summarise');
const { validateDefinition } = require('./validate');
const { automationToTool } = require('./agentCallableTools');

const freshWrap = () => ({ userId: 'u_test', def: emptyDefinition() });
const call = (dw, name, args) => applyToolCall(name, args, dw);
const ref = (path) => ({ kind: 'ref', path });
const codesOf = (res) => (res.errors || []).concat(res.warnings || []).map(r => r.code);

const WARRANTY = {
    kind: 'agent_call',
    toolName: 'lookup_warranty',
    description: 'Look up the warranty of a device by serial number.',
    params: [
        { name: 'serial_number', type: 'string', required: true, description: 'The serial number on the device' },
        { name: 'include_history', type: 'boolean' },
    ],
};

async function warrantyDraft() {
    const dw = freshWrap();
    const r = await call(dw, 'builder_propose_trigger', WARRANTY);
    assert.ok(!r.error, r.error);
    return dw;
}

// ── builder_propose_trigger: agent_call ─────────────────────────────────────

test('propose agent_call from a params list writes toolName, description and the editor-shaped schema', async () => {
    const dw = freshWrap();
    const r = await call(dw, 'builder_propose_trigger', WARRANTY);
    assert.deepStrictEqual(r.trigger, {
        id: 'trg', type: 'trigger', kind: 'agent_call', output: {},
        toolName: 'lookup_warranty',
        description: 'Look up the warranty of a device by serial number.',
        parametersSchema: {
            type: 'object',
            properties: {
                serial_number: { type: 'string', description: 'The serial number on the device' },
                include_history: { type: 'boolean' },
            },
            required: ['serial_number'],
            additionalProperties: false,
        },
    });
    assert.strictEqual(r._warnings, undefined, 'a complete declaration raises nothing');
    assert.deepStrictEqual(r.outputPaths, ['trigger.output.serial_number', 'trigger.output.include_history']);
    assert.match(r.next, /"Who can call this"/);
    assert.match(r.next, /the builder cannot/);
});

test('propose agent_call from a JSON Schema reaches the same stored shape', async () => {
    const a = freshWrap();
    const b = freshWrap();
    await call(a, 'builder_propose_trigger', WARRANTY);
    await call(b, 'builder_propose_trigger', {
        kind: 'agent_call',
        toolName: WARRANTY.toolName,
        description: WARRANTY.description,
        parametersSchema: {
            type: 'object',
            properties: { serial_number: { type: 'string', description: 'The serial number on the device' }, include_history: { type: 'boolean' } },
            required: ['serial_number'],
        },
    });
    assert.deepStrictEqual(b.def.trigger, a.def.trigger);
});

test('the tool name is sanitised and the rewrite is said; the stored automation becomes the tool the agent sees', async () => {
    const dw = freshWrap();
    const r = await call(dw, 'builder_propose_trigger', { ...WARRANTY, toolName: 'Lookup Warranty!' });
    assert.strictEqual(r.trigger.toolName, 'lookup_warranty');
    assert.match(r._warnings.join(' '), /"Lookup Warranty!" was written as "lookup_warranty"/);

    const tool = automationToTool({ id: 'a1', userId: 'u1', title: 'Warranty', definition: dw.def });
    assert.strictEqual(tool.function.name, 'lookup_warranty');
    assert.strictEqual(tool.function.description, WARRANTY.description);
    assert.deepStrictEqual(tool.function.parameters, r.trigger.parametersSchema);
});

test('a bare agent_call is accepted but the result says what is missing', async () => {
    const dw = freshWrap();
    const r = await call(dw, 'builder_propose_trigger', { kind: 'agent_call' });
    assert.ok(!r.error);
    const text = r._warnings.join(' | ');
    assert.match(text, /no arguments are declared/);
    assert.match(text, /no description/);
    assert.strictEqual(r.trigger.parametersSchema, undefined, 'nothing invented');
});

test('names that are not identifiers are reported at once, not only at activation', async () => {
    const dw = freshWrap();
    const r = await call(dw, 'builder_propose_trigger', { ...WARRANTY, params: [{ name: 'serial number', type: 'string' }] });
    assert.match(r._warnings.join(' '), /Argument name "serial number" is invalid/);
    assert.deepStrictEqual(r.outputPaths, undefined, 'a name a path cannot address is not offered');
});

// ── Re-proposing a trigger ──────────────────────────────────────────────────

test('re-proposing a trigger of ANOTHER kind starts clean', async () => {
    const dw = await warrantyDraft();
    dw.def.trigger.label = 'Warranty tool';
    dw.def.trigger.position = { x: 10, y: 20 };
    dw.def.trigger.pinnedOutput = { serial_number: 'X' };
    const r = await call(dw, 'builder_propose_trigger', { kind: 'manual' });
    assert.deepStrictEqual(r.trigger, { id: 'trg', type: 'trigger', kind: 'manual', output: {} });
});

test('re-proposing the SAME kind keeps what the person set on the canvas', async () => {
    const dw = await warrantyDraft();
    dw.def.trigger.label = 'Warranty tool';
    dw.def.trigger.position = { x: 10, y: 20 };
    dw.def.trigger.pinnedOutput = { serial_number: 'X' };
    const r = await call(dw, 'builder_propose_trigger', { ...WARRANTY, description: 'Changed.' });
    assert.strictEqual(r.trigger.description, 'Changed.');
    assert.strictEqual(r.trigger.label, 'Warranty tool');
    assert.deepStrictEqual(r.trigger.position, { x: 10, y: 20 });
    assert.deepStrictEqual(r.trigger.pinnedOutput, { serial_number: 'X' });
});

test('an app_event that names another event drops the pinned sample of the old one', async () => {
    const dw = freshWrap();
    await call(dw, 'builder_propose_trigger', { kind: 'app_event', appProvider: 'gmail', appEvent: 'mail.new' });
    dw.def.trigger.pinnedOutput = { subject: 'old' };
    dw.def.trigger.label = 'Mail';
    let r = await call(dw, 'builder_propose_trigger', { kind: 'app_event', appProvider: 'gmail', appEvent: 'mail.new', filter: { hasAttachment: true } });
    assert.deepStrictEqual(r.trigger.pinnedOutput, { subject: 'old' });
    r = await call(dw, 'builder_propose_trigger', { kind: 'app_event', appProvider: 'gmail', appEvent: 'label.added' });
    assert.strictEqual(r.trigger.pinnedOutput, undefined);
    assert.strictEqual(r.trigger.label, 'Mail');
});

test('an app_trigger keeps its appRef when it is re-proposed', async () => {
    const dw = freshWrap();
    await call(dw, 'builder_propose_trigger', { kind: 'app_trigger', params: [{ name: 'q', type: 'string' }] });
    const appRef = { appId: 'app-1', screenId: 'scr_abc123', nodeId: 'act_abc123' };
    dw.def.trigger.appRef = appRef;
    const r = await call(dw, 'builder_propose_trigger', { kind: 'app_trigger', params: [{ name: 'q', type: 'string' }, { name: 'n', type: 'number' }] });
    assert.deepStrictEqual(r.trigger.appRef, appRef);
    assert.strictEqual(r.trigger.params.length, 2);
});

// ── builder_update_trigger ──────────────────────────────────────────────────

test('update_trigger patches an agent_call in place: only the named keys change, label and edges stay', async () => {
    const dw = await warrantyDraft();
    await call(dw, 'builder_set_metadata', { title: 'Warranty', description: 'x' });
    await call(dw, 'builder_add_set', { fields: { sn: ref('trigger.output.serial_number') } });
    const edgesBefore = JSON.stringify(dw.def.edges);

    let r = await call(dw, 'builder_update_trigger', { triggerId: 'trg', patch: { label: 'Warranty tool', description: 'Now better.' } });
    assert.deepStrictEqual(r.changed, ['label', 'description']);
    assert.strictEqual(dw.def.trigger.description, 'Now better.');
    assert.strictEqual(dw.def.trigger.toolName, 'lookup_warranty', 'untouched');
    assert.ok(dw.def.trigger.parametersSchema.properties.serial_number, 'untouched');

    r = await call(dw, 'builder_update_trigger', { triggerId: 'trg', patch: { params: [{ name: 'serial_number', type: 'string', required: true }, { name: 'country', type: 'string', description: 'ISO code' }] } });
    assert.deepStrictEqual(r.changed, ['parametersSchema']);
    assert.deepStrictEqual(Object.keys(dw.def.trigger.parametersSchema.properties), ['serial_number', 'country']);
    assert.deepStrictEqual(r.outputPaths, ['trigger.output.serial_number', 'trigger.output.country']);
    assert.strictEqual(JSON.stringify(dw.def.edges), edgesBefore);
    assert.strictEqual(dw.def.trigger.label, 'Warranty tool');
});

test('update_trigger accepts a JSON Schema, can clear the tool name, and reports keys it does not know', async () => {
    const dw = await warrantyDraft();
    const r = await call(dw, 'builder_update_trigger', { triggerId: 'trg', patch: { toolName: '', parametersSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }, cron: '* * * * *' } });
    assert.deepStrictEqual(r.changed, ['toolName', 'parametersSchema']);
    assert.strictEqual(dw.def.trigger.toolName, undefined, 'back to automation_<id>');
    assert.deepStrictEqual(dw.def.trigger.parametersSchema.properties, { id: { type: 'number' } });
    assert.match(r._warnings.join(' '), /ignored patch keys for a agent_call trigger: cron/);
});

test('update_trigger replaces a form\'s fields and keeps its other keys; an app_pick source survives', async () => {
    const dw = freshWrap();
    await call(dw, 'builder_propose_trigger', { kind: 'form', form: { title: 'Intake', submitLabel: 'Send', fields: [{ name: 'name', type: 'text', label: 'Name' }] } });
    const r = await call(dw, 'builder_update_trigger', {
        triggerId: 'trg',
        patch: { form: { fields: [
            { name: 'name', type: 'text', label: 'Name', required: true },
            { name: 'meeting', type: 'app_pick', label: 'Meeting', source: 'meeting_note', multiple: true, maxItems: 3, withText: false },
        ] } },
    });
    assert.deepStrictEqual(r.changed, ['form.fields']);
    assert.strictEqual(dw.def.trigger.form.title, 'Intake');
    assert.strictEqual(dw.def.trigger.form.submitLabel, 'Send');
    assert.deepStrictEqual(dw.def.trigger.form.fields[1], {
        name: 'meeting', type: 'app_pick', label: 'Meeting', required: false,
        source: 'meeting_note', multiple: true, maxItems: 3, withText: false,
    });
    assert.ok(!codesOf(validateDefinition(dw.def, { stage: 'draft' })).includes('form.field_pick_no_source'));
});

test('update_trigger replaces an app_trigger\'s params, and refuses a non-list without touching them', async () => {
    const dw = freshWrap();
    await call(dw, 'builder_propose_trigger', { kind: 'app_trigger', params: [{ name: 'q', type: 'string' }] });
    let r = await call(dw, 'builder_update_trigger', { triggerId: 'trg', patch: { params: 'q' } });
    assert.deepStrictEqual(r.changed, []);
    assert.match(r._warnings.join(' '), /must be a list/);
    assert.strictEqual(dw.def.trigger.params.length, 1);
    r = await call(dw, 'builder_update_trigger', { triggerId: 'trg', patch: { params: [{ name: 'q', type: 'string', required: true }, { name: 'doc', type: 'file' }] } });
    assert.deepStrictEqual(r.changed, ['params']);
    assert.deepStrictEqual(dw.def.trigger.params.map(p => p.name), ['q', 'doc']);
});

// ── Form sanitiser (B2) ─────────────────────────────────────────────────────

test('an app_pick form field keeps source, multiple, maxItems and withText through propose_trigger', async () => {
    const dw = freshWrap();
    const r = await call(dw, 'builder_propose_trigger', {
        kind: 'form',
        form: { title: 'Notes', collect: true, fields: [
            { name: 'transcript', type: 'app_pick', label: 'Transcript', required: true, source: 'gmail_message', multiple: true, maxItems: 5, withText: true },
            { name: 'plain', type: 'text', label: 'Plain', source: 'ignored', multiple: true },
        ] },
    });
    const [pick, plain] = r.trigger.form.fields;
    assert.deepStrictEqual(pick, { name: 'transcript', type: 'app_pick', label: 'Transcript', required: true, source: 'gmail_message', multiple: true, maxItems: 5, withText: true });
    assert.ok(!('source' in plain) && !('multiple' in plain), 'a stray source on a text field is not stored');
    assert.strictEqual(r.trigger.form.collect, true);
    assert.ok(!codesOf(validateDefinition(dw.def, { stage: 'draft' })).includes('form.field_pick_no_source'));
});

// ── Declared inputs are visible to the ref checks and the model ─────────────

test('declaredTriggerFields: agent_call, form and app_trigger; not display fields or unaddressable names', () => {
    assert.deepStrictEqual(declaredTriggerFields({ kind: 'agent_call', parametersSchema: { type: 'object', properties: { a: { type: 'integer' }, 'b c': { type: 'string' } } } }),
        [{ name: 'a', type: 'number' }]);
    assert.deepStrictEqual(declaredTriggerFields({ kind: 'app_trigger', params: [{ name: 'q', type: 'string' }, { name: 'doc', type: 'file' }, { name: '_x', type: 'string' }] }),
        [{ name: 'q', type: 'string' }, { name: 'doc', type: 'file' }]);
    assert.deepStrictEqual(declaredTriggerFields({ kind: 'form', form: { fields: [
        { name: 'age', type: 'number' }, { name: 'ok', type: 'checkbox' }, { name: 'cv', type: 'file' },
        { name: 'pick', type: 'app_pick', multiple: true }, { name: 'btn', type: 'download' }, { name: 'mail', type: 'email' },
    ] } }), [
        { name: 'age', type: 'number' }, { name: 'ok', type: 'boolean' }, { name: 'cv', type: 'file' },
        { name: 'pick', type: 'array' }, { name: 'mail', type: 'string' },
    ]);
    assert.deepStrictEqual(declaredTriggerFields({ kind: 'webhook' }), []);
});

test('bare names are re-rooted to trigger.output.<name> for agent_call, form and app_trigger', async () => {
    const agent = await warrantyDraft();
    assert.deepStrictEqual(triggerFieldsFor(agent.def), ['serial_number', 'include_history']);
    const r = await call(agent, 'builder_add_set', { fields: { sn: ref('serial_number') } });
    assert.ok(!r.error, r.error);
    assert.strictEqual(agent.def.steps[0].fields.sn.path, 'trigger.output.serial_number');

    const form = freshWrap();
    await call(form, 'builder_propose_trigger', { kind: 'form', form: { title: 'F', fields: [{ name: 'email', type: 'email', label: 'Mail' }] } });
    assert.deepStrictEqual(triggerFieldsFor(form.def), ['email']);

    const app = freshWrap();
    await call(app, 'builder_propose_trigger', { kind: 'app_trigger', params: [{ name: 'q', type: 'string' }] });
    assert.deepStrictEqual(triggerFieldsFor(app.def), ['q']);
});

test('a misspelled agent argument is caught at add time with a did-you-mean, a correct one passes silently', async () => {
    const dw = await warrantyDraft();
    const bad = await call(dw, 'builder_add_set', { fields: { sn: ref('trigger.output.serial_numbr') } });
    const text = JSON.stringify(bad._warnings || bad.error);
    assert.match(text, /serial_numbr/);
    assert.match(text, /Did you mean trigger\.output\.serial_number/);
    const ok = await call(dw, 'builder_add_set', { fields: { sn: ref('trigger.output.serial_number') } });
    assert.strictEqual(ok._warnings, undefined);
});

test('a trigger that declares nothing yet checks nothing', async () => {
    const dw = freshWrap();
    await call(dw, 'builder_propose_trigger', { kind: 'agent_call' });
    const r = await call(dw, 'builder_add_set', { fields: { x: ref('trigger.output.whatever') } });
    assert.strictEqual(r._warnings, undefined);
});

test('the fields at trigger.output are the declared inputs', async () => {
    const dw = await warrantyDraft();
    const r = fieldsAtRef(dw.def, 'trigger.output');
    assert.deepStrictEqual(r.fields, ['serial_number', 'include_history']);
    assert.strictEqual(r.source, 'trigger');
});

test('the draft state and the summary list the declared inputs and where they bind', async () => {
    const dw = await warrantyDraft();
    const state = renderAgentDraftState(dw.def);
    assert.match(state, /trigger:agent_call {2}tool: lookup_warranty {2}inputs: serial_number, include_history {2}\(bind as trigger\.output\.<name>\)/);
    assert.match(summariseDefinition(dw.def).summary, /`lookup_warranty`, arguments: serial_number, include_history\?/);
});

test('the picker catalog has an agent_call entry, so it no longer falls back to the manual trigger\'s `now`', () => {
    const entry = buildTriggerOutputsCatalog().__agent_call;
    assert.ok(entry);
    assert.deepStrictEqual(entry.fields, []);
    assert.match(entry.note, /trigger\.output\.<argumentName>/);
});

// ── Save-time validation ────────────────────────────────────────────────────

test('a complete builder-made agent_call validates clean at every stage', async () => {
    const dw = await warrantyDraft();
    await call(dw, 'builder_add_set', { fields: { sn: ref('trigger.output.serial_number') } });
    for (const stage of ['draft', 'activate']) {
        const res = validateDefinition(dw.def, { stage });
        assert.deepStrictEqual(codesOf(res).filter(c => c.startsWith('agent_call.')), [], stage);
    }
});

test('a missing or long description only warns, at every stage; a tool name nobody can read blocks activation only; shape errors block both', async () => {
    const dw = freshWrap();
    await call(dw, 'builder_propose_trigger', { kind: 'agent_call', toolName: 'x', params: [{ name: 'a', type: 'string' }] });
    await call(dw, 'builder_add_set', { fields: { a: ref('trigger.output.a') } });
    for (const stage of ['draft', 'activate']) {
        const res = validateDefinition(dw.def, { stage });
        assert.ok((res.warnings || []).some(w => w.code === 'agent_call.description_missing' && !w.blockedAt), `${stage}: a plain warning`);
        assert.ok(!(res.errors || []).some(e => e.code.startsWith('agent_call.')), `${stage}: no error`);
    }

    // The canvas stores a blank description as null and a long one as typed; both still save, go live and restore.
    dw.def.trigger.description = null;
    assert.ok(validateDefinition(dw.def, { stage: 'activate' }).ok);
    dw.def.trigger.description = 'x'.repeat(1200);
    for (const stage of ['draft', 'activate']) {
        const res = validateDefinition(dw.def, { stage });
        assert.ok(res.ok, `${stage}: a 1200-character description is saveable`);
        assert.ok((res.warnings || []).some(w => w.code === 'agent_call.description_invalid'));
    }

    dw.def.trigger.description = 'ok';
    dw.def.trigger.toolName = '!!!';
    const draftName = validateDefinition(dw.def, { stage: 'draft' });
    assert.ok(draftName.ok);
    assert.ok((draftName.warnings || []).some(w => w.code === 'agent_call.tool_name' && w.blockedAt === 'activate'));
    assert.ok((validateDefinition(dw.def, { stage: 'activate' }).errors || []).some(e => e.code === 'agent_call.tool_name'));

    dw.def.trigger.toolName = 'x';
    dw.def.trigger.parametersSchema = { type: 'object', properties: { a: { type: 'string' } }, required: ['zzz'] };
    const broken = validateDefinition(dw.def, { stage: 'draft' });
    assert.ok((broken.errors || []).some(e => e.code === 'agent_call.required_unknown'));
});

// ── The words the model reads ───────────────────────────────────────────────

test('the tool descriptions teach agent_call, trigger.output.<name> and the linking step', () => {
    const fn = (n) => TOOL_SCHEMAS.find(t => t.function.name === n).function;
    const propose = fn('builder_propose_trigger');
    assert.match(propose.description, /agent_call\s+— the automation becomes a TOOL/);
    assert.match(propose.description, /app_trigger\s+— fired by/);
    assert.match(propose.description, /trigger\.output\.<name> — there is no trigger\.payload/);
    assert.match(propose.description, /"Who can call this"/);
    for (const key of ['toolName', 'description', 'parametersSchema', 'params']) assert.ok(propose.parameters.properties[key], `${key} advertised`);
    const update = fn('builder_update_trigger');
    assert.match(update.description, /agent_call\\?'s toolName\/description\/params|agent_call's toolName\/description\/params/);
    assert.match(update.parameters.properties.patch.description, /form \(form: any of title/);
});
