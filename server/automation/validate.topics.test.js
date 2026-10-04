/**
 * "Is about" rules in the validator (validate/stepRules/topicRules.js).
 *
 * isAbout parses in a condition, a filter and a switch CASE, and nowhere
 * else. Using it where no topic classifier is configured is a completeness
 * problem: a warning while the automation is a draft, blocking at activation.
 * An unknown classifier state (null) is never a finding.
 *
 * Run: node --test automation/validate.topics.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const trigger = () => ({ id: 'trg', kind: 'manual' });
const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });
const codesOf = (r) => [...r.errors, ...r.warnings].map((x) => x.code);

function routerDef(cases, extra = {}) {
    return {
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', matchMode: 'all', cases, ...extra }, note('a'), note('b')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'a', label: `case:${cases[0].name}`, caseName: cases[0].name },
            { from: 'sw', to: 'b', label: 'case:default', caseName: 'default' },
        ],
    };
}

const TOPIC_CASES = [
    { name: 'complaint', expr: 'isAbout(trigger.output.body, "a complaint")' },
    { name: 'invoice', expr: 'isAbout(trigger.output.body, "an invoice", 0.7)' },
];

test('isAbout in switch cases is clean when a classifier is installed', () => {
    const r = validateDefinition(routerDef(TOPIC_CASES), { topicClassifier: true });
    assert.equal(r.ok, true, JSON.stringify(codesOf(r)));
    assert.ok(!codesOf(r).some((c) => c.startsWith('route.topic')));
});

test('an unknown classifier state is not a finding', () => {
    const r = validateDefinition(routerDef(TOPIC_CASES));
    assert.equal(r.ok, true, JSON.stringify(codesOf(r)));
});

test('no classifier: blocks activation, a warning in a draft', () => {
    const live = validateDefinition(routerDef(TOPIC_CASES), { topicClassifier: false });
    assert.equal(live.ok, false);
    assert.ok(live.errors.some((e) => e.code === 'route.topic_classifier_missing'));

    const draft = validateDefinition(routerDef(TOPIC_CASES), { stage: 'draft', topicClassifier: false });
    assert.equal(draft.ok, true);
    assert.ok(draft.warnings.some((w) => w.code === 'route.topic_classifier_missing' && w.blockedAt === 'activate'));
    assert.ok(COMPLETENESS_CODES.has('route.topic_classifier_missing'));
});

test('an automation without isAbout never gets the classifier finding', () => {
    const r = validateDefinition(routerDef([{ name: 'x', expr: 'trigger.output.n > 1' }]), { topicClassifier: false });
    assert.equal(r.ok, true, JSON.stringify(codesOf(r)));
});

test('too many topics in one step', () => {
    const expr = Array.from({ length: 17 }, (_, i) => `isAbout(trigger.output.body, "topic ${i}")`).join(' || ');
    const r = validateDefinition(routerDef([{ name: 'x', expr }]), { topicClassifier: true });
    assert.ok(r.errors.some((e) => e.code === 'route.topic_labels_too_many'));
});

test('a bad isAbout call is the case\'s own parse error, with the fix in it', () => {
    const r = validateDefinition(routerDef([{ name: 'x', expr: 'isAbout(trigger.output.body, trigger.output.topic)' }]), { topicClassifier: true });
    const rec = r.errors.find((e) => e.code === 'switch.case_expr_parse');
    assert.ok(rec, JSON.stringify(codesOf(r)));
    assert.match(rec.message, /topic in quotes/);
});

test('a condition and a filter may use isAbout', () => {
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'c', type: 'condition', expr: 'isAbout(trigger.output.body, "a complaint")' },
            { id: 'f', type: 'filter', arrayRef: 'trigger.output.items', expr: '!isAbout(item.text, "spam")' },
            note('done'),
        ],
        edges: [
            { from: 'trg', to: 'c' },
            { from: 'c', to: 'f', label: 'then' },
            { from: 'c', to: 'done', label: 'else' },
            { from: 'f', to: 'done' },
        ],
    };
    const ok = validateDefinition(def, { topicClassifier: true });
    assert.ok(!codesOf(ok).some((c) => /expr_parse|topic/.test(c)), JSON.stringify(codesOf(ok)));
    const missing = validateDefinition(def, { topicClassifier: false });
    assert.equal(missing.errors.filter((e) => e.code === 'route.topic_classifier_missing').length, 2);
});

test('a switch VALUE expression is not a rule: isAbout there does not parse', () => {
    const r = validateDefinition(routerDef([{ name: 'x', value: 'y' }], { expr: 'isAbout(trigger.output.body, "a")' }), { topicClassifier: true });
    assert.ok(r.errors.some((e) => e.code === 'switch.expr_parse'), JSON.stringify(codesOf(r)));
});
