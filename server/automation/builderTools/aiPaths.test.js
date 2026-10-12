/**
 * aiPaths — reading a path the AI wrote without corrupting a valid one.
 *
 * REGRESSION (findings C1, 2026-10): the builder's normaliser turned every
 * bracket into a dot and cut the path at the first character outside
 * [A-Za-z0-9_.$], so `value[0].from` became `value.0.from`,
 * `fields["Story Points"]` became `fields.Story`, `["price-with-tax"]` became
 * `.price` (another field), `[*]` and `["@odata.nextLink"]` became a
 * trailing dot. These pin the opposite: a path the run reads keeps its
 * meaning; only debris, stray spelling and unquoted spaced keys are touched.
 *
 * Run: cd server && node --test automation/builderTools/aiPaths.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAiPath, canonicalAiPath, hasPlaceholder, placeholdersOf } = require('./aiPaths');
const { getPath } = require('../expr');

const path = p => normalizeAiPath(p).path;

test('a path the run can read keeps its meaning: index, wildcard, quoted keys, match', () => {
    for (const p of [
        'steps.g.output.value[0].from.emailAddress.address',
        'steps.j.output.fields["Story Points"]',
        'steps.g.output["@odata.nextLink"]',
        'steps.g.output.value[*].subject',
        'steps.shop.output.order["price-with-tax"]',
        'steps.gmail.output.messages[0].payload.parts[0].parts[0].body.data',
        'steps.g.output.payload.headers[name="Subject"].value',
        'steps.read.output.results[*].output.attachments',
        'steps.x.output.items[-1].id',
    ]) {
        assert.equal(path(p), p, p);
        assert.equal(normalizeAiPath(p).debris, null, p);
        assert.deepEqual(normalizeAiPath(p).notes, [], p);
    }
});

test('the price-with-tax key still reads its own value, not the price', () => {
    const root = { steps: { shop: { output: { order: { price: '10.00', 'price-with-tax': '12.10' } } } } };
    assert.equal(getPath(root, path('steps.shop.output.order["price-with-tax"]')), '12.10');
    // the dotted spelling of the same key also reads it (the grammar allows `-`)
    assert.equal(getPath(root, path('steps.shop.output.order.price-with-tax')), '12.10');
});

test('respellings are canonical: .0 → [0] (named), single quotes, quoted identifiers', () => {
    const r = normalizeAiPath('trigger.output.attachments.0.attachmentId');
    assert.equal(r.path, 'trigger.output.attachments[0].attachmentId');
    assert.match(r.notes.join(' '), /\[0\], not \.0/);
    assert.equal(path("steps.a.output['first name']"), 'steps.a.output["first name"]');
    assert.equal(path('steps.a.output["subject"]'), 'steps.a.output.subject');
    assert.equal(path("steps.g.output.headers[name = 'Subject'].value"), 'steps.g.output.headers[name="Subject"].value');
});

test('the weak-model spellings are still repaired silently: $, leading dot, whitespace, bare names in brackets', () => {
    assert.equal(path('$steps.x.output.y'), 'steps.x.output.y');
    assert.equal(path('.steps.x.output.y'), 'steps.x.output.y');
    assert.equal(path('steps . x . output . y'), 'steps.x.output.y');
    assert.equal(path(' $steps[a1].output["items"] '), 'steps.a1.output.items');
    assert.equal(path('$loop[r].content'), 'loop.r.content');
    assert.equal(path('steps.$search.output.results'), 'steps.$search.output.results', 'a tempId handle is a name');
});

test('the Gemma tail is trimmed after the LONGEST valid prefix, and reported', () => {
    const r = normalizeAiPath('loop.x.output.leverancier\\"}}}},tempId:');
    assert.equal(r.path, 'loop.x.output.leverancier');
    assert.equal(r.debris, '\\"}}}},tempId:');
    // debris after a bracket path keeps the brackets
    const b = normalizeAiPath('steps.a.output.items[0].name"}},');
    assert.equal(b.path, 'steps.a.output.items[0].name');
    assert.equal(b.debris, '"}},');
});

test('an unquoted key with spaces becomes one quoted key, also mid-path', () => {
    const r = normalizeAiPath('steps.j.output.fields.Story Points');
    assert.equal(r.path, 'steps.j.output.fields["Story Points"]');
    assert.match(r.notes.join(' '), /\["Story Points"\]/);
    assert.equal(path('steps.j.output.fields.Story Points.value'), 'steps.j.output.fields["Story Points"].value');
    // an expression is not a key: `+` never merges
    assert.equal(normalizeAiPath('steps.a.output.total + 1').debris, ' + 1');
});

test('templates keep what does not parse whole (trimDebris:false)', () => {
    assert.equal(canonicalAiPath('steps.a.output.total + 1'), 'steps.a.output.total + 1');
    assert.equal(canonicalAiPath('steps.a.output.items.0.x'), 'steps.a.output.items[0].x');
});

test('placeholder scanning is quote-aware', () => {
    assert.equal(hasPlaceholder('Hi {{ trigger.output.from }}'), true);
    assert.equal(hasPlaceholder('no braces'), false);
    assert.deepEqual(placeholdersOf('{{ steps.x.output["a}b"] }} and {{trigger.output.subject}}'), ['steps.x.output["a}b"]', 'trigger.output.subject']);
});

// REGRESSION (review 2026-10): repeated dots were collapsed over the whole
// string, inside quoted keys and match values too: `["Opmerkingen..."]` was
// stored as `["Opmerkingen."]` (empty at run time) and `[name="v1..2"]` as
// `[name="v1.2"]` (ANOTHER entry), with no note.
test('dots inside a quoted key or a match value are data, not path punctuation', () => {
    for (const p of ['steps.c.output["Opmerkingen..."]', 'steps.a.output["a..b"].x', 'steps.a.output.list[name="v1..2"].v', 'steps.c.output["Total.."]']) {
        assert.equal(path(p), p, p);
    }
    assert.equal(path("$..steps.c.output['a..b']"), 'steps.c.output["a..b"]', 'a repair elsewhere in the path keeps the quoted dots');
    assert.equal(path('steps..c...output.x'), 'steps.c.output.x', 'unquoted runs still collapse');
    assert.equal(path('steps . . c.output'), 'steps.c.output');
});
