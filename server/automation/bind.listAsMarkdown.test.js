/**
 * A form page's text is the one interpolation output a PERSON reads.
 *
 * It is rendered as markdown, so a step that produced a list of findings used
 * to put `["Productaanbod van RVS platen…","Algemene bedrijfspresentatie…"]`
 * — brackets, quotes, commas — in the middle of a sentence a customer was
 * asked to act on. `listAsMarkdown` renders that as bullets instead.
 *
 * It is OPT-IN: every other text slot reads a list on one line ("a, b"), and a
 * slot that carries data (a prompt, a URL, an HTTP header or body) asks for
 * JSON with `listAs: 'json'`; all of them go through the same function.
 */

const test = require('node:test');
const assert = require('node:assert');
const { interpolateTemplate } = require('./bind');

const state = {
    steps: {
        s1: {
            output: {
                findings: ['Productaanbod van RVS platen', 'Algemene bedrijfspresentatie'],
                empty: [],
                rows: [{ a: 1 }, { a: 2 }],
                numbers: [1, 2, 3],
                text: 'plain',
            },
        },
    },
};
const md = (tpl) => interpolateTemplate(tpl, state, { listAsMarkdown: true });

test('a list of plain values becomes a markdown bullet list', () => {
    const out = md('**Wat de concurrentie doet:** {{steps.s1.output.findings}}');
    assert.match(out, /^\*\*Wat de concurrentie doet:\*\* \n\n- Productaanbod van RVS platen\n- Algemene bedrijfspresentatie\n$/);
    assert.ok(!out.includes('["'), 'no JSON brackets survive');
});

test('the list starts its own block, so it never glues onto its label', () => {
    // A bullet run on the same line as the label renders as literal "- text".
    const out = md('Label: {{steps.s1.output.numbers}}');
    assert.match(out, /Label: \n\n- 1\n- 2\n- 3\n/);
});

test('an empty list renders as nothing, not as []', () => {
    assert.strictEqual(md('Gevonden: {{steps.s1.output.empty}}'), 'Gevonden: ');
});

test('a list of RECORDS becomes one bullet per row, never JSON on a page a customer reads', () => {
    assert.strictEqual(md('{{steps.s1.output.rows}}'), '\n\n- a: 1\n- a: 2\n');
});

test('scalars are untouched', () => {
    assert.strictEqual(md('x {{steps.s1.output.text}} y'), 'x plain y');
});

test('WITHOUT the flag a list of plain values is one comma separated line, and listAs json keeps JSON', () => {
    assert.strictEqual(
        interpolateTemplate('{{steps.s1.output.findings}}', state),
        'Productaanbod van RVS platen, Algemene bedrijfspresentatie',
    );
    // A slot that carries data (an http body, a prompt) opts into JSON.
    assert.strictEqual(
        interpolateTemplate('{{steps.s1.output.findings}}', state, { listAs: 'json' }),
        '["Productaanbod van RVS platen","Algemene bedrijfspresentatie"]',
    );
    // A list of records reads one row per line in prose, JSON in a data slot.
    assert.strictEqual(interpolateTemplate('{{steps.s1.output.rows}}', state), 'a: 1\na: 2');
    assert.strictEqual(interpolateTemplate('{{steps.s1.output.rows}}', state, { listAs: 'json' }), '[{"a":1},{"a":2}]');
});

test('a missing path still blanks, and still warns', () => {
    const s = { ...state, _templateWarnings: [] };
    assert.strictEqual(interpolateTemplate('a{{steps.s1.output.nope}}b', s, { listAsMarkdown: true }), 'ab');
    assert.deepStrictEqual(s._templateWarnings, ['steps.s1.output.nope']);
});
