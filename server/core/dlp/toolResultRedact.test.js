// @typecheck strict
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
function ent(/** @type {string} */ text, /** @type {string} */ value, /** @type {string} */ category, label = category) {
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

// ── A JSON tool result keeps its shape ───────────────────────────
//
// A Google Sheets row reaches the guard as compact JSON. Its URL pattern ran
// past the closing quote, the overlap resolver merged that span with the name
// in the next cell, and one `[url_1]` swallowed two values: the model saw four
// values instead of five. The guard returns that ONE merged span today.

const SHEET_ROW = JSON.stringify({ values: [['#00022', 'Acme B.V.', 'Accountants', 'http://example.nl', 'Jan Jansen']], rowCount: 1 });

test('a URL span merged with the next cell leaves a sheet row with five values', () => {
    const merged = ent(SHEET_ROW, 'http://example.nl","Jan Jansen', 'URL', 'URL');
    const r = redactAndTokenizeToolResult(SHEET_ROW, [merged], new Set(), {});

    const row = JSON.parse(r.content).values[0];
    assert.strictEqual(row.length, 5, r.content);
    assert.deepStrictEqual(row.slice(0, 3), ['#00022', 'Acme B.V.', 'Accountants']);
    assert.strictEqual(r.tokenMap[row[3]], 'http://example.nl');
    // The name was inside the merged span: it stays hidden, in its own token.
    assert.ok(!r.content.includes('Jan Jansen'), r.content);
    assert.strictEqual(r.tokenMap[row[4]], 'Jan Jansen');
    assert.strictEqual(JSON.parse(r.content).rowCount, 1);
});

test('with a person span next to the merged URL span the name gets a person token', () => {
    const entities = [
        ent(SHEET_ROW, 'http://example.nl","Jan Jansen', 'URL', 'URL'),
        ent(SHEET_ROW, 'Jan Jansen', 'Person', 'Person Name'),
    ];
    const r = redactAndTokenizeToolResult(SHEET_ROW, entities, new Set(), {});

    const row = JSON.parse(r.content).values[0];
    assert.strictEqual(row.length, 5, r.content);
    assert.strictEqual(r.tokenMap[row[3]], 'http://example.nl');
    assert.match(row[4], /^\[person_\d+\]$/);
    assert.strictEqual(r.tokenMap[row[4]], 'Jan Jansen');
});

test('a URL span on the last value does not take the closing brackets or the next key', () => {
    const text = JSON.stringify({ values: [['Acme B.V.', 'http://example.nl']], rowCount: 1 });
    const r = redactAndTokenizeToolResult(text, [ent(text, 'http://example.nl"]],"rowCount":1', 'URL', 'URL')], new Set(), {});

    const parsed = JSON.parse(r.content);
    assert.deepStrictEqual(Object.keys(parsed), ['values', 'rowCount']);
    assert.strictEqual(parsed.values[0].length, 2);
    assert.strictEqual(r.tokenMap[parsed.values[0][1]], 'http://example.nl');
    assert.deepStrictEqual(Object.values(r.tokenMap), ['http://example.nl']);
});

test('a name with an escaped quote stays one value', () => {
    const text = JSON.stringify({ values: [['#00023', 'http://example.nl', 'Jan "JJ" Jansen', 'Accountants']] });
    const r = redactAndTokenizeToolResult(text, [ent(text, 'http://example.nl","Jan \\"JJ\\" Jansen', 'URL', 'URL')], new Set(), {});

    const row = JSON.parse(r.content).values[0];
    assert.strictEqual(row.length, 4, r.content);
    assert.strictEqual(r.tokenMap[row[1]], 'http://example.nl');
    assert.ok(!r.content.includes('JJ'), r.content);
    assert.deepStrictEqual([row[0], row[3]], ['#00023', 'Accountants']);
});

test('a blocked category is blocked in every piece and the row keeps its shape', () => {
    const merged = ent(SHEET_ROW, 'http://example.nl","Jan Jansen', 'URL', 'URL');
    const r = redactAndTokenizeToolResult(SHEET_ROW, [merged], new Set(['URL']), {});

    const row = JSON.parse(r.content).values[0];
    assert.deepStrictEqual(row, ['#00022', 'Acme B.V.', 'Accountants', '[blocked:url]', '[blocked:url]']);
    assert.deepStrictEqual(r.tokenMap, {});
});

test('text that is no JSON keeps the plain path', () => {
    const text = 'See http://example.nl","Jan for details.';
    const r = redactAndTokenizeToolResult(text, [ent(text, 'http://example.nl","Jan', 'URL', 'URL')], new Set(), {});

    assert.strictEqual(r.content, 'See [url_1] for details.');
    assert.deepStrictEqual(r.tokenMap, { '[url_1]': 'http://example.nl","Jan' });
});
