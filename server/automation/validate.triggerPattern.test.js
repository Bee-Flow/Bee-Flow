// @typecheck strict
/**
 * A trigger filter's `subjectRegex`, at save time: it must compile the way the
 * matcher runs it (RE2, or the guarded fallback), so a pattern with nested
 * quantifiers is refused where it is written, also inside `any` / `none` and
 * on an additional trigger; a pattern over 200 characters is refused instead
 * of silently cut.
 *
 * Run: cd server && node --test automation/validate.triggerPattern.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('./validate');

const withFilter = (/** @type {unknown} */ filter) => ({
    trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter } },
    steps: [{ id: 'n', type: 'notify', inputs: { message: { kind: 'literal', value: 'hi' } } }],
    edges: [{ from: 'trg', to: 'n' }],
});
const patternErrors = (/** @type {any} */ r) => r.errors.filter((/** @type {any} */ e) => String(e.code).startsWith('trigger.filter_pattern'));

test('an ordinary pattern, or no pattern, passes', () => {
    for (const filter of [null, {}, { subjectRegex: 'INV-\\d{4}' }, { subjectRegex: '(?i)urgent|asap' }, { any: [{ subjectRegex: 'a|b' }] }]) {
        assert.deepEqual(patternErrors(validateDefinition(withFilter(filter))), [], JSON.stringify(filter));
    }
});

test('a pattern with nested quantifiers that RE2 cannot run is refused, with its path', () => {
    const r = validateDefinition(withFilter({ subjectRegex: '(a+)+(?=b)' }));
    const [e] = patternErrors(r);
    assert.equal(e?.code, 'trigger.filter_pattern_invalid');
    assert.equal(e?.path, 'trigger.appEvent.filter.subjectRegex');
    assert.match(e?.message, /nest/i);
    const broken = patternErrors(validateDefinition(withFilter({ subjectRegex: '[' })));
    assert.equal(broken[0]?.code, 'trigger.filter_pattern_invalid');
});

test('inside any / none, and on an additional trigger, the same check applies', () => {
    const r = validateDefinition(withFilter({ any: [{ subjectRegex: 'ok' }, { subjectRegex: '(a+)+(?=b)' }], none: [{ subjectRegex: '(' }] }));
    assert.deepEqual(patternErrors(r).map((/** @type {any} */ e) => e.path).sort(), [
        'trigger.appEvent.filter.any[1].subjectRegex',
        'trigger.appEvent.filter.none[0].subjectRegex',
    ]);
    const def = /** @type {any} */ (withFilter(null));
    def.triggers = [{ id: 'trg2', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { subjectRegex: '(a+)+(?=b)' } } }];
    assert.ok(patternErrors(validateDefinition(def)).some((/** @type {any} */ e) => e.path.startsWith('triggers[')));
});

test('a pattern longer than the matcher reads is refused rather than cut', () => {
    const [e] = patternErrors(validateDefinition(withFilter({ subjectRegex: 'a'.repeat(201) })));
    assert.equal(e?.code, 'trigger.filter_pattern_too_long');
    assert.deepEqual(patternErrors(validateDefinition(withFilter({ subjectRegex: 'a'.repeat(200) }))), []);
});
