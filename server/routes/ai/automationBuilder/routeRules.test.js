/**
 * The Condition node's model fallback, and the two things that make it safe
 * to have one.
 *
 * THE FEATURE. A rule's predicate is a restricted-grammar expression, so
 * "split these files by pdf, word and powerpoint" is five comparisons across
 * three outputs, all hinging on an "ends with" operator beginners never find.
 * They pick "equals", type ".pdf", and get an output that matches nothing —
 * silently, because an empty branch is a legal result. The editor answers the
 * common shapes offline; this route is the fallback for the sentences it does
 * not know.
 *
 * WHAT IS PINNED HERE is not "the route calls a model". It is the two
 * guardrails:
 *
 *   1. VALUES NEVER LEAVE. The request carries field names, display names and
 *      types. A Condition node in this product routinely sits over customer
 *      records, and personal data does not leave Bee Flow (CLAUDE.md,
 *      BFSF-441). The allow-list is built positively — three keys, named —
 *      rather than by deleting keys from what the client posted, so a field
 *      object that grows a `sampleValue` next year cannot start leaking one.
 *
 *   2. THE MODEL CANNOT INVENT A FIELD. Every returned expression is parsed
 *      with the RUNNER'S OWN grammar and every path it mentions must have
 *      been declared. A model that answers `item.customer.email` because the
 *      sentence said "customer" produces a rule that parses perfectly and
 *      matches nothing forever — re-creating, through the fallback, the exact
 *      failure the feature exists to remove.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/routeRules.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    validateRouteRulesRequest,
    verifyRouteRules,
    collectFieldPaths,
    routeRulesProblem,
    routeRulesSystemPrompt,
    MAX_ROUTE_RULES,
} = require('./routeRules');
const { CONDITION_RULES_HINT } = require('../../../automation/builderTools/ruleExamples');
const { parseExpr } = require('../../../automation/expr');

const FIELDS = [
    { key: 'name', name: 'File name', type: 'text' },
    { key: 'size', name: 'Size', type: 'number' },
    { key: 'status', name: 'Status', type: 'text' },
];

// ── 1. What goes out ────────────────────────────────────────────────────────

test('the request carries field names and NOT values', () => {
    const out = validateRouteRulesRequest({
        description: 'split by file type',
        fields: [{
            key: 'name',
            name: 'File name',
            type: 'text',
            // Everything below is what a caller might plausibly hand us, and
            // none of it may survive: these are the customer's rows.
            sampleValue: 'Jan de Vries - offerte.pdf',
            values: ['a@b.nl', 'c@d.nl'],
            example: 'BSN 123456789',
        }],
    });
    assert.ok(!out.error, out.error);
    assert.deepStrictEqual(out.fields, [{ key: 'name', name: 'File name', type: 'text' }]);
});

test('the allow-list is positive — an unknown key is not carried, whatever it is called', () => {
    // The point of building from an allow-list rather than a deny-list: this
    // test keeps passing when someone adds a new property upstream.
    const out = validateRouteRulesRequest({
        description: 'x',
        fields: [{ key: 'name', somethingAddedNextYear: 'personal data' }],
    });
    assert.deepStrictEqual(Object.keys(out.fields[0]).sort(), ['key', 'name', 'type']);
});

test('refuses when there are no fields, rather than asking a model to guess', () => {
    // Without a declared field list the verification that makes this route
    // safe cannot run at all, so there is no safe way to answer.
    const out = validateRouteRulesRequest({ description: 'split by type', fields: [] });
    assert.match(out.error, /Run or pin the step above/);
});

test('refuses an empty or oversized description', () => {
    assert.ok(validateRouteRulesRequest({ description: '   ', fields: FIELDS }).error);
    assert.match(
        validateRouteRulesRequest({ description: 'x'.repeat(501), fields: FIELDS }).error,
        /too long/,
    );
});

test('an itemVar that is not an identifier falls back instead of being interpolated', () => {
    // It is pasted into the prompt as a path prefix; anything but an
    // identifier there is either a typo or an injection attempt.
    assert.strictEqual(validateRouteRulesRequest({ description: 'x', fields: FIELDS, itemVar: 'row' }).itemVar, 'row');
    assert.strictEqual(validateRouteRulesRequest({ description: 'x', fields: FIELDS, itemVar: 'a b' }).itemVar, 'item');
    assert.strictEqual(validateRouteRulesRequest({ description: 'x', fields: FIELDS, itemVar: 7 }).itemVar, 'item');
});

// ── 2. What comes back ──────────────────────────────────────────────────────

test('a good suggestion survives whole', () => {
    const rules = verifyRouteRules([
        { name: 'Word documents', expr: 'endsWith(item.name, ".doc") || endsWith(item.name, ".docx")' },
        { name: 'PDFs', expr: 'endsWith(item.name, ".pdf")' },
    ], { fields: FIELDS });
    assert.strictEqual(rules.length, 2);
    assert.strictEqual(rules[0].name, 'Word documents');
    assert.match(rules[0].expr, /\.docx/);
});

test('A RULE OVER A FIELD THAT DOES NOT EXIST IS DROPPED — the whole point', () => {
    // It parses perfectly. It would sit on the canvas looking correct and
    // match nothing for the rest of the automation's life. That silent empty
    // branch is the failure this feature exists to remove, so the fallback
    // may not re-introduce it.
    const rules = verifyRouteRules([
        { name: 'Customers', expr: 'contains(item.customer.email, "@")' },
        { name: 'Big files', expr: 'item.size > 1000' },
    ], { fields: FIELDS });
    assert.deepStrictEqual(rules.map(r => r.name), ['Big files']);
});

test('an expression that would throw at run time never reaches the canvas', () => {
    // Parsed with the RUNNER'S grammar, not a regex that approximates it.
    const rules = verifyRouteRules([
        { name: 'Broken', expr: 'endsWith(item.name, ".pdf"' },
        { name: 'Templated', expr: '{{item.name}} == "x"' },
        { name: 'Fine', expr: 'item.status == "open"' },
    ], { fields: FIELDS });
    assert.deepStrictEqual(rules.map(r => r.name), ['Fine']);
});

test('a rule that mentions no field at all is dropped', () => {
    // A constant matches everything or nothing regardless of the data, which
    // is never what the author described.
    assert.deepStrictEqual(verifyRouteRules([{ name: 'Always', expr: '1 == 1' }], { fields: FIELDS }), []);
});

test('a rule reaching outside the row is dropped, secrets included', () => {
    const rules = verifyRouteRules([
        { name: 'From another step', expr: 'steps.s1.output.total > 3' },
        { name: 'Credential', expr: 'contains(secrets.api_key, "sk-")' },
        { name: 'Trigger', expr: 'trigger.output.kind == "manual"' },
    ], { fields: FIELDS });
    assert.deepStrictEqual(rules, []);
});

test('the loop variable may be spelled either way, so a rename does not drop a correct rule', () => {
    const rules = verifyRouteRules([
        { name: 'A', expr: 'row.status == "open"' },
        { name: 'B', expr: 'item.status == "closed"' },
    ], { fields: FIELDS, itemVar: 'row' });
    assert.deepStrictEqual(rules.map(r => r.name), ['A', 'B']);
});

test('a bare field name works for a whole-run condition', () => {
    const rules = verifyRouteRules([{ name: 'Open', expr: 'status == "open"' }], { fields: FIELDS });
    assert.strictEqual(rules.length, 1);
});

test('two outputs with the same name collapse to one — a port name is its identity', () => {
    const rules = verifyRouteRules([
        { name: 'PDFs', expr: 'endsWith(item.name, ".pdf")' },
        { name: 'pdfs', expr: 'endsWith(item.name, ".PDF")' },
    ], { fields: FIELDS });
    assert.strictEqual(rules.length, 1);
});

test('the port count is capped, because a canvas card has a size', () => {
    const many = Array.from({ length: MAX_ROUTE_RULES + 5 }, (_, i) => ({
        name: `Out ${i}`, expr: `item.size > ${i}`,
    }));
    assert.strictEqual(verifyRouteRules(many, { fields: FIELDS }).length, MAX_ROUTE_RULES);
});

test('junk from the model is survived rather than thrown on', () => {
    for (const junk of [null, undefined, 'a string', 42, [null, 'x', {}, { name: 'a' }, { expr: 'b' }]]) {
        assert.deepStrictEqual(verifyRouteRules(junk, { fields: FIELDS }), []);
    }
});

// ── 3. The path walker the verification rests on ────────────────────────────

test('collectFieldPaths sees through every place the grammar hides a path', () => {
    // It mirrors engine.mjs collectRefs by hand (collectRefs returns ROOTS
    // only, which cannot answer "is `emial` a real field"). If the grammar
    // grows a node kind, this is where it shows up — rather than as a rule
    // that quietly stops being checked.
    const paths = (src) => [...collectFieldPaths(parseExpr(src))].sort();
    assert.deepStrictEqual(paths('item.a == 1 && item.b == 2'), ['item.a', 'item.b']);
    assert.deepStrictEqual(paths('!isEmpty(item.a)'), ['item.a']);
    assert.deepStrictEqual(paths('item.a ? item.b : item.c'), ['item.a', 'item.b', 'item.c']);
    assert.deepStrictEqual(paths('contains(lower(item.a), "x")'), ['item.a']);
    assert.deepStrictEqual(paths('item.list[0] == 1'), ['item.list']);
    assert.deepStrictEqual(paths('item'), ['item']);
});

test('a path hidden inside an index expression is still seen', () => {
    // `a[b.c]` — the index is a whole expression, and a model could reach an
    // undeclared field through it. Dropping that branch of the walk would be
    // a hole with no visible symptom.
    assert.deepStrictEqual([...collectFieldPaths(parseExpr('item.list[item.idx] == 1'))].sort(),
        ['item.idx', 'item.list']);
});

// ── 4. What the author is told when nothing survived ────────────────────────

test('the model\'s own sentence is preferred when it said what was missing', () => {
    assert.strictEqual(
        routeRulesProblem({ problem: 'There is no date field to compare against.' }, []),
        'There is no date field to compare against.',
    );
});

test('silence gets a sentence that says what to try, not an empty box', () => {
    assert.match(routeRulesProblem({}, []), /could not turn that into conditions/i);
    assert.match(routeRulesProblem(null, []), /for example/i);
});

test('nothing is said when rules survived', () => {
    assert.strictEqual(routeRulesProblem({ problem: 'ignored' }, [{ name: 'a', expr: 'b' }]), '');
});

// ── 5. Already-scoped keys, which is what the editor actually sends ─────────

test('a key that already carries its scope is used as-is, not prefixed twice', () => {
    // The editor's field options are full paths ("item.name"). Prefixing the
    // loop variable onto them would put `item.item.name` in the prompt — a
    // path that parses, names no real field, and is then correctly dropped by
    // the verification, leaving the author an empty answer and no way to see
    // why. The bug is invisible in the model call and only shows as "the AI
    // never suggests anything".
    const scoped = [{ key: 'item.name', name: 'File name', type: 'text' }];
    const rules = verifyRouteRules(
        [{ name: 'PDFs', expr: 'endsWith(item.name, ".pdf")' }],
        { fields: scoped, itemVar: 'item' },
    );
    assert.strictEqual(rules.length, 1);
});

test('a scoped key does NOT quietly authorise the same name under another scope', () => {
    // Declaring `item.name` must not also declare `row.name` or a bare
    // `name`: those are different data, and accepting them would be the
    // invented-field hole under a different spelling.
    const scoped = [{ key: 'item.name', name: 'File name', type: 'text' }];
    assert.deepStrictEqual(
        verifyRouteRules([{ name: 'A', expr: 'endsWith(row.name, ".pdf")' }], { fields: scoped, itemVar: 'row' }),
        [],
    );
    assert.deepStrictEqual(
        verifyRouteRules([{ name: 'B', expr: 'endsWith(name, ".pdf")' }], { fields: scoped }),
        [],
    );
});

// ── "Is about" (topic classifier) ───────────────────────────────────────────

test('isAbout survives only when the topic classifier was offered', () => {
    const proposals = [
        { name: 'Complaints', expr: 'isAbout(item.status, "a complaint")' },
        { name: 'Open', expr: 'item.status == "open"' },
    ];
    assert.deepStrictEqual(verifyRouteRules(proposals, { fields: FIELDS }).map(r => r.name), ['Open'],
        'without a classifier the rule cannot run, so it is dropped');
    assert.deepStrictEqual(verifyRouteRules(proposals, { fields: FIELDS, topics: true }).map(r => r.name), ['Complaints', 'Open']);
});

test('an isAbout over an undeclared field is dropped like any other', () => {
    const rules = verifyRouteRules([
        { name: 'Complaints', expr: 'isAbout(item.body, "a complaint")' },
    ], { fields: FIELDS, topics: true });
    assert.deepStrictEqual(rules, []);
});

// ── A3/A4: File type and list columns ───────────────────────────────────────

// The editor's field menu for a mail (shared ruleFieldOptions): the list of
// attachments once, its File type, and its columns, each by the path the row
// writes.
const MAIL_FIELDS = [
    { key: 'item.from', name: 'From', type: 'text' },
    { key: 'item.attachments', name: 'Attachments', type: 'list' },
    { key: 'fileType(item.attachments[*])', name: 'File type', type: 'text' },
    { key: 'item.attachments[*].mimeType', name: 'Mime type', type: 'text' },
];

test('A4: fileType over a declared list of files reads a declared field', () => {
    const rules = verifyRouteRules([
        { name: 'pdf', expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")' },
        { name: 'word', expr: 'anyOf(fileType(item.attachments[*]), "equals", "word")' },
    ], { fields: MAIL_FIELDS });
    assert.deepStrictEqual(rules.map(r => r.name), ['pdf', 'word']);
});

test('A4: fileType(<declared path>) and the declared File type of the item both count', () => {
    const rules = verifyRouteRules([
        { name: 'by name', expr: 'equals(fileType(item.filename), "pdf")' },
        { name: 'the file', expr: 'equals(fileType(item), "pdf")' },
    ], { fields: [{ key: 'item.filename', name: 'Filename', type: 'text' }, { key: 'fileType(item)', name: 'File type', type: 'text' }] });
    assert.deepStrictEqual(rules.map(r => r.name), ['by name', 'the file']);
});

test('A4: a column of a declared list reads a declared field, under either declaration', () => {
    const viaColumn = verifyRouteRules(
        [{ name: 'pdf', expr: 'anyOf(item.attachments[*].mimeType, "contains", "pdf")' }],
        { fields: [{ key: 'item.attachments[*].mimeType', name: 'Mime type', type: 'text' }] },
    );
    assert.strictEqual(viaColumn.length, 1, 'the column itself was declared');
    const viaList = verifyRouteRules(
        [{ name: 'pdf', expr: 'anyOf(item.attachments[*].filename, "endsWith", ".pdf")' }],
        { fields: [{ key: 'item.attachments', name: 'Attachments', type: 'list' }] },
    );
    assert.strictEqual(viaList.length, 1, 'the list was declared');
});

test('A4: an undeclared list, or fileType of an undeclared field, is still dropped', () => {
    const rules = verifyRouteRules([
        { name: 'typo', expr: 'anyOf(fileType(item.atachments[*]), "equals", "pdf")' },
        { name: 'column typo', expr: 'anyOf(item.atachments[*].mimeType, "contains", "pdf")' },
        { name: 'the row', expr: 'equals(fileType(item), "pdf")' },
    ], { fields: MAIL_FIELDS });
    assert.deepStrictEqual(rules, [], 'File type of the row was not declared for a mail');
});

test('A3: the Suggest-outputs prompt teaches the row shapes and fileType, not endsWith or lower()', () => {
    const sys = routeRulesSystemPrompt({ topics: false });
    assert.ok(sys.includes(CONDITION_RULES_HINT));
    assert.match(sys, /anyOf\(fileType\(<list>\[\*\]\), "equals", "pdf"\)/);
    assert.ok(!/lower\(s\)|upper\(s\)/.test(sys), 'lower()/upper() are no longer offered');
    assert.ok(!/answered with endsWith\(\)/.test(sys), 'file types are no longer taught as endsWith()');
    assert.ok(!sys.includes('isAbout'), 'isAbout only with the topic classifier');
    assert.ok(routeRulesSystemPrompt({ topics: true }).includes('isAbout'));
});
