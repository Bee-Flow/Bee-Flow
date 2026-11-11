'use strict';
/**
 * jsonSpans.mts: PII spans in a JSON tool result never cross a string
 * literal's quote, and the redacted result keeps its shape.
 * All data is fictional.
 *
 * Run: cd server && node --test core/dlp/jsonSpans.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonContainer, scanJsonCells, decodeJsonString, splitAtJsonCells, sameShape, redactJson } = require('./jsonSpans.mts');

/** @param {string} text @param {string} value @param {string} category */
function span(text, value, category) {
    const offset = text.indexOf(value);
    assert.ok(offset >= 0, `fixture: "${value}" not in text`);
    return { text: value, category, offset, length: value.length };
}

/**
 * A naive plain-text redaction: each span spliced into `[<category>_<n>]`.
 * @param {string} text @param {Array<{offset:number,length:number,category?:string}>} ents @param {Record<string,string>} map
 */
function splice(text, ents, map) {
    const tokenMap = /** @type {Record<string,string>} */ ({});
    let n = Object.keys(map).length;
    let out = text;
    for (const e of [...ents].sort((a, b) => b.offset - a.offset)) {
        n += 1;
        const token = `[${String(e.category).toLowerCase()}_${n}]`;
        tokenMap[token] = text.slice(e.offset, e.offset + e.length);
        out = out.slice(0, e.offset) + token + out.slice(e.offset + e.length);
    }
    return { content: out, tokenMap, redactedLabels: [], redactedLogLabels: [], blockedCount: 0, tokenizedCount: ents.length };
}

test('parseJsonContainer: objects and arrays only', () => {
    assert.deepEqual(parseJsonContainer('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonContainer(' [1]'), [1]);
    assert.equal(parseJsonContainer('12345678'), undefined);
    assert.equal(parseJsonContainer('"Jan Jansen"'), undefined);
    assert.equal(parseJsonContainer('{"a":'), undefined);
    assert.equal(parseJsonContainer('Jan Jansen'), undefined);
});

test('scanJsonCells: string contents and bare scalars, escapes respected', () => {
    const text = '{"a":["x\\"y",12,true],"b":null}';
    const cells = scanJsonCells(text).map((/** @type {{start:number,end:number,kind:string}} */ c) => [text.slice(c.start, c.end), c.kind]);
    assert.deepEqual(cells, [['a', 'string'], ['x\\"y', 'string'], ['12', 'scalar'], ['true', 'scalar'], ['b', 'string'], ['null', 'scalar']]);
});

test('decodeJsonString: value and a position map that marks the inside of an escape', () => {
    const { value, at } = decodeJsonString('a\\"b\\u00e9');
    assert.equal(value, 'a"bé');
    assert.deepEqual(at, [0, 1, -1, 2, 3, -1, -1, -1, -1, -1, 4]);
});

test('a span over a closing quote is cut into one piece per value', () => {
    const text = '["http://example.nl","Jan Jansen"]';
    const pieces = splitAtJsonCells([span(text, 'http://example.nl","Jan Jansen', 'URL')], text, scanJsonCells(text));
    assert.deepEqual(pieces.map((/** @type {{entity:{text:string}}} */ p) => p.entity.text), ['http://example.nl', 'Jan Jansen']);
});

test('a spilled piece another span already covers is left to that span', () => {
    const text = '["http://example.nl","Jan Jansen"]';
    const ents = [span(text, 'http://example.nl","Jan Jansen', 'URL'), span(text, 'Jan Jansen', 'Person')];
    const pieces = splitAtJsonCells(ents, text, scanJsonCells(text));
    assert.deepEqual(pieces.map((/** @type {{entity:{text:string,category:string}}} */ p) => [p.entity.text, p.entity.category]),
        [['http://example.nl', 'URL'], ['Jan Jansen', 'Person']]);
});

test('structure-only and tiny pieces of a split span are dropped', () => {
    const text = '{"u":"http://example.nl"},{"n":1}';
    const pieces = splitAtJsonCells([span(text, 'http://example.nl"},{"n":1', 'URL')], text, scanJsonCells(text));
    assert.deepEqual(pieces.map((/** @type {{entity:{text:string}}} */ p) => p.entity.text), ['http://example.nl']);
});

test('a cut never lands inside an escape sequence', () => {
    const text = '["Jan \\"JJ\\" Jansen"]';
    const pieces = splitAtJsonCells([span(text, 'Jan \\', 'Person')], text, scanJsonCells(text));
    assert.deepEqual(pieces.map((/** @type {{entity:{text:string}}} */ p) => p.entity.text), ['Jan \\"']);
});

test('sameShape: array lengths and key counts, leaves of any type', () => {
    assert.ok(sameShape({ a: [1, 'x'] }, { a: ['[phone_1]', 'y'] }));
    assert.ok(!sameShape({ a: [1, 'x'] }, { a: ['x'] }));
    assert.ok(!sameShape({ a: 1, b: 2 }, { a: 1 }));
    assert.ok(!sameShape([[1]], [1]));
    assert.ok(!sameShape([1], undefined));
});

test('a bare number that holds PII is quoted so its token stays valid JSON', () => {
    const text = '{"tel":31612345678,"n":2}';
    const r = redactJson(text, JSON.parse(text), [span(text, '31612345678', 'Phone')], splice, {});
    assert.deepEqual(JSON.parse(r.content), { tel: '[phone_1]', n: 2 });
    assert.equal(r.tokenMap['[phone_1]'], '31612345678');
});

test('when the whole-text pass breaks the shape, each value is redacted on its own', () => {
    const text = '{"values":[["http://example.nl","Jan \\"JJ\\" Jansen"]]}';
    const ents = [span(text, 'http://example.nl', 'URL'), span(text, 'Jan \\"JJ\\" Jansen', 'Person')];
    /** @type {typeof splice} */
    const breaking = (t, e, m) => (t === text ? { ...splice(t, e, m), content: t.replace('","', '') } : splice(t, e, m));
    const r = redactJson(text, JSON.parse(text), ents, breaking, {});
    assert.deepEqual(JSON.parse(r.content), { values: [['[url_1]', '[person_2]']] });
    // Per value, the token holds the decoded value.
    assert.deepEqual(r.tokenMap, { '[url_1]': 'http://example.nl', '[person_2]': 'Jan "JJ" Jansen' });
});

test('the per-value fallback is not used when it would show a value the whole pass hid', () => {
    const text = '["Jan Jansen","Jan Jansen"]';
    const ents = [{ text: 'Jan Jansen', category: 'Person', offset: 2, length: 10 }];
    // The whole pass replaces every occurrence (like the name sweep) and breaks the shape.
    /** @type {typeof splice} */
    const sweeping = (t, e, m) => (t === text
        ? { ...splice(t, e, m), content: '["[person_1]",[person_1]"]', tokenMap: { '[person_1]': 'Jan Jansen' } }
        : splice(t, e, m));
    const r = redactJson(text, JSON.parse(text), ents, sweeping, {});
    assert.equal(r.content, '["[person_1]",[person_1]"]');
    assert.ok(!r.content.includes('Jan Jansen'));
});

test('a span without a usable offset still reaches the redaction', () => {
    const text = '["Jan Jansen"]';
    /** @type {Array<{offset:number,length:number,category?:string,text?:string}>} */
    let seen = [];
    /** @type {typeof splice} */
    const spy = (t, e, m) => { seen = e; return splice(t, [], m); };
    redactJson(text, JSON.parse(text), [{ text: 'Jan Jansen', category: 'Person', offset: -1, length: 10 }], spy, {});
    assert.deepEqual(seen.map(e => e.text), ['Jan Jansen']);
});
