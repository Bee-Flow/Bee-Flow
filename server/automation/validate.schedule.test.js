/**
 * Schedule-trigger validation.
 *
 * Run: node --test automation/validate.schedule.test.js
 *
 * There was NO schedule validation at all — `grep "'schedule'" validate.js`
 * came back empty — so a `{ kind: 'schedule' }` trigger with no cron passed
 * BOTH the draft and the strict pass. Activated, that routine lands in the
 * automations table with trigger_type='schedule' and schedule_cron=NULL
 * (triggerColumns.js maps a missing trigger.schedule.cron to null).
 * claimDueAutomations selects on trigger_type + next_run_at only, and the
 * runner's post-run advance is gated on the cron the row does not have — so
 * next_run_at stays in the past and the routine re-fires, with live side
 * effects, on every 60-second scheduler tick, forever.
 *
 * These tests pin BOTH halves of the fix: activation is blocked, and a
 * freshly-dropped (not yet configured) schedule node still saves as a draft.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });

/** trigger → one notification, so nothing but the trigger can be at fault. */
function defWithTrigger(trigger) {
    return { trigger, steps: [note('s1')], edges: [{ from: trigger.id, to: 's1' }] };
}

const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);
const findRec = (r, code) => [...r.errors, ...r.warnings].find(x => x.code === code);

test('a schedule trigger with NO cron cannot be activated — it would re-fire every tick', () => {
    const def = defWithTrigger({ id: 'trg', type: 'trigger', kind: 'schedule' });

    const strict = validateDefinition(def);
    assert.equal(strict.ok, false, 'a schedule with no schedule must never go live');
    const rec = strict.errors.find(e => e.code === 'trigger.schedule_missing');
    assert.ok(rec, `expected trigger.schedule_missing, got ${JSON.stringify(codesOf(strict))}`);
    assert.equal(rec.path, 'trigger.schedule.cron');
});

test('an EMPTY cron is the same can-never-fire routine as a missing one', () => {
    for (const schedule of [{}, { cron: '' }, { cron: '   ' }, { cron: null }, { cron: 42 }]) {
        const r = validateDefinition(defWithTrigger({ id: 'trg', kind: 'schedule', schedule }));
        assert.ok(r.errors.some(e => e.code === 'trigger.schedule_missing'),
            `schedule ${JSON.stringify(schedule)} should be rejected`);
    }
});

test('a freshly dropped schedule node still SAVES — the palette PUTs it before the inspector opens', () => {
    // BFSF-323: the canvas writes the whole definition on drop, long before
    // anyone has picked a time. Blocking that save would leave the canvas
    // holding a node the stored definition does not have.
    assert.ok(COMPLETENESS_CODES.has('trigger.schedule_missing'));
    const draft = validateDefinition(defWithTrigger({ id: 'trg', kind: 'schedule' }), { stage: 'draft' });
    assert.equal(draft.ok, true, 'draft saves must keep working');
    const warned = draft.warnings.find(w => w.code === 'trigger.schedule_missing');
    assert.ok(warned, 'still reported, as an amber nag');
    assert.equal(warned.blockedAt, 'activate');
});

test('a cron that does not parse blocks activation, and warns while it is being typed', () => {
    // "0 9 * *" is what "0 9 * * 1-5" looks like four keystrokes from the end.
    const def = defWithTrigger({ id: 'trg', kind: 'schedule', schedule: { cron: '0 9 * *' } });

    const strict = validateDefinition(def);
    assert.equal(strict.ok, false);
    const rec = strict.errors.find(e => e.code === 'trigger.schedule_cron_invalid');
    assert.ok(rec, `expected trigger.schedule_cron_invalid, got ${JSON.stringify(codesOf(strict))}`);
    assert.match(rec.message, /0 9 \* \*/, 'the message quotes the pattern the user typed');

    assert.ok(COMPLETENESS_CODES.has('trigger.schedule_cron_invalid'));
    const draft = validateDefinition(def, { stage: 'draft' });
    assert.equal(draft.ok, true, 'autosave fires mid-keystroke — it must not 400');
});

test('nonsense in the cron field is rejected too, not just the wrong field count', () => {
    for (const cron of ['every monday', '* * * * bananas', '0 0 * * */0']) {
        const r = validateDefinition(defWithTrigger({ id: 'trg', kind: 'schedule', schedule: { cron } }));
        assert.ok(r.errors.some(e => e.code === 'trigger.schedule_cron_invalid'),
            `cron ${JSON.stringify(cron)} should be rejected, got ${JSON.stringify(codesOf(r))}`);
    }
});

test('a cron that PARSES but can never come round is caught as well', () => {
    // parseCron drops out-of-range values rather than rejecting them ("99"
    // leaves an EMPTY minute set) and 31 February is legal syntax. Both parse
    // clean and both give nextRunAt null — the routine would sit active with
    // next_run_at NULL and never run once.
    for (const cron of ['99 * * * *', '0 0 31 2 *']) {
        const def = defWithTrigger({ id: 'trg', kind: 'schedule', schedule: { cron } });
        const strict = validateDefinition(def);
        assert.equal(strict.ok, false, `${cron} must not activate`);
        assert.ok(strict.errors.some(e => e.code === 'trigger.schedule_never_fires'),
            `cron ${JSON.stringify(cron)}: got ${JSON.stringify(codesOf(strict))}`);
        assert.equal(validateDefinition(def, { stage: 'draft' }).ok, true, 'still draft-saveable');
    }
});

test('an unknown timezone is reported as a timezone problem, not a cron one', () => {
    // nextRunAt builds an Intl.DateTimeFormat from it; the scheduler hits the
    // same RangeError when it tries to advance the row.
    const r = validateDefinition(defWithTrigger({
        id: 'trg', kind: 'schedule', schedule: { cron: '0 9 * * *', tz: 'Mars/Olympus_Mons' },
    }));
    assert.equal(r.ok, false);
    const rec = r.errors.find(e => e.code === 'trigger.schedule_tz_invalid');
    assert.ok(rec, `got ${JSON.stringify(codesOf(r))}`);
    assert.equal(rec.path, 'trigger.schedule.tz');
    assert.equal(findRec(r, 'trigger.schedule_cron_invalid'), undefined, 'the cron itself is fine');
    // Still openable and fixable in the builder — it just cannot go live.
    assert.ok(COMPLETENESS_CODES.has('trigger.schedule_tz_invalid'));
    assert.equal(validateDefinition(defWithTrigger({
        id: 'trg', kind: 'schedule', schedule: { cron: '0 9 * * *', tz: 'Mars/Olympus_Mons' },
    }), { stage: 'draft' }).ok, true);
});

test('a real schedule validates clean at both stages', () => {
    for (const cron of ['0 9 * * 1-5', '*/15 * * * *', '0 0 1 1 *', '30 6 * * 0']) {
        const def = defWithTrigger({ id: 'trg', kind: 'schedule', schedule: { cron, tz: 'Europe/Amsterdam' } });
        const strict = validateDefinition(def);
        assert.equal(strict.ok, true, `${cron}: ${JSON.stringify(strict.errors)}`);
        assert.deepEqual(codesOf(strict).filter(c => c.startsWith('trigger.schedule')), []);
        assert.equal(validateDefinition(def, { stage: 'draft' }).ok, true);
    }
});

test('a non-object `schedule` is a shape error at every stage', () => {
    const r = validateDefinition(defWithTrigger({ id: 'trg', kind: 'schedule', schedule: '0 9 * * 1' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'trigger.schedule_shape'));
    // Integrity, not completeness — no amount of further editing makes a
    // string a schedule block.
    assert.equal(COMPLETENESS_CODES.has('trigger.schedule_shape'), false);
    assert.equal(validateDefinition(defWithTrigger({ id: 'trg', kind: 'schedule', schedule: '0 9 * * 1' }), { stage: 'draft' }).ok, false);
});

test('no other trigger kind grows a cron requirement', () => {
    for (const kind of ['manual', 'webhook', 'agent_call']) {
        const r = validateDefinition(defWithTrigger({ id: 'trg', kind }));
        assert.equal(findRec(r, 'trigger.schedule_missing'), undefined, `${kind} must not need a cron`);
        assert.equal(r.ok, true, `${kind}: ${JSON.stringify(r.errors)}`);
    }
});

// ── schedule.skipHolidays (handoff 5) ───────────────────────────────

test('skipHolidays: true or false is accepted; anything else is a shape error at every stage', () => {
    for (const v of [true, false, undefined, null]) {
        const def = defWithTrigger({ id: 'trg', type: 'trigger', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', skipHolidays: v } });
        assert.equal(validateDefinition(def).ok, true, `skipHolidays ${v}`);
    }
    const bad = defWithTrigger({ id: 'trg', type: 'trigger', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', skipHolidays: 'yes' } });
    for (const stage of ['draft', 'activate']) {
        const r = validateDefinition(bad, { stage });
        assert.equal(r.ok, false, stage);
        assert.equal(r.errors[0].code, 'trigger.schedule_skip_holidays_shape');
        assert.equal(r.errors[0].path, 'trigger.schedule.skipHolidays');
    }
});

test('a schedule that only fires on holidays never fires once holidays are skipped', () => {
    const cron = '0 9 25,26 12 *';
    const plain = defWithTrigger({ id: 'trg', type: 'trigger', kind: 'schedule', schedule: { cron } });
    assert.equal(validateDefinition(plain).ok, true);
    const skipping = defWithTrigger({ id: 'trg', type: 'trigger', kind: 'schedule', schedule: { cron, skipHolidays: true } });
    const r = validateDefinition(skipping);
    assert.equal(r.ok, false);
    assert.ok(findRec(r, 'trigger.schedule_never_fires'));
});
