/**
 * Document templates — the filler and the placeholder reader.
 *
 * The cases worth pinning are the ones whose failure is a WRONG DOCUMENT
 * rather than an error: a nested block paired with the wrong closing tag, a
 * value that prints as [object Object], an ampersand that eats the rest of a
 * line, a missing value that prints its own braces onto paper.
 *
 * Run: node --test --test-force-exit core/documents/documentTemplate.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    fillDocumentBody, listPlaceholders, isTemplate, parseTemplate, MAX_LIST_ITEMS, MAX_BLOCK_DEPTH,
} = require('./documentTemplate');

test('a value is filled in and HTML-escaped', () => {
    const out = fillDocumentBody('<p>{{customer.name}}</p>', { customer: { name: 'Jansen & Zn <b>' } });
    assert.strictEqual(out.bodyHtml, '<p>Jansen &amp; Zn &lt;b&gt;</p>');
    assert.deepStrictEqual(out.missing, []);
});

test('a missing value is blank AND reported — braces never reach the paper', () => {
    const out = fillDocumentBody('<p>Beste {{customer.name}},</p>', {});
    assert.strictEqual(out.bodyHtml, '<p>Beste ,</p>');
    assert.deepStrictEqual(out.missing, ['customer.name']);
});

test('an object bound where a scalar was meant prints nothing and is reported', () => {
    // `{{customer}}` where `{{customer.name}}` was meant: "[object Object]"
    // on an invoice is the failure this prevents.
    const out = fillDocumentBody('<p>{{customer}}</p>', { customer: { name: 'X' } });
    assert.strictEqual(out.bodyHtml, '<p></p>');
    assert.deepStrictEqual(out.missing, ['customer']);
});

test('null and false are bound values, not missing ones', () => {
    const out = fillDocumentBody('<p>{{a}}{{b}}</p>', { a: null, b: false });
    assert.strictEqual(out.bodyHtml, '<p></p>');
    assert.deepStrictEqual(out.missing, []);
});

test('numbers and zero print', () => {
    const out = fillDocumentBody('<p>{{n}}|{{z}}</p>', { n: 42.5, z: 0 });
    assert.strictEqual(out.bodyHtml, '<p>42.5|0</p>');
});

test('#each repeats its block, with the item as the innermost scope', () => {
    const out = fillDocumentBody(
        '<table>{{#each lines}}<tr><td>{{description}}</td><td>{{amount}}</td></tr>{{/each}}</table>',
        { lines: [{ description: 'Werk', amount: '100,00' }, { description: 'Reis', amount: '25,00' }] },
    );
    assert.strictEqual(
        out.bodyHtml,
        '<table><tr><td>Werk</td><td>100,00</td></tr><tr><td>Reis</td><td>25,00</td></tr></table>',
    );
});

test('a block falls through to the document values for fields the item lacks', () => {
    const out = fillDocumentBody(
        '{{#each lines}}<p>{{description}} — {{currency}}</p>{{/each}}',
        { currency: 'EUR', lines: [{ description: 'Werk' }] },
    );
    assert.strictEqual(out.bodyHtml, '<p>Werk — EUR</p>');
});

test('{{this}} prints a list of plain strings', () => {
    const out = fillDocumentBody('<ul>{{#each tags}}<li>{{this}}</li>{{/each}}</ul>', { tags: ['a', 'b'] });
    assert.strictEqual(out.bodyHtml, '<ul><li>a</li><li>b</li></ul>');
});

test('nested blocks pair by depth — the outer #each does not close on the inner {{/each}}', () => {
    // The whole reason this module parses instead of regex-replacing: a
    // non-greedy regex renders "[(1)" and drops the rest, silently.
    const out = fillDocumentBody(
        '{{#each projects}}[{{name}}{{#each lines}}({{v}}){{/each}}]{{/each}}',
        { projects: [{ name: 'P1', lines: [{ v: 1 }, { v: 2 }] }, { name: 'P2', lines: [{ v: 3 }] }] },
    );
    assert.strictEqual(out.bodyHtml, '[P1(1)(2)][P2(3)]');
});

test('a list block whose list is absent renders nothing and is reported', () => {
    const out = fillDocumentBody('<table>{{#each lines}}<tr></tr>{{/each}}</table>', {});
    assert.strictEqual(out.bodyHtml, '<table></table>');
    assert.deepStrictEqual(out.missing, ['lines']);
});

test('a list bound to something that is not a list is reported separately', () => {
    const out = fillDocumentBody('{{#each lines}}x{{/each}}', { lines: 'nope' });
    assert.strictEqual(out.bodyHtml, '');
    assert.deepStrictEqual(out.notLists, ['lines']);
    assert.deepStrictEqual(out.missing, []);
});

test('a long list is truncated and says so', () => {
    const items = Array.from({ length: MAX_LIST_ITEMS + 10 }, (_, i) => ({ v: i }));
    const out = fillDocumentBody('{{#each rows}}<i>{{v}}</i>{{/each}}', { rows: items });
    assert.strictEqual((out.bodyHtml.match(/<i>/g) || []).length, MAX_LIST_ITEMS);
    assert.deepStrictEqual(out.truncated, ['rows']);
});

test('#if picks a branch; an empty list and a blank string are both "no"', () => {
    const tpl = '{{#if note}}<p>{{note}}</p>{{else}}<p>none</p>{{/if}}';
    assert.strictEqual(fillDocumentBody(tpl, { note: 'Hi' }).bodyHtml, '<p>Hi</p>');
    assert.strictEqual(fillDocumentBody(tpl, { note: '   ' }).bodyHtml, '<p>none</p>');
    assert.strictEqual(fillDocumentBody(tpl, { note: [] }).bodyHtml, '<p>none</p>');
    assert.strictEqual(fillDocumentBody(tpl, { note: 0 }).bodyHtml, '<p>none</p>');
});

test('#if without an {{else}} simply renders nothing when false', () => {
    assert.strictEqual(fillDocumentBody('{{#if d}}<p>x</p>{{/if}}', { d: false }).bodyHtml, '');
});

test('nesting deeper than the cap is reported, not rendered', () => {
    const tpl = '{{#each a}}{{#each b}}{{#each c}}{{#each d}}{{v}}{{/each}}{{/each}}{{/each}}{{/each}}';
    const data = { a: [{ b: [{ c: [{ d: [{ v: 'deep' }] }] }] }] };
    const out = fillDocumentBody(tpl, data);
    assert.ok(!out.bodyHtml.includes('deep'), 'the over-deep block must not render');
    assert.deepStrictEqual(out.tooDeep, ['d']);
    assert.strictEqual(MAX_BLOCK_DEPTH, 3);
});

test('an unclosed block keeps its text and says what happened', () => {
    const out = fillDocumentBody('<p>before</p>{{#each lines}}<p>{{x}}</p>', { lines: [] });
    assert.ok(out.bodyHtml.includes('<p>before</p>'), 'the rest of the document survives');
    assert.strictEqual(out.errors.length, 1);
    assert.match(out.errors[0], /never closed/);
});

test('a stray closing tag is left as text and reported', () => {
    const out = fillDocumentBody('<p>a</p>{{/each}}', {});
    assert.ok(out.bodyHtml.includes('{{/each}}'));
    assert.match(out.errors[0], /no open/);
});

test('a tag that is not ours is left completely alone', () => {
    // CSS-ish braces and unknown helpers must survive: the body is markup a
    // person hand-edits, not a template language they opted into everywhere.
    const src = '<p>{{ not a path }}</p><p>{{#unless x}}y{{/unless}}</p>';
    assert.strictEqual(fillDocumentBody(src, {}).bodyHtml, src);
});

test('listPlaceholders names the holes, their kind, and a list\'s per-item fields', () => {
    const found = listPlaceholders(
        '<p>{{customer.name}}</p>{{#each lines}}<td>{{description}}</td><td>{{amount}}</td>{{/each}}{{#if paid}}x{{/if}}',
    );
    assert.deepStrictEqual(found, [
        { key: 'customer.name', kind: 'value' },
        { key: 'lines', kind: 'list', fields: ['description', 'amount'] },
        { key: 'paid', kind: 'condition' },
    ]);
});

test('a list\'s inner fields are NOT also reported as document-level values', () => {
    // Otherwise the editor would ask the author to bind `description` as well
    // as `lines`, which is not a thing that exists.
    const keys = listPlaceholders('{{#each lines}}{{description}}{{/each}}').map(p => p.key);
    assert.deepStrictEqual(keys, ['lines']);
});

test('isTemplate distinguishes a template from a one-off document', () => {
    assert.strictEqual(isTemplate('<p>Fixed text</p>'), false);
    assert.strictEqual(isTemplate('<p>{{a}}</p>'), true);
});

test('parseTemplate keeps the text around the tags verbatim', () => {
    const { nodes } = parseTemplate('a{{x}}b');
    assert.deepStrictEqual(nodes.map(n => n.kind), ['text', 'value', 'text']);
    assert.strictEqual(nodes[0].text, 'a');
    assert.strictEqual(nodes[2].text, 'b');
});

test('values are escaped inside a repeated block too', () => {
    const out = fillDocumentBody('{{#each l}}<td>{{v}}</td>{{/each}}', { l: [{ v: '<script>x</script>' }] });
    assert.strictEqual(out.bodyHtml, '<td>&lt;script&gt;x&lt;/script&gt;</td>');
});

test('escape:false fills as plain text — for a presentation outline the deck renderer escapes when it paints', () => {
    const out = fillDocumentBody('# {{title}}\n{{#each l}}- {{v}}\n{{/each}}', { title: 'Bee & Co <3', l: [{ v: 'a & b' }] }, { escape: false });
    assert.strictEqual(out.bodyHtml, '# Bee & Co <3\n- a & b\n');
    const esc = fillDocumentBody('{{title}}', { title: 'Bee & Co' });
    assert.strictEqual(esc.bodyHtml, 'Bee &amp; Co', 'the default is unchanged');
});
