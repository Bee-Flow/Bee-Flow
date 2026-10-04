/**
 * BFSF-355 — "Show real values again" with nothing that ever hid anything.
 *
 * The three Privacy Shield stages are one node now, and the contract BETWEEN
 * them is the thing a single node cannot enforce: a reveal only means something
 * downstream of a hide. That shape validated completely clean before, so the
 * author's first sign of trouble was an empty output at run time.
 *
 * It is a WARNING, never an error. The hide may legitimately live in a Step or
 * flowlet this document only calls, and an automation has to stay savable and
 * activatable while it is half-built — a rule that blocks the save would be
 * worse than the problem it reports.
 *
 * Run: node --test automation/validate.privacyShield.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const trigger = () => ({ id: 'trg', kind: 'manual' });
const reveal = (id = 'u1') => ({ id, type: 'untokenize', sourceRef: 'trigger.output.text' });
const hide = (id = 't1') => ({ id, type: 'tokenize', sourceRef: 'trigger.output.body' });
const checkAndHide = (id = 'g1') => ({ id, type: 'guard', sourceRef: 'trigger.output.body', onFound: { tokenize: true } });
const plainCheck = (id = 'g1') => ({ id, type: 'guard', sourceRef: 'trigger.output.body' });

const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);
const def = (steps, extra = {}) => ({
    trigger: trigger(),
    steps,
    edges: steps.map((s, i) => ({ from: i === 0 ? 'trg' : steps[i - 1].id, to: s.id })),
    ...extra,
});

test('a reveal with nothing that hides is warned about', () => {
    const r = validateDefinition(def([reveal()]));
    assert.ok(codesOf(r).includes('untokenize.no_hide_step'));
    const w = r.warnings.find(x => x.code === 'untokenize.no_hide_step');
    assert.equal(w.severity, 'warning');
    assert.match(w.message, /nothing in this automation hides personal data/i);
    assert.match(w.hint, /Hide personal data|Check and hide/);
});

test('it warns but never blocks — the automation still saves and still activates', () => {
    const r = validateDefinition(def([reveal()]));
    assert.equal(r.errors.length, 0, `unexpected errors: ${JSON.stringify(r.errors)}`);
    assert.ok(r.ok, 'a warning must leave the definition valid');
    // Not a completeness code either, so it does not gate activation.
    assert.ok(!COMPLETENESS_CODES.has('untokenize.no_hide_step'));
});

test('a tokenize step anywhere silences it', () => {
    const r = validateDefinition(def([hide(), reveal()]));
    assert.ok(!codesOf(r).includes('untokenize.no_hide_step'));
});

test('a Check + Hide guard counts as hiding — that is the whole point of the mode', () => {
    const r = validateDefinition(def([checkAndHide(), reveal()]));
    assert.ok(!codesOf(r).includes('untokenize.no_hide_step'));
});

test('a PLAIN check does not count: scanning is not hiding', () => {
    const r = validateDefinition(def([plainCheck(), reveal()]));
    assert.ok(codesOf(r).includes('untokenize.no_hide_step'));
});

test('hiding inside a loop body counts', () => {
    const steps = [
        { id: 'lp', type: 'loop', overRef: 'trigger.output.items', body: [hide('inner')] },
        reveal(),
    ];
    const r = validateDefinition(def(steps));
    assert.ok(!codesOf(r).includes('untokenize.no_hide_step'));
});

test('hiding inside a parallel branch counts', () => {
    const steps = [
        { id: 'par', type: 'parallel', branches: [[hide('inner')]] },
        reveal(),
    ];
    const r = validateDefinition(def(steps));
    assert.ok(!codesOf(r).includes('untokenize.no_hide_step'));
});

test('hiding inside a layer counts', () => {
    const d = def([{ id: 'call', type: 'call_layer', layer: 'L1' }, reveal()], {
        layers: {
            L1: {
                steps: [hide('inner'), { id: 'out', type: 'layer_output', fields: {} }],
                edges: [{ from: 'inner', to: 'out' }],
            },
        },
    });
    const r = validateDefinition(d);
    assert.ok(!codesOf(r).includes('untokenize.no_hide_step'));
});

test('every reveal gets its own warning, so a long automation names them all', () => {
    const r = validateDefinition(def([reveal('u1'), reveal('u2')]));
    const hits = r.warnings.filter(x => x.code === 'untokenize.no_hide_step');
    assert.equal(hits.length, 2);
    assert.ok(hits.some(h => h.message.includes('u1')));
    assert.ok(hits.some(h => h.message.includes('u2')));
});

test('an automation with no reveal at all is silent', () => {
    const r = validateDefinition(def([hide(), plainCheck('g2')]));
    assert.ok(!codesOf(r).includes('untokenize.no_hide_step'));
});
