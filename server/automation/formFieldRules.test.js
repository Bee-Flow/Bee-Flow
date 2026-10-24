// @typecheck
const test = require('node:test');
const assert = require('node:assert');

const {
    normalizeRules, validateRules, checkRules, ruleError, compilePattern,
    normalizeShowIf, validateShowIf, isVisible,
} = require('./formFieldRules');

const issuesOf = (fn) => {
    const issues = [];
    fn((code, path, message, hint) => issues.push({ code, path, message, hint }));
    return issues;
};
const rulesOf = (f) => issuesOf(push => validateRules({ name: 'q', ...f }, 'form.fields[0]', push));
const codes = (issues) => issues.map(i => i.code);

// ── normalizeRules ─────────────────────────────────────

test('normalizeRules keeps only the attributes valid for the type', () => {
    assert.deepEqual(normalizeRules({ min: 1, max: '5', minLength: 3, pattern: 'x' }, 'number'), { min: 1, max: 5 });
    assert.deepEqual(normalizeRules({ min: '2026-01-01', max: 'soon', minLength: 3 }, 'date'), { min: '2026-01-01' });
    assert.deepEqual(normalizeRules({ minLength: 2, maxLength: 9, pattern: '[a-z]+', patternMessage: ' Letters only ', min: 1 }, 'text'),
        { minLength: 2, maxLength: 9, pattern: '[a-z]+', patternMessage: 'Letters only' });
    assert.deepEqual(normalizeRules({ minLength: 2, pattern: '[a-z]+' }, 'email'), { minLength: 2 });
    assert.deepEqual(normalizeRules({ minSelected: 1, maxSelected: 3, min: 4 }, 'multiselect'), { minSelected: 1, maxSelected: 3 });
    assert.deepEqual(normalizeRules({ min: 1, minLength: 1 }, 'checkbox'), {});
    assert.deepEqual(normalizeRules(null, 'number'), {});
});

test('normalizeRules drops negative, fractional and non-finite values and caps the length by type', () => {
    assert.deepEqual(normalizeRules({ minLength: -1, maxLength: 2.5 }, 'text'), {});
    assert.deepEqual(normalizeRules({ min: Infinity, max: NaN }, 'number'), {});
    assert.equal(normalizeRules({ maxLength: 999999 }, 'text').maxLength, 5000);
    assert.equal(normalizeRules({ maxLength: 999999 }, 'textarea').maxLength, 20000);
});

test('normalizeRules is idempotent', () => {
    const once = normalizeRules({ minLength: 2, maxLength: 9, pattern: 'a+', patternMessage: 'No' }, 'text');
    assert.deepEqual(normalizeRules(once, 'text'), once);
});

// ── validateRules ──────────────────────────────────────

test('validateRules accepts well-formed rules and an untouched field', () => {
    assert.deepEqual(rulesOf({ type: 'number', min: 1, max: 10 }), []);
    assert.deepEqual(rulesOf({ type: 'text' }), []);
    assert.deepEqual(rulesOf({ type: 'date', min: '2026-01-01', max: '2026-12-31' }), []);
    assert.deepEqual(rulesOf({ type: 'text', minLength: '', maxLength: null }), [], 'a cleared box is no rule');
});

test('validateRules rejects min greater than max for every pair', () => {
    assert.deepEqual(codes(rulesOf({ type: 'number', min: 5, max: 1 })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'date', min: '2026-05-01', max: '2026-01-01' })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'text', minLength: 9, maxLength: 2 })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'multiselect', minSelected: 3, maxSelected: 1 })), ['field_rule_invalid']);
});

test('validateRules rejects a rule on the wrong type, a negative count and a bad value', () => {
    assert.deepEqual(codes(rulesOf({ type: 'checkbox', min: 1 })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'number', minLength: 1 })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'email', pattern: 'a' })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'text', minLength: -1 })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'multiselect', minSelected: 1.5 })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'number', min: 'abc' })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'date', min: '1 May' })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'text', maxLength: 6000 })), ['field_rule_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'text', patternMessage: 'x'.repeat(121) })), ['field_rule_invalid']);
});

test('validateRules caps maxSelected at the options cap', () => {
    const before = process.env.AUTOMATION_FORM_MAX_OPTIONS;
    try {
        process.env.AUTOMATION_FORM_MAX_OPTIONS = '3';
        assert.deepEqual(codes(rulesOf({ type: 'multiselect', maxSelected: 4 })), ['field_rule_invalid']);
        assert.deepEqual(rulesOf({ type: 'multiselect', maxSelected: 3 }), []);
        process.env.AUTOMATION_FORM_MAX_OPTIONS = '0';
        assert.deepEqual(rulesOf({ type: 'multiselect', maxSelected: 5000 }), []);
    } finally {
        if (before === undefined) delete process.env.AUTOMATION_FORM_MAX_OPTIONS; else process.env.AUTOMATION_FORM_MAX_OPTIONS = before;
    }
});

test('validateRules rejects a pattern that is too long or does not compile as RE2', () => {
    assert.deepEqual(codes(rulesOf({ type: 'text', pattern: 'x'.repeat(201) })), ['field_pattern_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'text', pattern: '(' })), ['field_pattern_invalid']);
    assert.deepEqual(codes(rulesOf({ type: 'text', pattern: '(?=a)b' })), ['field_pattern_invalid'], 'look-ahead is not RE2');
    assert.deepEqual(codes(rulesOf({ type: 'text', pattern: '(a)\\1' })), ['field_pattern_invalid'], 'back-references are not RE2');
    assert.deepEqual(codes(rulesOf({ type: 'text', pattern: 7 })), ['field_pattern_invalid']);
    assert.deepEqual(rulesOf({ type: 'textarea', pattern: '[A-Z]{2}-\\d{3}' }), []);
});

test('a pattern that would escape its anchors is refused, not wrapped', () => {
    // Wrapped as ^(?:a)|(b)$ this would compile and match "a<anything>".
    assert.equal(compilePattern('a)|(b'), null);
    assert.deepEqual(codes(rulesOf({ type: 'text', pattern: 'a)|(b' })), ['field_pattern_invalid']);
});

// ── checkRules ─────────────────────────────────────────

test('checkRules judges numbers, dates and counts', () => {
    assert.equal(checkRules({ type: 'number', min: 3, max: 10 }, 2), 'must be at least 3');
    assert.equal(checkRules({ type: 'number', min: 3, max: 10 }, 11), 'must be at most 10');
    assert.equal(checkRules({ type: 'number', min: 3, max: 10 }, 3), null);
    assert.equal(checkRules({ type: 'date', min: '2026-01-10' }, '2026-01-09'), 'must be on or after 2026-01-10');
    assert.equal(checkRules({ type: 'date', max: '2026-01-10' }, '2026-01-11'), 'must be on or before 2026-01-10');
    assert.equal(checkRules({ type: 'multiselect', minSelected: 2 }, ['a']), 'must have at least 2 choices');
    assert.equal(checkRules({ type: 'multiselect', minSelected: 1 }, []), null, 'a blank value is the required rule\'s business');
    assert.equal(checkRules({ type: 'multiselect', maxSelected: 1 }, ['a', 'b']), 'must have at most 1 choice');
});

test('checkRules judges text length and counts characters, not UTF-16 units', () => {
    assert.equal(checkRules({ type: 'text', minLength: 3 }, 'ab'), 'must be at least 3 characters');
    assert.equal(checkRules({ type: 'text', maxLength: 3 }, 'abcd'), 'must be at most 3 characters');
    assert.equal(checkRules({ type: 'text', maxLength: 2 }, '😀😀'), null);
    assert.equal(checkRules({ type: 'email', maxLength: 5 }, 'a@b.nl.x'), 'must be at most 5 characters');
    assert.equal(checkRules({ type: 'text', minLength: 3 }, ''), null, 'blank is never checked');
});

test('checkRules matches the pattern against the WHOLE value', () => {
    const f = { type: 'text', pattern: '[A-Z]{2}-\\d{3}' };
    assert.equal(checkRules(f, 'AB-123'), null);
    assert.equal(checkRules(f, 'AB-1234'), 'is not in the expected format');
    assert.equal(checkRules(f, 'xAB-123'), 'is not in the expected format');
    // An alternation must not escape the anchors.
    assert.equal(checkRules({ type: 'text', pattern: 'a|b' }, 'ab'), 'is not in the expected format');
    assert.equal(checkRules({ type: 'text', pattern: 'a|b' }, 'b'), null);
});

test('ruleError prefixes the label, and shows a patternMessage as written', () => {
    assert.equal(ruleError({ type: 'number', label: 'Count', min: 3 }, 2), 'Count must be at least 3.');
    assert.equal(ruleError({ type: 'text', label: 'Code', pattern: 'a+' }, 'b'), 'Code is not in the expected format.');
    assert.equal(ruleError({ type: 'text', label: 'Code', pattern: 'a+', patternMessage: 'Use only the letter a.' }, 'b'), 'Use only the letter a.');
    assert.equal(ruleError({ type: 'text', label: 'Code', pattern: 'a+' }, 'aa'), null);
});

test('a pattern that cannot compile never blocks a visitor', () => {
    assert.equal(checkRules({ type: 'text', pattern: '(' }, 'anything'), null);
});

test('a catastrophic pattern finishes in linear time (RE2)', () => {
    const started = Date.now();
    const verdict = checkRules({ type: 'text', pattern: '(a+)+$' }, `${'a'.repeat(50000)}b`);
    assert.equal(verdict, 'is not in the expected format');
    assert.ok(Date.now() - started < 2000, 'a backtracking engine would take far longer');
});

// ── showIf ─────────────────────────────────────────────

const showIfIssues = (src, earlier = ['contact', 'topics', 'company']) =>
    issuesOf(push => validateShowIf(src, earlier, 'form.fields[3].showIf', push));

test('normalizeShowIf trims and bounds', () => {
    assert.equal(normalizeShowIf('  form.a == "x"  '), 'form.a == "x"');
    assert.equal(normalizeShowIf(''), '');
    assert.equal(normalizeShowIf(7), '');
    assert.equal(normalizeShowIf('x'.repeat(501)), '');
});

test('validateShowIf accepts conditions on earlier fields', () => {
    assert.deepEqual(showIfIssues('form.contact == "email"'), []);
    assert.deepEqual(showIfIssues('contains(form.topics, "billing")'), []);
    assert.deepEqual(showIfIssues('!isEmpty(form.company)'), []);
    assert.deepEqual(showIfIssues('form.contact == "email" && form["company"] != ""'), []);
});

test('validateShowIf rejects text that does not parse', () => {
    assert.deepEqual(codes(showIfIssues('form.contact ==')), ['field_show_if_invalid']);
    assert.deepEqual(codes(showIfIssues('nope(form.contact)')), ['field_show_if_invalid']);
    assert.deepEqual(codes(showIfIssues('')), ['field_show_if_invalid']);
    assert.deepEqual(codes(showIfIssues('x'.repeat(501))), ['field_show_if_invalid']);
});

test('validateShowIf rejects any root other than form', () => {
    assert.deepEqual(codes(showIfIssues('steps.load.output.ok == true')), ['field_show_if_invalid']);
    assert.deepEqual(codes(showIfIssues('form.contact == "a" && trigger.x')), ['field_show_if_invalid']);
    assert.deepEqual(codes(showIfIssues('contains(vars.list, form.contact)')), ['field_show_if_invalid']);
    assert.deepEqual(codes(showIfIssues('secrets.key == "x"')), ['field_show_if_invalid']);
});

test('validateShowIf rejects a later or unknown field and a bare form', () => {
    assert.deepEqual(codes(showIfIssues('form.later == "x"')), ['field_show_if_invalid']);
    assert.deepEqual(codes(showIfIssues('form.contact == "a"', [])), ['field_show_if_invalid'], 'the first field cannot depend on anything');
    assert.deepEqual(codes(showIfIssues('isEmpty(form)')), ['field_show_if_invalid']);
    assert.deepEqual(codes(showIfIssues('form[form.contact] == "x"')), ['field_show_if_invalid'], 'a computed field name cannot be checked');
    assert.deepEqual(codes(showIfIssues('form.contact == "a" && form.later == "b"')), ['field_show_if_invalid']);
});

test('isVisible evaluates against the earlier answers', () => {
    assert.equal(isVisible('', {}), true);
    assert.equal(isVisible(undefined, {}), true);
    assert.equal(isVisible('form.contact == "email"', { contact: 'email' }), true);
    assert.equal(isVisible('form.contact == "email"', { contact: 'phone' }), false);
    assert.equal(isVisible('contains(form.topics, "billing")', { topics: ['billing', 'other'] }), true);
    assert.equal(isVisible('contains(form.topics, "billing")', { topics: [] }), false);
    assert.equal(isVisible('!isEmpty(form.company)', { company: '' }), false);
});

test('isVisible fails open: a condition that cannot run shows the question', () => {
    assert.equal(isVisible('form.contact ==', {}), true);
    assert.equal(isVisible('nope(1)', {}), true);
});
