/**
 * Run: cd server && node --test core/meetingNotes/llmJson.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseJsonArray, parseJsonObject } = require('./llmJson');

// ── arrays (action items) ────────────────────────────────────────────

test('parseJsonArray reads a clean array', () => {
    const r = parseJsonArray('[{"text":"Bellen","assignee":"Tom","timestamp":"12:30"}]');
    assert.strictEqual(r.salvaged, false);
    assert.strictEqual(r.value.length, 1);
    assert.strictEqual(r.value[0].assignee, 'Tom');
});

test('parseJsonArray ignores prose and code fences around the JSON', () => {
    const r = parseJsonArray('Here you go:\n```json\n[{"text":"A"},{"text":"B"}]\n```\nHope that helps!');
    assert.strictEqual(r.salvaged, false);
    assert.deepStrictEqual(r.value.map(i => i.text), ['A', 'B']);
});

test('parseJsonArray salvages N-1 items from a reply truncated mid-object', () => {
    // The failure that matters: output ceiling hit partway through item 3.
    const truncated = '[{"text":"A","assignee":"Tom"},{"text":"B","assignee":"Gerard"},{"text":"C","assig';
    const r = parseJsonArray(truncated);
    assert.strictEqual(r.salvaged, true);
    assert.strictEqual(r.value.length, 2);
    assert.deepStrictEqual(r.value.map(i => i.text), ['A', 'B']);
});

test('parseJsonArray salvages when truncated exactly on the separator', () => {
    const r = parseJsonArray('[{"text":"A"},{"text":"B"},');
    assert.strictEqual(r.salvaged, true);
    assert.deepStrictEqual(r.value.map(i => i.text), ['A', 'B']);
});

test('parseJsonArray reads an empty array without claiming salvage', () => {
    const r = parseJsonArray('[]');
    assert.strictEqual(r.salvaged, false);
    assert.deepStrictEqual(r.value, []);
});

test('parseJsonArray returns null when there is nothing usable', () => {
    assert.strictEqual(parseJsonArray('I could not find any action items.'), null);
    assert.strictEqual(parseJsonArray(''), null);
    assert.strictEqual(parseJsonArray(null), null);
    // Opened but truncated before any element completed — nothing to salvage.
    assert.strictEqual(parseJsonArray('[{"text":"A'), null);
});

test('parseJsonArray preserves nested objects when salvaging', () => {
    const r = parseJsonArray('[{"text":"A","meta":{"x":1}},{"text":"B","meta":{"y":2}},{"text":"C');
    assert.strictEqual(r.salvaged, true);
    assert.strictEqual(r.value.length, 2);
    assert.deepStrictEqual(r.value[1].meta, { y: 2 });
});

// ── objects (speaker mapping) ────────────────────────────────────────

test('parseJsonObject reads a clean mapping', () => {
    const r = parseJsonObject('{"speaker_1":"Tom","speaker_2":"Gerard"}');
    assert.strictEqual(r.salvaged, false);
    assert.deepStrictEqual(r.value, { speaker_1: 'Tom', speaker_2: 'Gerard' });
});

test('parseJsonObject ignores surrounding prose', () => {
    const r = parseJsonObject('Sure!\n{"speaker_1":"Tom"}\nLet me know.');
    assert.deepStrictEqual(r.value, { speaker_1: 'Tom' });
});

test('parseJsonObject salvages a mapping truncated mid-pair', () => {
    // Losing this whole mapping means the meeting gets NO names at all.
    const r = parseJsonObject('{"speaker_1":"Tom","speaker_2":"Gerard","speaker_3":"Ewa');
    assert.strictEqual(r.salvaged, true);
    assert.deepStrictEqual(r.value, { speaker_1: 'Tom', speaker_2: 'Gerard' });
});

test('parseJsonObject salvages a long mapping truncated near the end', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => `"speaker_${i}":"Person${i}"`).join(',');
    const r = parseJsonObject(`{${pairs},"speaker_20":"Trunc`);
    assert.strictEqual(r.salvaged, true);
    assert.strictEqual(Object.keys(r.value).length, 20);
    assert.strictEqual(r.value.speaker_19, 'Person19');
});

test('parseJsonObject returns null when nothing is usable', () => {
    assert.strictEqual(parseJsonObject('no json here'), null);
    assert.strictEqual(parseJsonObject(''), null);
    assert.strictEqual(parseJsonObject(null), null);
    assert.strictEqual(parseJsonObject('{"speaker_1":"To'), null);
});

test('parseJsonObject unwraps a mapping the model wrongly put in an array', () => {
    // Deliberate leniency: a mapping wrapped in an array is still the mapping.
    // Rejecting it would cost the meeting every speaker name over a bracket.
    const r = parseJsonObject('[{"speaker_1":"Tom"}]');
    assert.deepStrictEqual(r.value, { speaker_1: 'Tom' });
});
