/**
 * Per-step rules added in the routines audit pass: guard branch edges,
 * notification channels, prototype-polluting switch case names, and the
 * BFSF-348 wording of the form-trigger error.
 *
 * Run: node --test automation/validate.stepRules.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const trigger = () => ({ id: 'trg', kind: 'manual' });
const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });
const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);
const findRec = (r, code) => [...r.errors, ...r.warnings].find(x => x.code === code);

// ── An unlabelled edge out of a GUARD never fires ────────────────────────────
// runDag routes a guard by the same then/else branch labels it routes a
// condition by, but `edge.branch_unlabelled` only covered condition and switch.
// An unlabelled guard edge was therefore savable, activatable, and silently
// dead: the guard ran, produced its branch, and nothing downstream fired.

test('an unlabelled edge out of a guard blocks activation, like condition and switch', () => {
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'g1', type: 'guard', sourceRef: 'trigger.output.body' },
            note('alert'),
        ],
        edges: [{ from: 'trg', to: 'g1' }, { from: 'g1', to: 'alert' }],
    };
    const strict = validateDefinition(def);
    const rec = strict.errors.find(e => e.code === 'edge.branch_unlabelled');
    assert.ok(rec, `expected edge.branch_unlabelled, got ${JSON.stringify(codesOf(strict))}`);
    assert.match(rec.message, /leaves a guard/);
    assert.match(rec.hint, /personal data/, 'the hint is written for a guard, not an If');
    assert.equal(strict.ok, false);

    // Same posture as condition/switch: existing JSON/AI-authored drafts keep
    // saving, activation is what blocks.
    assert.ok(COMPLETENESS_CODES.has('edge.branch_unlabelled'));
    assert.equal(validateDefinition(def, { stage: 'draft' }).ok, true);
});

test('a properly labelled guard edge is clean', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'g1', type: 'guard', sourceRef: 'trigger.output.body' }, note('alert'), note('ok')],
        edges: [
            { from: 'trg', to: 'g1' },
            { from: 'g1', to: 'alert', label: 'then' },
            { from: 'g1', to: 'ok', label: 'else' },
        ],
    });
    assert.equal(findRec(r, 'edge.branch_unlabelled'), undefined, JSON.stringify(codesOf(r)));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('an unlabelled edge out of a NON-brancher is still perfectly normal', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [note('a'), note('b')],
        edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
    });
    assert.equal(findRec(r, 'edge.branch_unlabelled'), undefined);
});

// ── notification.channels ────────────────────────────────────────────────────
// Never validated: an unsupported channel threw at run time
// (errorClass notification_channel_unsupported) after the routine had
// activated green.

const notifWith = (channels) => ({
    trigger: trigger(),
    steps: [{ id: 'n1', type: 'notification', title: 'T', body: 'B', ...(channels === undefined ? {} : { channels }) }],
    edges: [{ from: 'trg', to: 'n1' }],
});

test('a notification whose channels can deliver NOTHING blocks activation', () => {
    const def = notifWith(['slack']);
    const strict = validateDefinition(def);
    assert.equal(strict.ok, false);
    const rec = strict.errors.find(e => e.code === 'notification.channels_unsupported');
    assert.ok(rec, `got ${JSON.stringify(codesOf(strict))}`);
    assert.match(rec.hint, /notification/);

    // Only reachable via raw API / AI authoring, so stored definitions must
    // stay saveable.
    assert.ok(COMPLETENESS_CODES.has('notification.channels_unsupported'));
    assert.equal(validateDefinition(def, { stage: 'draft' }).ok, true);
});

test('an unknown channel ALONGSIDE a working one only warns — the runner just skips it', () => {
    const r = validateDefinition(notifWith(['notification', 'slack']));
    const rec = r.warnings.find(w => w.code === 'notification.channel_unknown');
    assert.ok(rec, `got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.message, /"slack"/);
    assert.equal(r.ok, true, 'the step still delivers, so it must not block');
});

test('every channel execNotification supports validates clean', () => {
    for (const channels of [undefined, ['notification'], ['inapp'], ['email'], ['notification', 'email'], []]) {
        const r = validateDefinition(notifWith(channels));
        assert.deepEqual(codesOf(r).filter(c => c.startsWith('notification.channel')), [],
            `channels ${JSON.stringify(channels)} should be clean`);
    }
});

test('a non-array channels value is reported as ignored, not as a save failure', () => {
    const r = validateDefinition(notifWith('email'));
    const rec = r.warnings.find(w => w.code === 'notification.channels_shape');
    assert.ok(rec, `got ${JSON.stringify(codesOf(r))}`);
    assert.equal(r.ok, true, 'the runner falls back to the bell, so the routine still runs');
});

// ── A switch case named __proto__ silently loses its rows ────────────────────

test('a prototype-polluting switch case name is rejected', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
        const r = validateDefinition({
            trigger: trigger(),
            steps: [{
                id: 'sw', type: 'switch', arrayRef: 'trigger.output.items',
                // In collection mode execSwitch buckets the matched rows into a
                // plain object keyed by case name — assigning `__proto__` there
                // never creates an own key, so the case matched and its rows
                // went nowhere while the run stayed green.
                cases: [{ name, expr: 'item.x > 1' }],
            }, note('a')],
            edges: [{ from: 'trg', to: 'sw' }, { from: 'sw', to: 'a', label: `case:${name}` }],
        });
        const rec = r.errors.find(e => e.code === 'switch.case_name_reserved');
        assert.ok(rec, `case "${name}": got ${JSON.stringify(codesOf(r))}`);
        assert.match(rec.message, /vanish|reserved/);
        assert.equal(r.ok, false);
    }
});

test('"default" is still the other reserved case name, with its own wording', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', expr: 'trigger.output.kind', cases: [{ name: 'default', value: 1 }] }, note('a')],
        edges: [{ from: 'trg', to: 'sw' }, { from: 'sw', to: 'a', label: 'case:default' }],
    });
    const rec = r.errors.find(e => e.code === 'switch.case_name_reserved');
    assert.ok(rec);
    assert.match(rec.message, /use `defaultBranch` instead/);
});

test('an ordinary case name is untouched', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', expr: 'trigger.output.kind', cases: [{ name: 'invoice', value: 'invoice' }] }, note('a')],
        edges: [{ from: 'trg', to: 'sw' }, { from: 'sw', to: 'a', label: 'case:invoice' }],
    });
    assert.equal(findRec(r, 'switch.case_name_reserved'), undefined);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── BFSF-348 — the form-trigger message ──────────────────────────────────────

test('BFSF-348: the form-trigger error leads with the problem, not a raw step id', () => {
    const r = validateDefinition({
        trigger: trigger(), // manual — no public form URL to serve the page on
        steps: [{
            id: 'step_7c1a', type: 'form_page', mode: 'input',
            form: { title: 'More', fields: [{ name: 'a', type: 'text', label: 'A' }] },
        }],
        edges: [{ from: 'trg', to: 'step_7c1a' }],
    });
    const rec = r.errors.find(e => e.code === 'form_page.no_form_trigger');
    // The CODE is unchanged — the frontend keys on it.
    assert.ok(rec, `got ${JSON.stringify(codesOf(r))}`);

    assert.equal(rec.message, 'This step type requires your automation to start with a Form trigger.');
    assert.ok(!/^Step /.test(rec.message), 'must not open with a raw internal id');
    assert.ok(!rec.message.includes('step_7c1a'), 'the id belongs in path/hint, not at the front of the sentence');

    // …and the half the user can act on is present, with the id still to hand.
    assert.match(rec.hint, /Change the trigger to "Form"/);
    assert.ok(rec.hint.includes('step_7c1a'));
    assert.ok(rec.path.includes('step_7c1a'), 'the canvas maps badges by matching the id in `path`');
});
