/**
 * BFSF-356 — `switch.matchMode`, the fan-out opt-in.
 *
 * The field decides whether a record that matches several outputs goes down
 * all of them or only the first. ABSENT means 'first', which is what every
 * stored switch does and must keep doing.
 *
 * A typo therefore cannot be forgiven: 'al' or 'every' would read as 'first'
 * in the engine (defence in depth) — the exact opposite of what the author
 * wrote, and the opposite means duplicate mails/tickets/API writes appearing
 * or silently not appearing. That is the class of surprise this ticket is
 * about, so it is an INTEGRITY error: it blocks a draft save too. No stored
 * definition can trip it, because the key did not exist before this change.
 *
 * Run: node --test automation/validate.switchMatchMode.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const trigger = () => ({ id: 'trg', kind: 'manual' });
const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });
const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);

/** A wired two-output router whose only variable is `matchMode`. */
function routerDef(matchMode) {
    const step = {
        id: 'sw', type: 'switch',
        cases: [
            { name: 'land', expr: 'contains(trigger.output.note, "land")' },
            { name: 'water', expr: 'contains(trigger.output.note, "water")' },
        ],
    };
    if (matchMode !== undefined) step.matchMode = matchMode;
    return {
        trigger: trigger(),
        steps: [step, note('landStep'), note('waterStep')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'landStep', label: 'case:land', caseName: 'land' },
            { from: 'sw', to: 'waterStep', label: 'case:water', caseName: 'water' },
        ],
    };
}

test('a switch with no matchMode is clean — the absent field is every stored router', () => {
    const r = validateDefinition(routerDef(undefined));
    assert.equal(r.ok, true, JSON.stringify(codesOf(r)));
});

test("both spellings of the field validate", () => {
    for (const mode of ['first', 'all']) {
        const r = validateDefinition(routerDef(mode));
        assert.equal(r.ok, true, `${mode}: ${JSON.stringify(codesOf(r))}`);
    }
    // `null` reads as absent, the same convention `defaultBranch: null` uses.
    assert.equal(validateDefinition(routerDef(null)).ok, true);
});

test('a typo is REJECTED rather than silently meaning the opposite', () => {
    for (const bogus of ['al', 'every', 'ALL', 'First', true, 2, ['all']]) {
        const r = validateDefinition(routerDef(bogus));
        const rec = r.errors.find(e => e.code === 'switch.matchMode_invalid');
        assert.ok(rec, `${JSON.stringify(bogus)}: expected switch.matchMode_invalid, got ${JSON.stringify(codesOf(r))}`);
        assert.equal(r.ok, false);
        assert.match(rec.path, /\.matchMode$/);
        assert.match(rec.hint, /first matching output/);
    }
});

test('it blocks a DRAFT save too — this is integrity, not completeness', () => {
    assert.equal(COMPLETENESS_CODES.has('switch.matchMode_invalid'), false);
    const draft = validateDefinition(routerDef('any'), { stage: 'draft' });
    assert.equal(draft.ok, false, JSON.stringify(codesOf(draft)));
    assert.ok(draft.errors.some(e => e.code === 'switch.matchMode_invalid'));
});
