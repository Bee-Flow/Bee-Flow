'use strict';

/**
 * `redactAndTokenizeToolResult` next to the tokenizer's name sweep (BFSF-269).
 *
 * A blocked category is replaced by a `[blocked:<category>]` marker AFTER the
 * tokenize pass, by literal match on the detected value. The name sweep inside
 * `tokenizeText` knows the people of the conversation map, so without a guard
 * it could put a person token on part of a blocked name. The literal match
 * then no longer finds the whole value, and the rest of the name reaches the
 * model as plain text, where it used to be blocked.
 *
 * All names and addresses are synthetic.
 *
 * Run: cd server && node --test core/dlp/toolResultRedact.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { redactAndTokenizeToolResult } = require('./toolResultRedact');

/** A detected span for the first occurrence of `value`. */
function ent(text, value, category, label = category) {
    const offset = text.indexOf(value);
    assert.ok(offset >= 0, `fixture: "${value}" not in text`);
    return { text: value, category, label, offset, length: value.length };
}

test('a blocked person that shares a first name with a known person stays blocked whole', () => {
    const text = 'From: Hendrik de Vries <hdv@example.test>';
    const entities = [
        ent(text, 'Hendrik de Vries', 'Person', 'Person Name'),
        ent(text, 'hdv@example.test', 'Email', 'Email Address'),
    ];
    const r = redactAndTokenizeToolResult(text, entities, new Set(['Person']), { '[person_1]': 'Hendrik Vos' });

    assert.strictEqual(r.content, 'From: [blocked:person] <[email_1]>');
    assert.deepStrictEqual(r.tokenMap, { '[email_1]': 'hdv@example.test' });
});

test('a blocked person already in the conversation map gets the marker, not a reversible token', () => {
    const text = 'Contact Hendrik Vos via hv@example.test; Hendrik Vos is away.';
    const entities = [
        ent(text, 'Hendrik Vos', 'Person', 'Person Name'),
        ent(text, 'hv@example.test', 'Email', 'Email Address'),
    ];
    const r = redactAndTokenizeToolResult(text, entities, new Set(['Person']), { '[person_1]': 'Hendrik Vos' });

    assert.strictEqual(r.content, 'Contact [blocked:person] via [email_1]; [blocked:person] is away.');
    assert.ok(!Object.keys(r.tokenMap).some(t => t.startsWith('[person_')), JSON.stringify(r.tokenMap));
});

test('outside a blocked value the sweep still replaces a known person', () => {
    const text = 'Hendrik de Vries wrote to hdv@example.test about Vos.';
    const entities = [
        ent(text, 'Hendrik de Vries', 'Person', 'Person Name'),
        ent(text, 'hdv@example.test', 'Email', 'Email Address'),
    ];
    const r = redactAndTokenizeToolResult(text, entities, new Set(['Person']), { '[person_1]': 'Hendrik Vos' });

    assert.strictEqual(r.content, '[blocked:person] wrote to [email_1] about [person_1].');
});
