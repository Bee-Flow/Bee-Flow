/**
 * builder_add_trigger / builder_update_trigger / builder_remove_step on a
 * trigger — the AI/MCP builder's way to give an automation several entry points.
 *
 * Pins: a secondary trigger gets its own id and the same node shape as a
 * primary of that kind; only webhook / app_event / schedule may be secondary;
 * steps wire from a trigger id; the collision check knows trigger ids; the
 * summaries mention every root; a dry run can enter through a chosen root;
 * removal reports orphans and refuses the primary.
 *
 * Run: node --test automation/builderTools.triggers.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    applyToolCall, emptyDefinition, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, TOOL_SCHEMAS,
} = require('./builderTools');
const { buildTriggerNode } = require('./builderTools/triggers');
const { triggerFieldsFor } = require('./builderTools/triggerCatalog');
const { summariseDefinition, renderAgentDraftState } = require('./summarise');
const { validateDefinition } = require('./validate');

const lit = (value) => ({ kind: 'literal', value });
const freshWrap = () => ({ userId: 'u_test', def: emptyDefinition() });
const call = (dw, name, args) => applyToolCall(name, args, dw);
const edges = (dw) => dw.def.edges.map(e => `${e.from}>${e.to}${e.label ? ':' + e.label : ''}`).sort();

async function withGmailPrimary() {
    const dw = freshWrap();
    const r = await call(dw, 'builder_propose_trigger', { kind: 'app_event', appProvider: 'gmail', appEvent: 'mail.new', filter: { excludeFromSelf: true } });
    assert.ok(!r.error, r.error);
    return dw;
}

test('the tools are advertised, write, and are root-only', () => {
    for (const name of ['builder_add_trigger', 'builder_update_trigger']) {
        assert.ok(TOOL_SCHEMAS.some(t => t.function.name === name), `${name} in TOOL_SCHEMAS`);
        assert.ok(MUTATING_TOOLS.has(name), `${name} mutates`);
        assert.ok(!SCOPED_GRAPH_TOOLS.has(name), `${name} takes no scope`);
    }
    const dry = TOOL_SCHEMAS.find(t => t.function.name === 'builder_request_dry_run');
    assert.strictEqual(dry.function.parameters.properties.triggerStepId?.type, 'string');
});

test('an additional app_event trigger gets a trig_ id, a default label, and the primary node shape', async () => {
    const dw = await withGmailPrimary();
    const r = await call(dw, 'builder_add_trigger', { kind: 'app_event', appProvider: 'google-calendar', appEvent: 'event.upcoming', filter: { leadMinutes: 30 } });
    assert.ok(!r.error, r.error);
    assert.match(r.added.id, /^trig_[0-9a-f]{6}$/);
    assert.strictEqual(r.added.kind, 'app_event');
    assert.deepStrictEqual(r.added.appEvent, { provider: 'google-calendar', event: 'event.upcoming', filter: { leadMinutes: 30 } });
    assert.strictEqual(r.added.label, 'google-calendar · event.upcoming');
    assert.match(r.next, new RegExp(r.added.id));
    assert.strictEqual(dw.def.triggers.length, 1);
    assert.ok(Array.isArray(r._draftSteps) && r._draftSteps.some(s => s.id === r.added.id && s.additional), 'the structured echo lists the new root');

    // Same fields as builder_propose_trigger writes for that kind.
    const primaryShape = buildTriggerNode('app_event', { appProvider: 'gmail', appEvent: 'mail.new', filter: { excludeFromSelf: true } }, { id: 'trg' });
    assert.deepStrictEqual(Object.keys(primaryShape).sort(), Object.keys(dw.def.trigger).sort());
});

test('a schedule secondary is accepted with a cron and refused without; manual/form are refused', async () => {
    const dw = await withGmailPrimary();
    const ok = await call(dw, 'builder_add_trigger', { kind: 'schedule', cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', label: 'Daily briefing' });
    assert.ok(!ok.error, ok.error);
    assert.deepStrictEqual(ok.added.schedule, { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' });
    assert.strictEqual(ok.added.label, 'Daily briefing');
    const noCron = await call(dw, 'builder_add_trigger', { kind: 'schedule' });
    assert.match(noCron.error, /cron/);
    for (const kind of ['manual', 'form', 'agent_call', 'app_trigger']) {
        const r = await call(dw, 'builder_add_trigger', { kind });
        assert.match(r.error, /cannot be an additional trigger/, `${kind} refused`);
    }
    const noProvider = await call(dw, 'builder_add_trigger', { kind: 'app_event' });
    assert.match(noProvider.error, /appProvider/);
    assert.strictEqual(dw.def.triggers.length, 1, 'refused calls add nothing');
});

test('inside a flowlet scope the tool is refused', async () => {
    const dw = await withGmailPrimary();
    await call(dw, 'builder_create_layer', { title: 'Sub', params: [] });
    const key = Object.keys(dw.def.layers)[0];
    const r = await call(dw, 'builder_add_trigger', { scope: key, kind: 'webhook' });
    assert.match(r.error, /does not accept a scope/);
});

test('steps wire from a secondary trigger id, and a tempId cannot reuse a trigger id', async () => {
    const dw = await withGmailPrimary();
    const t = (await call(dw, 'builder_add_trigger', { kind: 'webhook' })).added;
    const r = await call(dw, 'builder_add_steps', { steps: [
        { tempId: 'first', type: 'set', spec: { afterStepId: t.id, fields: { a: lit(1) } } },
        { tempId: 'second', type: 'set', spec: { fields: { b: lit(2) } } },
    ] });
    assert.ok(!r.error, r.error);
    const first = r.idMap.first; const second = r.idMap.second;
    assert.deepStrictEqual(edges(dw), [`${t.id}>${first}`, `${first}>${second}`].sort());
    const v = validateDefinition(dw.def);
    assert.strictEqual(v.ok, true, JSON.stringify(v.errors));

    const clash = await call(dw, 'builder_add_steps', { steps: [{ tempId: t.id, type: 'set', spec: { fields: { c: lit(3) } } }] });
    assert.match(clash.error, /collides with an existing step id/);
    const clashPrimary = await call(dw, 'builder_add_steps', { steps: [{ tempId: 'trg', type: 'set', spec: { fields: { c: lit(3) } } }] });
    assert.match(clashPrimary.error, /collides/);
});

test('builder_update_trigger patches a secondary filter and the primary cron in place', async () => {
    const dw = freshWrap();
    await call(dw, 'builder_propose_trigger', { kind: 'schedule', cron: '0 9 * * 1', tz: 'Europe/Amsterdam' });
    const t = (await call(dw, 'builder_add_trigger', { kind: 'app_event', appProvider: 'gmail', appEvent: 'label.added', filter: { labelId: 'Label_1' } })).added;
    const r1 = await call(dw, 'builder_update_trigger', { triggerId: t.id, patch: { filter: { labelId: 'Label_2' }, label: 'Commands', cron: '1 2 3 4 5' } });
    assert.ok(!r1.error, r1.error);
    assert.deepStrictEqual(dw.def.triggers[0].appEvent.filter, { labelId: 'Label_2' });
    assert.strictEqual(dw.def.triggers[0].label, 'Commands');
    assert.ok(r1._warnings?.[0].includes('cron'), 'a schedule-only key on an app_event trigger is reported, not applied');
    const r2 = await call(dw, 'builder_update_trigger', { triggerId: 'trg', patch: { cron: '30 7 * * 1-5' } });
    assert.ok(!r2.error, r2.error);
    assert.strictEqual(dw.def.trigger.schedule.cron, '30 7 * * 1-5');
    const bad = await call(dw, 'builder_update_trigger', { triggerId: 'nope', patch: {} });
    assert.match(bad.error, /Unknown triggerId/);
    const kind = await call(dw, 'builder_update_trigger', { triggerId: t.id, patch: { kind: 'schedule' } });
    assert.match(kind.error, /cannot change kind/);
});

test('removing a secondary trigger drops its edges and reports orphans; the primary is protected', async () => {
    const dw = await withGmailPrimary();
    const t = (await call(dw, 'builder_add_trigger', { kind: 'webhook' })).added;
    const add = await call(dw, 'builder_add_steps', { steps: [{ tempId: 'only', type: 'set', spec: { afterStepId: t.id, fields: { a: lit(1) } } }] });
    const only = add.idMap.only;
    const r = await call(dw, 'builder_remove_step', { stepId: t.id });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.removed, t.id);
    assert.deepStrictEqual(r.orphaned, [only]);
    assert.strictEqual(dw.def.triggers, undefined, 'an empty triggers[] is dropped');
    assert.deepStrictEqual(edges(dw), []);
    const p = await call(dw, 'builder_remove_step', { stepId: 'trg' });
    assert.match(p.error, /primary trigger cannot be removed/);
});

test('summaries and the draft state mention every root', async () => {
    const dw = await withGmailPrimary();
    await call(dw, 'builder_add_trigger', { kind: 'schedule', cron: '0 8 * * 1', label: 'Weekly review' });
    const { summary } = summariseDefinition(dw.def);
    assert.match(summary, /\*\*Also starts:\*\* On schedule \(`0 8 \* \* 1`/);
    assert.match(summary, /"Weekly review"/);
    assert.match(renderAgentDraftState(dw.def), /additional entry point/);
    const echo = await call(dw, 'builder_add_set', { fields: { x: lit(1) } });
    assert.match(echo._stepIds, /\[\+triggers trig_[0-9a-f]{6}\(schedule:0 8 \* \* 1\)\]/);
});

test('bare trigger fields are known for every app_event root, not just the primary', async () => {
    const dw = freshWrap();
    await call(dw, 'builder_propose_trigger', { kind: 'schedule', cron: '0 7 * * 1-5' });
    assert.deepStrictEqual(triggerFieldsFor(dw.def), []);
    await call(dw, 'builder_add_trigger', { kind: 'app_event', appProvider: 'gmail', appEvent: 'label.added', filter: { labelId: 'Label_1' } });
    const fields = triggerFieldsFor(dw.def);
    assert.ok(fields.includes('addedLabelIds'), `label.added fields are offered: ${fields}`);
});

test('a secondary schedule with a broken cron is reported on its own path', async () => {
    const dw = await withGmailPrimary();
    await call(dw, 'builder_add_trigger', { kind: 'schedule', cron: '0 0 31 2 *' });
    const v = validateDefinition(dw.def);
    assert.strictEqual(v.ok, false);
    const rec = v.errors.find(e => e.code === 'trigger.schedule_never_fires');
    assert.ok(rec, JSON.stringify(v.errors));
    assert.match(rec.path, /triggers\[trig_[0-9a-f]{6}\]\.schedule\.cron/);
});

test('a dry run refuses an unknown triggerStepId before touching the runner', async () => {
    const dw = await withGmailPrimary();
    const r = await call(dw, 'builder_request_dry_run', { triggerStepId: 'trig_nope' });
    assert.match(r.error, /Unknown triggerStepId "trig_nope"/);
    assert.match(r.error, /trg\(app_event\)/);
});
