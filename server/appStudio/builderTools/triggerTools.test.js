'use strict';

/**
 * app_set_trigger / app_remove_trigger (builderTools/triggerTools.mts) through the builder's own
 * dispatch: they write definition.triggers in the draft, refuse what the validator refuses with
 * the reason, and say that only a publish arms a trigger.
 *
 * Run: cd server && node --test appStudio/builderTools/triggerTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall, MUTATING_TOOLS } = require('../builderTools');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { emptyDefinition } = require('../componentSpecs');

const DAILY = { cron: '0 8 * * 1-5', tz: 'Europe/Amsterdam' };
function draft() {
    const def = canonicalizeAppDefinition({
        ...emptyDefinition(), variables: [{ name: 'n', type: 'number' }],
        actions: {
            act_job1: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'n', value: { kind: 'static', value: 1 } }] },
            act_page: { kind: 'sequence', steps: [{ kind: 'toast', message: 'Hi' }] },
        },
    }).def;
    return { def };
}
const call = (wrap, name, args) => applyToolCall(name, args, wrap);

test('both tools are on the menu as draft-changing tools', () => {
    assert.equal(MUTATING_TOOLS.has('app_set_trigger'), true);
    assert.equal(MUTATING_TOOLS.has('app_remove_trigger'), true);
});

test('app_set_trigger adds a schedule trigger to the draft, valid and schema 3, and says a publish arms it', async () => {
    const wrap = draft();
    const out = await call(wrap, 'app_set_trigger', { actionId: 'act_job1', schedule: DAILY });
    assert.equal(out.error, undefined, out.error);
    assert.deepEqual(out.trigger, { id: 'trigger1', kind: 'schedule', actionId: 'act_job1', schedule: DAILY });
    assert.match(out.note, /starts to run when the app is published, as the app owner/);
    assert.deepEqual(wrap.def.triggers, [out.trigger]);
    assert.equal(wrap.def.schemaVersion, 3);
    assert.deepEqual(validateAppDefinition(wrap.def, {}).errors, []);
});

test('the same id replaces the trigger; a second one is added; enabled false is kept', async () => {
    const wrap = draft();
    await call(wrap, 'app_set_trigger', { id: 'morning', actionId: 'act_job1', schedule: DAILY });
    const replaced = await call(wrap, 'app_set_trigger', { id: 'morning', actionId: 'act_job1', schedule: { everyMinutes: 30 }, enabled: false });
    assert.deepEqual(replaced.trigger, { id: 'morning', kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 30 }, enabled: false });
    const second = await call(wrap, 'app_set_trigger', { id: 'hourly', actionId: 'act_job1', schedule: { everyMinutes: 60 } });
    assert.deepEqual(second.triggers, ['morning', 'hourly']);
});

test('a refused call changes nothing and names the reason: the action, the schedule, a step that needs a page', async () => {
    const wrap = draft();
    const before = JSON.stringify(wrap.def);
    const unknown = await call(wrap, 'app_set_trigger', { actionId: 'act_nope', schedule: DAILY });
    assert.match(unknown.error, /Unknown actionId "act_nope"/);
    assert.match(unknown._fixHint, /act_job1/);
    const schedule = await call(wrap, 'app_set_trigger', { actionId: 'act_job1', schedule: { cron: '0 8 * * 1-5' } });
    assert.match(schedule.error, /a cron needs tz/);
    assert.match(schedule._fixHint, /everyMinutes/);
    const page = await call(wrap, 'app_set_trigger', { actionId: 'act_page', schedule: DAILY });
    assert.match(page.error, /toast step, which cannot run without a person at the page/);
    assert.match(page._fixHint, /call_action/);
    assert.match((await call(wrap, 'app_set_trigger', { kind: 'full_moon', actionId: 'act_job1' })).error, /Unknown trigger kind/);
    assert.equal(JSON.stringify(wrap.def), before);
});

test('app_remove_trigger takes one out; the last one removes the key and the app is schema 2 again', async () => {
    const wrap = draft();
    await call(wrap, 'app_set_trigger', { id: 'morning', actionId: 'act_job1', schedule: DAILY });
    assert.match((await call(wrap, 'app_remove_trigger', { id: 'evening' })).error, /Unknown trigger "evening"/);
    const out = await call(wrap, 'app_remove_trigger', { id: 'morning' });
    assert.deepEqual([out.removed, out.triggers], ['morning', []]);
    assert.match(out.note, /keeps running the trigger until it is published again/);
    assert.equal('triggers' in wrap.def, false);
    assert.equal(wrap.def.schemaVersion, 2);
});
