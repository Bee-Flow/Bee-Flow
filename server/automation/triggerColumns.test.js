/**
 * BFSF-318 — the denormalised trigger columns must follow the definition.
 *
 * Run: node --test automation/triggerColumns.test.js
 *
 * The scheduler claims rows by `trigger_type = 'schedule'` plus the
 * schedule_cron/tz columns, never by reading definition JSON. The visual editor
 * only ever PUTs `definition`, so a schedule configured in the node panel left
 * trigger_type at 'manual' and next_run_at unset — the automation simply never
 * fired. `PUT /api/automations/:id` now derives the columns through this helper.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triggerColumnsFromDefinition, DEFAULT_SCHEDULE_TZ } = require('./triggerColumns');

test('derives schedule columns from the trigger', () => {
    const def = { trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } } };
    assert.deepEqual(triggerColumnsFromDefinition(def), {
        triggerType: 'schedule',
        scheduleCron: '0 9 * * 1',
        scheduleTz: 'Europe/Amsterdam',
    });
});

test('carries every non-schedule trigger kind through as the trigger type', () => {
    for (const kind of ['manual', 'webhook', 'app_event', 'agent_call', 'app_trigger']) {
        const cols = triggerColumnsFromDefinition({ trigger: { id: 'trg', kind } });
        assert.equal(cols.triggerType, kind);
        assert.equal(cols.scheduleCron, null, 'a non-schedule trigger must not carry a cron');
    }
});

test('falls back to manual with no cron when the trigger is absent or malformed', () => {
    for (const def of [null, undefined, {}, 'nope', { trigger: null }]) {
        assert.deepEqual(triggerColumnsFromDefinition(def), {
            triggerType: 'manual',
            scheduleCron: null,
            scheduleTz: DEFAULT_SCHEDULE_TZ,
        });
    }
});

test('a schedule trigger with no tz gets the default', () => {
    const cols = triggerColumnsFromDefinition({ trigger: { kind: 'schedule', schedule: { cron: '* * * * *' } } });
    assert.equal(cols.scheduleTz, DEFAULT_SCHEDULE_TZ);
});

test('matches what the AI builder writes for the same definition', () => {
    // builderTools.persistDraft has always derived these three the same way;
    // this pins the visual-editor path to that behaviour so the two can't drift.
    const def = { trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '30 7 * * *', tz: 'UTC' } } };
    const cols = triggerColumnsFromDefinition(def);
    assert.equal(cols.triggerType, def.trigger.kind || 'manual');
    assert.equal(cols.scheduleCron, def.trigger.schedule?.cron || null);
    assert.equal(cols.scheduleTz, def.trigger.schedule?.tz || DEFAULT_SCHEDULE_TZ);
});
