'use strict';

/**
 * definition.triggers: the canonical form, the validator, the schedule kind, the registry of
 * kinds and the unattended step policy (what every existing step kind answers).
 *
 * Run: cd server && node --test appStudio/triggers/triggerSpec.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { emptyDefinition } = require('../componentSpecs');
const { STEP_META, stepPolicy } = require('../componentSpecs/stepRegistry');
const { triggerFingerprint, MAX_TRIGGERS } = require('./triggerSpec.mts');
const { checkKind, triggerKinds, _withTriggerKinds } = require('./triggerKinds.mts');
const { readSchedule, cronProblem, isTimeZone } = require('./kinds/schedule.mts');
const { unattendedActionProblems, runsUnattended } = require('./unattendedPolicy.mts');
const schedule = require('./kinds/schedule.mts').default;

const write = (tableId) => ({ kind: 'create_record', tableId, values: {} });
const DAILY = { cron: '0 8 * * 1-5', tz: 'Europe/Amsterdam' };
function app(triggers, actions = { act_job1: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'n', value: { kind: 'static', value: 1 } }] } }) {
    return { ...BASE, variables: [{ name: 'n', type: 'number' }], actions, ...(triggers === undefined ? {} : { triggers }) };
}
// One canonical base (its generated ids are then fixed), so two definitions differ only in what a test gives them.
const BASE = canonicalizeAppDefinition(emptyDefinition()).def;
const canon = (triggers, actions) => canonicalizeAppDefinition(app(triggers, actions));
const codes = (def) => validateAppDefinition(def, {}).errors.map((e) => `${e.code} @ ${e.path}`);

test('an app without triggers is unchanged: no key, schema version 2, the same bytes with and without this package', () => {
    const { def } = canon(undefined);
    assert.equal('triggers' in def, false);
    assert.equal(def.schemaVersion, 2);
    assert.equal(JSON.stringify(canon([]).def), JSON.stringify(def), 'an empty list is not written either');
});

test('a trigger makes the definition schema 3 and is written in canonical form', () => {
    const { def } = canon([{ id: 'morning', kind: 'schedule', actionId: 'act_job1', schedule: { cron: ' 0  8 * * 1-5 ', tz: 'Europe/Amsterdam', extra: 1 }, enabled: true, note: 'x' }]);
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(def.triggers, [{ id: 'morning', kind: 'schedule', actionId: 'act_job1', schedule: DAILY }]);
    assert.equal(JSON.stringify(canonicalizeAppDefinition(def).def), JSON.stringify(def), 'a second pass changes nothing');
    assert.deepEqual(codes(def), []);
});

test('canonicalize: enabled is only kept as false, a missing id is numbered by position, what cannot be kept is removed with a repair', () => {
    const { def, repairs } = canon([
        { kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 30 }, enabled: false },
        { id: 'trigger1', kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 5 } },
        { id: 'gone', kind: 'schedule', actionId: 'act_miss', schedule: { everyMinutes: 5 } },
        { id: 'odd', kind: 'full_moon', actionId: 'act_job1' },
        { id: 'bad', kind: 'schedule', actionId: 'act_job1', schedule: { cron: '61 * * * *', tz: 'UTC' } },
        'nonsense',
    ]);
    assert.deepEqual(def.triggers, [
        { id: 'trigger1', kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 30 }, enabled: false },
        { id: 'trigger2', kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 5 } },
    ]);
    const got = repairs.map((r) => r.code).filter((c) => c.startsWith('triggers.') || c === 'event.dangling');
    assert.deepEqual(got, ['triggers.id_repaired', 'triggers.id_repaired', 'event.dangling', 'triggers.kind_unknown', 'triggers.schedule_invalid', 'triggers.invalid']);
    assert.equal(canon(Array.from({ length: MAX_TRIGGERS + 3 }, () => ({ kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 5 } }))).def.triggers.length, MAX_TRIGGERS);
    assert.equal('triggers' in canon('daily').def, false);
});

test('the validator: shape errors of a definition that skipped the canonicalizer', () => {
    const def = { ...canon(undefined).def, schemaVersion: 3 };
    const with_ = (triggers) => codes({ ...def, triggers });
    assert.deepEqual(with_('x'), ['triggers.invalid @ triggers']);
    assert.deepEqual(with_([null]), ['triggers.invalid @ triggers[0]']);
    assert.deepEqual(with_([{ id: 'a', kind: 'schedule', actionId: 'act_job1', schedule: DAILY }, { id: 'a', kind: 'schedule', actionId: 'act_job1', schedule: DAILY }]), ['triggers.id_invalid @ triggers[1].id']);
    assert.deepEqual(with_([{ id: 'a', kind: 'full_moon', actionId: 'act_job1' }]), ['triggers.kind_unknown @ triggers[0].kind']);
    assert.deepEqual(with_([{ id: 'a', kind: 'schedule', actionId: 'nope', schedule: DAILY }]), ['event.action_unresolved @ triggers[0].actionId']);
    assert.deepEqual(with_([{ id: 'a', kind: 'schedule', actionId: 'act_job1', schedule: { cron: '0 8 * * *' } }]), ['triggers.schedule_invalid @ triggers[0].schedule']);
    assert.deepEqual(with_([{ id: 'a', kind: 'schedule', actionId: 'act_job1', schedule: DAILY, enabled: true, runAs: 'viewer' }]), ['triggers.enabled_invalid @ triggers[0].enabled', 'triggers.field_unknown @ triggers[0].runAs']);
});

test('the validator refuses an action that may not run unattended, with the step it is about, also through call_action', () => {
    const actions = {
        act_job1: { kind: 'sequence', steps: [write('log'), { kind: 'confirm', message: 'Sure?' }, { kind: 'call_action', actionId: 'act_page' }] },
        act_page: { kind: 'sequence', steps: [{ kind: 'toast', message: 'Done' }] },
    };
    const def = { ...canon(undefined).def, schemaVersion: 3, actions, triggers: [{ id: 'a', kind: 'schedule', actionId: 'act_job1', schedule: DAILY }] };
    const found = validateAppDefinition(def, {}).errors.filter((e) => e.code === 'triggers.step_not_unattended');
    assert.deepEqual(found.map((e) => e.path), ['actions.act_job1.steps[1]', 'actions.act_job1.steps[2].call.steps[0]']);
    assert.match(found[0].message, /confirm step, which cannot run without a person at the page/);
    // The same action behind a button only is fine: the finding belongs to the trigger.
    assert.equal(validateAppDefinition({ ...def, triggers: undefined }, {}).errors.some((e) => e.code.startsWith('triggers.')), false);
});

test('the schedule: a cron needs five fields, values in range, a real moment and a time zone; an interval is 1 to a year of minutes', () => {
    assert.deepEqual(readSchedule(DAILY), { ok: true, schedule: DAILY });
    assert.deepEqual(readSchedule({ everyMinutes: 15 }), { ok: true, schedule: { everyMinutes: 15 } });
    for (const bad of [null, 'daily', {}, { cron: '0 8 * * *', tz: 'UTC', everyMinutes: 5 }, { everyMinutes: 0 }, { everyMinutes: 1.5 }, { everyMinutes: '15' }, { everyMinutes: 525_601 },
        { cron: '0 8 * *', tz: 'UTC' }, { cron: '0 8 * * * *', tz: 'UTC' }, { cron: '0 25 * * *', tz: 'UTC' }, { cron: '0 0 31 2 *', tz: 'UTC' }, { cron: '@daily', tz: 'UTC' },
        { cron: '0 8 * * *' }, { cron: '0 8 * * *', tz: 'Mars/Olympus' }, { cron: `${'1,'.repeat(60)}1 * * * *`, tz: 'UTC' }, { cron: 8, tz: 'UTC' }]) {
        assert.equal(readSchedule(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(cronProblem('*/15 9-17 * * 1-5'), null);
    assert.match(cronProblem('0 8 * * mon'), /only digits/);
    assert.equal(isTimeZone('Europe/Amsterdam'), true);
    assert.equal(isTimeZone(''), false);
    assert.equal(schedule.nextFireAt({ schedule: { everyMinutes: 10 } }, 1000), 601_000);
    assert.equal(schedule.nextFireAt({ schedule: { cron: '30 9 * * *', tz: 'UTC' } }, Date.parse('2026-01-05T09:30:00Z')), Date.parse('2026-01-06T09:30:00Z'), 'strictly after the moment asked');
    assert.equal(schedule.nextFireAt({ schedule: 'broken' }, 1000), null);
});

test('the fingerprint covers the trigger, its action and what that calls, and nothing else', () => {
    const trigger = { id: 'a', kind: 'schedule', actionId: 'one', schedule: DAILY };
    const def = { actions: { one: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'two' }] }, two: write('t'), other: write('o') }, screens: [] };
    const base = triggerFingerprint(def, trigger);
    assert.equal(triggerFingerprint({ ...def, screens: [{ id: 's' }], actions: { ...def.actions, other: write('changed') } }, { ...trigger, id: 'renamed', enabled: false }), base);
    assert.notEqual(triggerFingerprint(def, { ...trigger, schedule: { ...DAILY, tz: 'UTC' } }), base);
    assert.notEqual(triggerFingerprint({ ...def, actions: { ...def.actions, two: write('changed') } }, trigger), base);
    assert.notEqual(triggerFingerprint(def, { ...trigger, actionId: 'two' }), base);
});

test('a trigger kind is one file: the registry refuses a malformed one, and a second kind needs no edit elsewhere', async () => {
    for (const kind of ['record', 'schedule']) assert.ok(triggerKinds().some((k) => k.kind === kind), `${kind} is a registered kind`);
    assert.throws(() => checkKind({ ...schedule, kind: 'Schedule' }), /lower_snake_case/);
    assert.throws(() => checkKind({ ...schedule, since: 2 }), /"since"/);
    assert.throws(() => checkKind({ ...schedule, fields: ['actionId'] }), /"fields"/);
    assert.throws(() => checkKind({ ...schedule, refusedKinds: undefined }), /"refusedKinds"/);
    assert.throws(() => checkKind(schedule, 'other'), /equals the file name/);
    // A kind that fires on an event: no nextFireAt, its own field, and a step kind it refuses on top of the catalogue.
    const record = { kind: 'record', since: 3, fields: ['tableId'], canon: (raw) => ({ tableId: String(raw.tableId) }), validate() {}, config: (t) => ({ tableId: t.tableId }), refusedKinds: ['send_email'], shape: '{…}', description: 'On a changed record.' };
    await _withTriggerKinds([schedule, record], () => {
        const actions = { act_job1: { kind: 'sequence', steps: [{ kind: 'send_email', connectorId: 'c', to: { kind: 'static', value: 'a@b.test' }, subject: 's', body: 'b' }] } };
        const def = { ...canon(undefined).def, schemaVersion: 3, actions, triggers: [{ id: 'r', kind: 'record', actionId: 'act_job1', tableId: 'orders' }, { id: 's', kind: 'schedule', actionId: 'act_job1', schedule: DAILY }] };
        const found = validateAppDefinition(def, {}).errors.filter((e) => e.code.startsWith('triggers.'));
        assert.deepEqual(found.map((e) => e.code), ['triggers.step_not_unattended'], 'the record kind refuses send_email, the schedule kind does not');
    });
});

// ── The unattended policy of the step catalogue ─────────────────────────────

const RUNS = [
    'set_variable', 'condition', 'switch', 'loop', 'call_action', 'create_record', 'update_record', 'delete_record', 'transaction',
    'ai_extract', 'ai_generate', 'kb_query', 'dataset_query', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake',
    'send_email', 'run_automation', 'request_approval',
    'break', 'code', 'continue', 'parallel', 'raise_error', 'return', 'try', 'while',
];

test('contract: every step kind answers for an unattended run, and the answers are exactly this list', () => {
    for (const [kind, meta] of Object.entries(STEP_META)) assert.ok(['run', 'refuse'].includes(meta.policy.unattended), kind);
    const run = Object.keys(STEP_META).filter((k) => stepPolicy(k, 'unattended') === 'run');
    assert.deepEqual(run.sort(), [...RUNS].sort(), 'a kind that starts to run unattended is a decision: add it here with the reason in unattendedPolicy.mts');
});

test('contract: nothing that needs a page or a visitor runs unattended, and an undeclared kind never does', () => {
    for (const [kind, meta] of Object.entries(STEP_META)) {
        if (meta.side === 'client' && kind !== 'set_variable') assert.equal(runsUnattended(kind), false, kind);
    }
    for (const kind of ['confirm', 'toast', 'refresh', 'navigate', 'ai_browse', 'copy_document', 'kb_log_query', 'kb_log_review', 'http_request', 'wait', 'made_up', undefined]) {
        assert.equal(runsUnattended(kind), false, String(kind));
    }
    assert.equal(runsUnattended('send_email'), true);
    assert.equal(runsUnattended('send_email', ['send_email']), false, 'a trigger kind can refuse more');
});

test('contract: the other execution forms of the base kinds are what they were', () => {
    const forms = (kind) => { const { unattended: _u, ...rest } = STEP_META[kind].policy; return rest; };
    assert.deepEqual(forms('send_email'), { click: 'step', background: 'run', mailboxHook: 'refuse', mcpRun: 'draft', mcpDryRun: 'skip', public: 'step' });
    assert.deepEqual(forms('run_automation'), { click: 'step', background: 'run', mailboxHook: 'refuse', mcpRun: 'refuse', mcpDryRun: 'skip', public: 'step' });
    assert.deepEqual(forms('request_approval'), forms('run_automation'));
    assert.deepEqual(forms('copy_document'), forms('run_automation'));
    assert.deepEqual(forms('create_record'), { click: 'step', background: 'run', mailboxHook: 'run', mcpRun: 'run', mcpDryRun: 'skip', public: 'step' });
    assert.deepEqual(forms('loop'), { click: 'browser', background: 'run', mailboxHook: 'refuse', mcpRun: 'run', mcpDryRun: 'run', public: 'browser' });
    assert.deepEqual(forms('toast'), { click: 'browser', background: 'defer', mailboxHook: 'refuse', mcpRun: 'skip', mcpDryRun: 'skip', public: 'browser' });
});

test('unattendedActionProblems: a missing action, an empty one, a bare action, a step inside a branch and an error handler', () => {
    assert.equal(unattendedActionProblems(null, 'a')[0].code, 'triggers.action_unresolved');
    assert.equal(unattendedActionProblems({ kind: 'sequence', steps: [] }, 'a')[0].code, 'triggers.action_empty');
    assert.deepEqual(unattendedActionProblems(write('t'), 'a'), []);
    assert.deepEqual(unattendedActionProblems({ kind: 'navigate', screenId: 's' }, 'a').map((p) => p.path), ['steps[0]']);
    const nested = { kind: 'sequence', steps: [
        { kind: 'condition', expr: 'true', then: [{ kind: 'open_modal', modalId: 'm' }], else: [write('t')] },
        { ...write('t'), onError: { steps: [{ kind: 'toast', message: 'Failed' }] } },
    ] };
    assert.deepEqual(unattendedActionProblems(nested, 'a').map((p) => p.kind).sort(), ['open_modal', 'toast']);
});

// ── Who else may run a trigger's action ─────────────────────────────────────

test('an action only a trigger starts is reachable for the validator and for no viewer; a button that also wires it decides for its roles', () => {
    const { actionRoleAccess } = require('../../routes/studioAppRunGate');
    const actions = { act_job1: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_part' }] }, act_part: write('t'), act_free: write('t') };
    const def = { ...canon(undefined).def, schemaVersion: 3, actions, triggers: [{ id: 'a', kind: 'schedule', actionId: 'act_job1', schedule: DAILY }] };
    const unreachable = validateAppDefinition(def, {}).warnings.filter((w) => w.code === 'action.unreachable').map((w) => w.path);
    assert.deepEqual(unreachable, ['actions.act_free'], 'the trigger reaches its action and what that calls');
    assert.deepEqual(actionRoleAccess(def, 'act_job1', 'agent'), { referenced: true, allowed: false });
    assert.deepEqual(actionRoleAccess(def, 'act_part', 'agent'), { referenced: true, allowed: false }, 'what it calls is the trigger\'s too');
    assert.deepEqual(actionRoleAccess(def, 'act_free', 'agent'), { referenced: false, allowed: false }, 'an action nothing names is as before');
    const button = { id: 'cmp_btn00001', type: 'button', props: { label: 'Run' }, onClick: 'act_job1' };
    const wired = { ...def, screens: [{ ...def.screens[0], sections: [{ ...def.screens[0].sections[0], children: [button] }] }] };
    assert.deepEqual(actionRoleAccess(wired, 'act_job1', 'agent'), { referenced: true, allowed: true });
    assert.deepEqual(actionRoleAccess({ ...def, triggers: undefined }, 'act_job1', 'agent'), { referenced: false, allowed: false }, 'without triggers the gate is what it was');
});
