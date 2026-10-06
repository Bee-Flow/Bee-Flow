import test from 'node:test';
import assert from 'node:assert/strict';

import {
    appendKey, appendMatch, formatKey, formatPath, parsePath, canonicalPath, getPath, getRelativePath,
    parseJsonText, extractJsonText, scanTemplate, replaceTemplate, splitLast, isIdentifierKey,
} from './path.mjs';
import { evaluate } from './engine.mjs';

// Keys real payloads carry (Graph, Gmail, Jira, Shopify, spreadsheets, AI
// answers), biased towards every character the grammar treats specially.
const AWKWARD = [
    'subject', 'content-type', '@odata.context', '@odata.nextLink', 'Story Points', 'first name',
    'prénom', 'naïve', '名前', 'emoji😀', '2024', '0', '007', '-1', '', ' ', 'a.b', 'a]b', 'a[b', 'x[*]',
    'a"b', "a'b", 'a"\'b', 'a\\b', 'a\\', 'a}b', 'a}}b', '{{x}}', 'line\nbreak', 'tab\there', 'true', 'null',
    'false', '$', '_', 'constructor_', 'Δ', 'customfield_10010', 'x-request-id', 'a b.c[d]"e\'f\\g}h',
];

test('every key round-trips: appendKey → parsePath gives the key back', () => {
    for (const k of AWKWARD) {
        const p = appendKey('steps.s1.output', k);
        const t = parsePath(p);
        assert.ok(t, `parsePath(${JSON.stringify(p)})`);
        const last = t[t.length - 1];
        assert.equal(String(last.key), k, `key ${JSON.stringify(k)} via ${p}`);
    }
});

test('every key resolves at run time and in an expression, alone and nested', () => {
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 300; round++) {
        // Build a random nested shape 1..6 levels deep from awkward keys,
        // occasionally through a list.
        const depth = 1 + rand(6);
        const keys = [];
        for (let d = 0; d < depth; d++) keys.push(AWKWARD[rand(AWKWARD.length)]);
        const leaf = { v: round };
        let value = leaf;
        let path = '';
        const segs = [];
        for (let d = depth - 1; d >= 0; d--) {
            const inList = rand(4) === 0;
            value = inList ? { [keys[d]]: [value] } : { [keys[d]]: value };
            segs.unshift({ key: keys[d], inList });
        }
        path = 'steps.s.output';
        for (const s of segs) {
            path = appendKey(path, s.key);
            if (s.inList) path = appendKey(path, 0);
        }
        const root = { steps: { s: { output: value } } };
        assert.deepEqual(getPath(root, path), leaf, `run time: ${path}`);
        assert.deepEqual(evaluate(path, root), leaf, `expression: ${path}`);
        assert.equal(canonicalPath(path), path, `canonical: ${path}`);
    }
});

test('legacy paths keep their meaning (superset of the old REF_RE)', () => {
    const root = {
        steps: { s1: { output: { items: [{ subject: 'a', 'content-type': 'x' }, { subject: 'b' }], 'line-items': [1], "it's": 2 } } },
        trigger: { output: { from: 'me' } },
        loop: { item: { id: 9 } },
    };
    const cases = [
        ['trigger.output.from', 'me'],
        ['steps.s1.output.items[0].subject', 'a'],
        ['steps.s1.output.items[*].subject', ['a', 'b']],
        ['steps.s1.output["line-items"]', [1]],
        ["steps.s1.output['line-items']", [1]],
        ['steps.s1.output["it\'s"]', 2],
        ["steps.s1.output['it\\'s']", 2],
        ['loop.item.id', 9],
        ['steps.s1.output.items[0]["content-type"]', 'x'],
    ];
    for (const [p, want] of cases) assert.deepEqual(getPath(root, p), want, p);
});

test('easier spellings resolve too: digits, hyphens, unicode, negative index', () => {
    const root = { o: { items: [{ s: 'a' }, { s: 'b' }], 'content-type': 'j', prénom: 'Zoë', 'x-id': 3 } };
    assert.equal(getPath(root, 'o.items.0.s'), 'a');
    assert.equal(getPath(root, 'o.items[-1].s'), 'b');
    assert.equal(getPath(root, 'o.content-type'), 'j');
    assert.equal(getPath(root, 'o.prénom'), 'Zoë');
    assert.equal(canonicalPath('o.items.0.s'), 'o.items[0].s');
    assert.equal(canonicalPath('o.content-type'), 'o["content-type"]');
});

test('malformed paths and the prototype chain resolve to undefined', () => {
    const root = { a: { b: 1, list: [1, 2] } };
    for (const p of ['a.', 'a..b', 'a[', 'a[0', 'a["x]', 'a[x]', '.a', '[0]', 'a b', 'a.constructor', 'a.__proto__', 'a.b.toFixed', 'a["constructor"]']) {
        assert.equal(getPath(root, p), undefined, p);
    }
    assert.equal(getPath(root, 'a.list.length'), 2, 'own .length still works');
});

test('[*]: flattens what the rest produced, trailing [*] keeps rows, nulls stay aligned', () => {
    const root = {
        m: [[1, 2], [3, 4]],
        mail: [{ att: [{ id: 'a' }, { id: 'b' }] }, { att: [] }, { att: [{ id: 'c' }] }],
        rows: [{ v: 1 }, { v: null }, {}, { v: 3 }],
    };
    assert.deepEqual(getPath(root, 'm[*]'), [[1, 2], [3, 4]], 'a table keeps its rows');
    assert.deepEqual(getPath(root, 'm[*][0]'), [1, 3], 'first cell of every row');
    assert.deepEqual(getPath(root, 'mail[*].att'), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.deepEqual(getPath(root, 'mail[*].att[*].id'), ['a', 'b', 'c']);
    assert.deepEqual(getPath(root, 'rows[*].v'), [1, null, 3], 'explicit null kept, missing skipped');
    assert.deepEqual(evaluate('rows[*].v', root), [1, null, 3], 'the expression engine agrees');
    assert.deepEqual(evaluate('m[*]', root), [[1, 2], [3, 4]]);
    assert.equal(getPath(root, 'rows[*]').length, 4);
    assert.equal(getPath({ x: { a: 1 } }, 'x[*]'), undefined, '[*] on an object');
});

test('JSON text is read as the value it encodes', () => {
    const body = JSON.stringify({ data: { items: [{ id: 7, tags: ['x'] }], 'next-page': null } });
    const root = {
        http: { body },
        ai: { text: '```json\n{"answer": {"score": 0.9}}\n```' },
        twice: { s: JSON.stringify(JSON.stringify({ deep: true })) },
        plain: { s: 'hello {world}' },
        list: { s: '[{"a":1},{"a":2}]' },
    };
    assert.equal(getPath(root, 'http.body.data.items[0].id'), 7);
    assert.deepEqual(getPath(root, 'http.body.data.items[*].tags'), ['x']);
    assert.equal(getPath(root, 'http.body["data"]["next-page"]'), null);
    assert.equal(getPath(root, 'ai.text.answer.score'), 0.9);
    assert.equal(getPath(root, 'twice.s.deep'), true);
    assert.deepEqual(getPath(root, 'list.s[*].a'), [1, 2]);
    assert.equal(getPath(root, 'list.s[1].a'), 2);
    assert.equal(getPath(root, 'http.body.length'), body.length, '.length of text stays the text length');
    assert.equal(getPath(root, 'plain.s.world'), undefined, 'prose is not JSON');
    assert.equal(getPath(root, 'plain.s[0]'), 'h', 'a character of plain text');
    assert.equal(evaluate('http.body.data.items[0].id', root), 7, 'the expression engine agrees');
});

test('parseJsonText / extractJsonText', () => {
    assert.deepEqual(parseJsonText(' {"a":1} '), { a: 1 });
    assert.equal(parseJsonText('{"a":'), undefined);
    assert.equal(parseJsonText('"just a string"'), undefined);
    assert.equal(parseJsonText('42'), undefined);
    assert.deepEqual(extractJsonText('Sure! Here it is:\n```json\n{"ok": true}\n```\nAnything else?'), { ok: true });
    assert.deepEqual(extractJsonText('The result is {"n": [1, {"m": "}"}]} as requested.'), { n: [1, { m: '}' }] });
    assert.equal(extractJsonText('no json here'), undefined);
});

test('getRelativePath', () => {
    const v = [{ sku: 'a', 'unit price': 1 }, { sku: 'b', 'unit price': 2 }];
    assert.deepEqual(getRelativePath(v, '[*].sku'), ['a', 'b']);
    assert.deepEqual(getRelativePath(v, '$[*]["unit price"]'), [1, 2]);
    assert.equal(getRelativePath({ a: { b: 1 } }, '$.a.b'), 1);
    assert.equal(getRelativePath(v, ''), v);
    assert.equal(getRelativePath(v, null), v);
    assert.equal(getRelativePath('{"a":{"b":5}}', 'a.b'), 5, 'relative to JSON text');
});

test('scanTemplate: quote-aware, compatible with the old {{…}} reading', () => {
    const parts = scanTemplate('Hi {{ a.b }}, {{ x["a}}b"] }} and {{y["c}d"]}}!');
    assert.deepEqual(parts.filter(p => p.type === 'ref').map(p => p.inner), ['a.b', 'x["a}}b"]', 'y["c}d"]']);
    assert.equal(replaceTemplate('{{}} {{ a }} {{ b', (inner) => `<${inner}>`), '{{}} <a> {{ b');
    assert.equal(replaceTemplate("{{ it's }} ok {{ b }}", (inner) => `<${inner}>`), "<it's> ok <b>", 'unterminated quote falls back');
    assert.equal(replaceTemplate('{{ a {{ b }}', (inner) => `<${inner}>`), '{{ a <b>', 'last opener wins');
    assert.equal(replaceTemplate('no placeholders', () => 'X'), 'no placeholders');
});

test('formatKey / splitLast / isIdentifierKey', () => {
    assert.equal(formatKey('abc'), '.abc');
    assert.equal(formatKey(3), '[3]');
    assert.equal(formatKey('3'), '[3]');
    assert.equal(formatKey('true'), '["true"]', 'reserved words are bracketed so expressions read them');
    assert.equal(formatKey('a"b'), '["a\\"b"]');
    assert.equal(isIdentifierKey('null'), false);
    assert.equal(formatPath([{ type: 'prop', key: 'a' }, { type: 'wild' }, { type: 'prop', key: 'b c' }]), 'a[*]["b c"]');
    assert.deepEqual(splitLast('a.b["c d"]'), { parent: 'a.b', last: 'c d', lastToken: { type: 'prop', key: 'c d' } });
});

test('match segments: the element of a name/value list, as a path', () => {
    const root = {
        mail: { payload: { headers: [{ name: 'From', value: 'a@b.c' }, { name: 'Subject', value: 'Invoice 7' }] } },
        tags: [{ Key: 'env', Value: 'prod' }, { Key: 'team', Value: 'ops' }],
        rows: [{ id: 5, v: 'five' }, { id: 6, v: 'six' }],
        text: '[{"k":"a","n":1},{"k":"b","n":2}]',
    };
    assert.equal(getPath(root, 'mail.payload.headers[name="Subject"].value'), 'Invoice 7');
    assert.equal(getPath(root, 'mail.payload.headers[name="subject"].value'), 'Invoice 7', 'text matches ignore case');
    assert.equal(getPath(root, "tags[Key='team'].Value"), 'ops');
    assert.equal(getPath(root, 'rows[id=6].v'), 'six');
    assert.equal(getPath(root, 'rows[id="5"].v'), 'five', 'digits match a number');
    assert.equal(getPath(root, 'text[k="b"].n'), 2, 'inside JSON text');
    assert.equal(getPath(root, 'mail.payload.headers[name="Nope"].value'), undefined);
    assert.equal(getPath(root, 'mail.payload[name="x"]'), undefined, 'not a list');
    assert.equal(parsePath('a[name].b'), null, 'a bare name without = is not a path');
    assert.equal(canonicalPath('a[ name = "x" ].b'), 'a[name="x"].b');
    assert.equal(canonicalPath('a["content-type"="x"]'), 'a["content-type"="x"]');
    assert.deepEqual(splitLast('h[name="Subject"]').last, 'Subject');
    assert.equal(appendMatch('mail.payload.headers', 'name', 'Subject'), 'mail.payload.headers[name="Subject"]');
    assert.equal(appendMatch('x', 'content-type', 5), 'x["content-type"=5]');
    for (const p of ['mail.payload.headers[name="Subject"].value', "tags[Key='team'].Value", 'rows[id=6].v', 'rows[id=-1]', 'rows[x=true]', 'rows[x=null]']) {
        assert.deepEqual(evaluate(p, root), getPath(root, p), `engine agrees on ${p}`);
    }
    assert.throws(() => evaluate('rows = 1', root), /Unexpected character in expression: =/, 'a lone = outside brackets is still an error');
});

test('JSON text nested in JSON text, several levels deep, inside lists', () => {
    // An HTTP body (text) holding a payload (text) holding list items whose
    // meta is text again, down to a fenced AI answer: every level resolves
    // with a plain path, in a ref, an expression and a template alike.
    const lvl3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
    const lvl2 = JSON.stringify({ items: [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: lvl3 }) }, { sku: 'B2', meta: '{"tags":["z"]}' }] });
    const root = { steps: { http: { output: { body: JSON.stringify({ data: { payload: lvl2 } }) } } } };
    const base = 'steps.http.output.body.data.payload';
    const cases = [
        [`${base}.items[0].sku`, 'A1'],
        [`${base}.items[0].meta.tags[1]`, 'y'],
        [`${base}.items[0].meta.ai.verdict.score`, 0.93],
        [`${base}.items[0].meta.ai.verdict["reason code"]`, 'R-7'],
        [`${base}.items[*].meta.tags`, ['x', 'y', 'z']],
        [`${base}.items[sku="B2"].meta.tags[0]`, 'z'],
    ];
    for (const [p, want] of cases) {
        assert.deepEqual(getPath(root, p), want, `run time: ${p}`);
        assert.deepEqual(evaluate(p, root), want, `expression: ${p}`);
    }
});

test('the expression engine reads every spelling a ref binding reads', () => {
    const root = { o: { items: [{ s: 'a' }, { s: 'b' }], flags: { true: 1, null: 2 }, prénom: 'Zoë', 名前: 'x' } };
    for (const p of ['o.items.0.s', 'o.items[1].s', 'o.flags.true', 'o.flags.null', 'o.prénom', 'o.名前', 'o.items[-1].s']) {
        assert.deepEqual(evaluate(p, root), getPath(root, p), p);
    }
    assert.equal(evaluate('o.items.0.s == "a" && 1.5 > .5', root), true, 'numbers still read as numbers');
    assert.equal(evaluate('true && !false', root), true, 'literals still read as literals');
});

test('{{{ x }}} reads as {{ x }}', () => {
    assert.equal(replaceTemplate('a {{{ x }}} b', (inner) => `<${inner}>`), 'a <x> b');
    assert.equal(replaceTemplate('{{{x}}', (inner) => `<${inner}>`), '<{x>', 'unbalanced keeps the old reading');
});

test('a placeholder typed inside a JSON string, with escaped quotes', () => {
    const root = { h: [{ name: 'Subject', value: 'Hi' }] };
    const body = '{"subject": "{{ h[name=\\"Subject\\"].value }}"}';
    assert.equal(replaceTemplate(body, (inner) => String(getPath(root, inner))), '{"subject": "Hi"}');
});

test('parsed JSON text is never shared between two roots', () => {
    const text = JSON.stringify({ a: { list: [1] }, pad: 'x'.repeat(300) });
    const runA = { s: { body: text } };
    const runB = { s: { body: text } };
    const fromA = getPath(runA, 's.body.a');
    fromA.list.push('mutated by run A');
    assert.deepEqual(getPath(runB, 's.body.a'), { list: [1] }, 'run B parses its own copy');
    assert.equal(getPath(runA, 's.body.a'), fromA, 'one root reuses its own parse');
});

test('extractJsonText stays fast on hostile text', () => {
    for (const text of ['{'.repeat(200000), '{a'.repeat(200000), '['.repeat(500000), 'x'.repeat(2_000_000) + '{"a":1}']) {
        const t0 = Date.now();
        extractJsonText(text);
        assert.ok(Date.now() - t0 < 1500, `${text.slice(0, 4)}… x${text.length} took ${Date.now() - t0} ms`);
    }
    assert.deepEqual(extractJsonText('Use {name} placeholders. Here: {"a":1}'), { a: 1 });
    assert.deepEqual(extractJsonText('He said "use { here" and {"a":1}'), { a: 1 });
    const big = 'Answer: ' + JSON.stringify({ rows: Array.from({ length: 20000 }, (_, i) => ({ i })) }) + ' done';
    assert.equal(extractJsonText(big).rows.length, 20000, 'a large prose-wrapped answer still parses');
});

test('one parse per run: item scopes and binding copies share the cache', () => {
    const steps = { http: { output: { body: JSON.stringify({ data: { x: 1 }, pad: 'p'.repeat(400) }) } } };
    const a = getPath({ steps, loop: { item: 1 } }, 'steps.http.output.body.data');
    const b = getPath({ steps, loop: { item: 2 } }, 'steps.http.output.body.data');
    assert.equal(a, b, 'two scopes over the same run reuse one parse');
});

test('saved paths with a backslash in a quoted key keep their old meaning', () => {
    const root = { o: { 'domain\\user': 1, 'C:\\temp': 2, 'x\\': 3, 'a\\b': 4 } };
    assert.equal(getPath(root, 'o["domain\\user"]'), 1, 'old verbatim spelling');
    assert.equal(getPath(root, 'o["C:\\temp"]'), 2);
    assert.equal(getPath(root, 'o["x\\"]'), 3, 'a key ending in a backslash');
    assert.equal(getPath(root, appendKey('o', 'a\\b')), 4, 'the new escaped spelling');
    assert.equal(canonicalPath('o["domain\\user"]'), 'o["domain\\user"]', 're-saved as written');
});

test('match segments ignore case the same way everywhere', () => {
    const root = { h: [{ name: 'SUBJECT', value: 1 }, { name: 'Straße', value: 2 }] };
    assert.equal(getPath(root, 'h[name="subject"].value'), 1);
    assert.equal(getPath(root, 'h[name="STRASSE"].value'), undefined, 'no locale folding: ß is not SS');
    const many = { h: Array.from({ length: 10000 }, (_, i) => ({ name: `k${i}`, value: i })) };
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) getPath(many, 'h[name="K9999"].value');
    assert.ok(Date.now() - t0 < 1500, 'fast on a 10k list');
});

test('extractJsonText finds an answer in prose, not a stray fragment in an error page', () => {
    // What it is for: a fence, the whole text, a lead-in, double encoding.
    assert.deepEqual(extractJsonText('Here is the JSON: {"a": 1, "b": [2]}'), { a: 1, b: [2] });
    assert.deepEqual(extractJsonText('Rows:\n[{"id": 1}, {"id": 2}]\nDone.'), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(extractJsonText('Use {name} placeholders. Here: {"a":1}'), { a: 1 });
    // A tiny or scalar block found in prose is not an answer: an error text
    // or page that happens to hold `[429]`, `{}` or `[1, 2]` stays "not JSON".
    for (const text of [
        'Rate limited [429], retry later',
        'Upstream error {} occurred',
        'Error: invalid input [1, 2] near column 3',
        'Nothing found []',
        '502 Bad Gateway. var cfg = {};',
    ]) assert.equal(extractJsonText(text), undefined, text);
    // Markup is never read as prose with an answer in it.
    assert.equal(extractJsonText('<html><head><script>var cfg = {"env": "prod"};</script></head><body>502 Bad Gateway</body></html>'), undefined);
    // A cut-off answer is not JSON: never a block nested inside it (the
    // customer's id is not the order's id).
    assert.equal(extractJsonText('{"id": 7, "customer": {"id": 99, "email": "c@x.test"}, "lines": [{"id": 1, "sk'), undefined);
    assert.equal(extractJsonText('Sure: {"id":7,"customer":{"id":99}, "lines":[{"id":1'), undefined);
    assert.equal(extractJsonText('[{"id": 1}, {"id": 2'), undefined);
    // Fenced and whole-text JSON stay exactly as lenient as before, also when small.
    assert.deepEqual(extractJsonText('```json\n{}\n```'), {});
    assert.deepEqual(extractJsonText('[429]'), [429]);
});

test('a match segment reads list elements that are JSON text, as [*] and [0] do', () => {
    const root = {
        h: ['{"name":"Subject","value":"Hi"}', '{"name":"From","value":"x"}'],
        mixed: [{ name: 'A', value: 1 }, '{"name":"B","value":2}', 'plain text', '[{"name":"C","value":3}]', ['name', 'C']],
    };
    assert.equal(getPath(root, 'h[name="Subject"].value'), 'Hi');
    assert.equal(getPath(root, 'h[name="from"].value'), 'x', 'text matches ignore case');
    assert.deepEqual(getPath(root, 'h[*].value'), ['Hi', 'x'], 'the column reads the same elements');
    assert.equal(evaluate('h[name="Subject"].value', root), 'Hi', 'the engine agrees');
    assert.equal(getPath(root, 'mixed[name="A"].value'), 1);
    assert.equal(getPath(root, 'mixed[name="B"].value'), 2);
    assert.equal(getPath(root, 'mixed[name="C"].value'), undefined, 'an element that is (or encodes) a list is not a record');
    assert.equal(getPath(root, 'mixed[0="name"]'), undefined, 'a list element never matches an index key');
    assert.equal(getPath(root, 'h[name="Nope"].value'), undefined);
});

test('digit-only keys beyond the safe integer range stay keys (snowflake ids)', () => {
    const big = '1234567890123456789';
    const root = { users: { [big]: { name: 'a' } }, list: ['x', 'y'], small: { 12: 'twelve' } };
    // Written quoted: as an index the digits would be rounded and miss.
    assert.equal(formatKey(big), `["${big}"]`);
    assert.equal(appendKey('users', big), `users["${big}"]`);
    assert.equal(formatKey('12'), '[12]', 'a safe index keeps the short form');
    assert.equal(formatKey(7), '[7]');
    assert.equal(formatKey('012'), '["012"]', 'a leading zero is a key, not an index');
    // Every spelling resolves and canonicalises to the quoted form.
    for (const p of [`users["${big}"].name`, `users[${big}].name`, `users.${big}.name`]) {
        assert.equal(getPath(root, p), 'a', p);
        assert.equal(canonicalPath(p), `users["${big}"].name`, p);
    }
    // The engine reads the canonical (quoted) and dotted spellings the same
    // way. (`[1234567890123456789]` in a formula is a number literal.)
    for (const p of [`users["${big}"].name`, `users.${big}.name`]) assert.equal(evaluate(p, root), 'a', `engine: ${p}`);
    assert.deepEqual(parsePath(`users[${big}]`)[1], { type: 'prop', key: big });
    // Ordinary indexes are unchanged.
    assert.equal(getPath(root, 'list[1]'), 'y');
    assert.equal(getPath(root, 'list[-1]'), 'y');
    assert.equal(getPath(root, 'small[12]'), 'twelve');
    assert.deepEqual(parsePath('list[1]')[1], { type: 'prop', key: 1 });
});

test('a digit key beyond 2^53 is the key it spells, in a path and in a formula', () => {
    const root = { users: { '1234567890123456789': 'snow' } };
    assert.equal(getPath(root, 'users[1234567890123456789]'), 'snow');
    assert.equal(evaluate('users[1234567890123456789]', root), 'snow');
    assert.equal(evaluate('list[1]', { list: [1, 2, 3] }), 2, 'small indexes still read as numbers');
});
