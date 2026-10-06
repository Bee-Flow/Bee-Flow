'use strict';

/**
 * rekeyDefinition must rename a step id EVERYWHERE the runner reads one.
 *
 * Import, Blueprint install and upgrade all go through rekeyDefinition. It
 * used to rewrite a hand-kept list of fields per step type, which drifted from
 * what the runner reads: a per-item step (forEach.overRef), a parse/guard
 * source, a list-mode set or switch, switch rules, an ai_step prompt, an HTTP
 * request's url/headers/body, a datatable cursor, approval details and stage
 * conditions all kept the ORIGINAL id. The draft landed with red "refers to
 * non-existent step" errors — or, where nothing validates, rendered blanks.
 *
 * The fixture below uses every surface we know of. The property: after the
 * rekey, no step address names an old id, except in the few places that are
 * deliberately verbatim (a literal, code, model guidance, relative paths, a
 * note), which must come through byte for byte.
 */

const test = require('node:test');
const assert = require('node:assert');
const { rekeyDefinition } = require('./portability');
const { validateDefinition } = require('./validate');
const { readPath } = require('./expr');

const OLD = new Set(['graph', 'shop']);

function fixture() {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        vars: { order: { kind: 'ref', path: 'steps.shop.output.order' } },
        steps: [
            { id: 'graph', type: 'integration_action', tool: 'http_get', inputs: {} },
            { id: 'shop', type: 'integration_action', tool: 'http_get', inputs: {} },
            {
                id: 'ai1', type: 'ai_step', prompt: 'Summarise {{steps.graph.output.body.value}} for {{ steps["shop"].output.order.name }}',
                forEach: { overRef: 'steps.graph.output.body.value', itemVar: 'mail' },
                inputs: { text: { kind: 'ref', path: 'loop.mail.subject' } },
            },
            { id: 'pj', type: 'parse_json', sourceRef: 'steps.graph.output.body', itemsRef: 'steps.graph', fields: [{ name: 'x', path: 'steps.graph.x' }] },
            { id: 'gd', type: 'guard', sourceRef: 'steps.graph.output.body' },
            { id: 'tk', type: 'tokenize', sourceRef: "steps['graph'].output.body" },
            { id: 'ut', type: 'untokenize', sourceRef: 'steps.graph.output.body' },
            {
                id: 'st', type: 'set', arrayRef: 'steps.graph.output.items',
                fields: { total: { kind: 'expr', value: 'item.qty * steps.shop.output.price' } },
            },
            {
                id: 'sw', type: 'switch', arrayRef: 'steps.graph.output.items', expr: 'steps.shop.output.kind',
                cases: [{ name: 'big', expr: 'item.total > steps.shop.output.limit' }],
            },
            { id: 'cond', type: 'condition', expr: 'steps.shop.output.ok && steps.shop.output.note != "steps.shop is fine"' },
            { id: 'kw', type: 'knowledge_write', content: '{{steps.graph.output.text}}', title: 'Order {{steps.shop.output.order.id}}' },
            { id: 'dx', type: 'data_extraction', source: 'steps.graph.output.text', instructions: 'Ignore {{steps.graph.output.footer}}', fields: [] },
            {
                id: 'dt', type: 'datatable', op: 'find_rows', cursor: '{{steps.graph.output.nextCursor}}',
                where: [{ field: 'sku', op: 'eq', value: { kind: 'ref', path: 'steps.shop.output.sku' } }],
            },
            {
                id: 'http', type: 'http_request', method: 'POST',
                url: 'https://erp.example/orders/{{steps.shop.output.order.id}}',
                headers: { 'X-Order': '{{steps.shop.output.order.name}}' },
                // The placeholder is replaced BEFORE the body is sent, so the
                // match value's quotes are plain quotes, not JSON-escaped ones.
                body: '{"subject": "{{steps.graph.output.headers[name="Subject"].value}}"}',
            },
            {
                id: 'ap', type: 'approval', prompt: 'Approve {{steps.shop.output.order.total}}?',
                approval: {
                    details: 'Lines: {{steps.shop.output.order.lines}}',
                    fields: [{ name: 'why', type: 'text', label: 'Why {{steps.shop.output.order.id}}?' }],
                    attachments: [{ binding: '{{steps.graph.output.fileId}}' }],
                    stages: [{ name: 'Finance for {{steps.shop.output.supplier}}', when: 'steps.shop.output.order.total > 5000' }],
                },
            },
            { id: 'dtm', type: 'datetime', op: 'format', format: 'yyyy', input: 'steps.shop.output.date', input2: 'steps.shop.output.date2' },
            { id: 'sl', type: 'slide', title: '{{steps.shop.output.title}}', chart: { data: '{{steps.graph.output.rows}}', labels: '{{steps.graph.output.labels}}' }, stats: ['{{steps.shop.output.total}}'] },
            { id: 'code1', type: 'code', code: 'return { v: "steps.graph.output" };', inputs: { v: { kind: 'ref', path: 'steps.graph.output.v' } } },
            { id: 'lit', type: 'notification', title: 't', body: 'Hi', inputs: { q: { kind: 'literal', value: '{{steps.graph.output.x}}' } } },
            {
                id: 'lp', type: 'loop', overRef: 'steps.graph.output.items', itemVar: 'it',
                body: [{ id: 'inner', type: 'notification', title: '{{steps.shop.output.name}}', body: '{{loop.it.name}}' }],
            },
            // A match segment whose VALUE is an old id is a value, not a step address.
            { id: 'mt', type: 'notification', title: '{{steps.shop.output.headers[name="graph"].value}}', body: '-' },
            { id: 'note1', type: 'note', text: 'steps.graph' },
        ],
        edges: [{ from: 'trg', to: 'graph' }, { from: 'graph', to: 'shop' }],
    };
}

/** Every string leaf with its JSON path. */
function leaves(value, at = '', out = []) {
    if (typeof value === 'string') out.push([at, value]);
    else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${at}[${i}]`, out));
    else if (value && typeof value === 'object') for (const k of Object.keys(value)) leaves(value[k], at ? `${at}.${k}` : k, out);
    return out;
}

/** The old step ids a string still ADDRESSES (dotted or bracketed, inside quotes or not). */
function staleIds(text) {
    const found = [];
    let i = text.indexOf('steps');
    while (i >= 0) {
        const r = readPath(text, i);
        if (r && r.tokens[0].key === 'steps' && r.tokens[1] && r.tokens[1].type === 'prop' && OLD.has(String(r.tokens[1].key))) found.push(r.tokens[1].key);
        i = text.indexOf('steps', i + 5);
    }
    return found;
}

const VERBATIM = new Map([
    // where → why it must not change
    ['steps[3].itemsRef', 'relative to the parsed value'],
    ['steps[3].fields[0].path', 'relative to the parsed value'],
    ['steps[11].instructions', 'model guidance, never interpolated'],
    ['steps[17].code', 'JavaScript, reads its inputs'],
    ['steps[18].inputs.q.value', 'a literal ships verbatim'],
    ['steps[21].text', 'a note is read by nobody'],
]);

// Strings whose old id sits inside a quoted literal of an expression: text,
// not an address. Asserted exactly below instead.
const QUOTED_TEXT = new Set(['steps[9].expr']);

test('no old step id survives a rekey, on any surface the runner reads', () => {
    const src = fixture();
    const { definition, renameMap } = rekeyDefinition(src);
    const stale = leaves(definition)
        .filter(([at, text]) => !VERBATIM.has(at) && !QUOTED_TEXT.has(at) && staleIds(text).length)
        .map(([at, text]) => `${at}: ${text}`);
    assert.deepStrictEqual(stale, [], `old ids left behind:\n${stale.join('\n')}`);

    // The verbatim places really are verbatim.
    const before = new Map(leaves(src));
    for (const [at] of VERBATIM) {
        if (!before.has(at)) continue;
        assert.strictEqual(new Map(leaves(definition)).get(at), before.get(at), `${at} must come through unchanged`);
    }
    // A string literal in an expression is text, not an address.
    const g = renameMap.root.graph;
    const s = renameMap.root.shop;
    const byOld = (id) => definition.steps.find(x => x.id === renameMap.root[id]);
    assert.strictEqual(byOld('cond').expr, `steps.${s}.output.ok && steps.${s}.output.note != "steps.shop is fine"`);
    // Spelling and spacing are the author's: only the id token changed.
    assert.strictEqual(byOld('ai1').prompt, `Summarise {{steps.${g}.output.body.value}} for {{ steps["${s}"].output.order.name }}`);
    assert.strictEqual(byOld('tk').sourceRef, `steps['${g}'].output.body`);
    assert.strictEqual(byOld('http').body, `{"subject": "{{steps.${g}.output.headers[name="Subject"].value}}"}`);
    // A match segment is carried through untouched, value included.
    assert.strictEqual(byOld('mt').title, `{{steps.${s}.output.headers[name="graph"].value}}`);
    assert.strictEqual(byOld('ap').approval.stages[0].when, `steps.${s}.output.order.total > 5000`);
    assert.strictEqual(definition.vars.order.path, `steps.${s}.output.order`);
});

test('the rekeyed draft has no reference the validator cannot place', () => {
    const { definition } = rekeyDefinition(fixture());
    const v = validateDefinition(definition, { stage: 'draft' });
    const refs = [...v.errors, ...v.warnings].filter(f => /^ref\.(unknown_step|prompt_unknown_step)$/.test(f.code));
    assert.deepStrictEqual(refs.map(f => f.message), []);
});

test('a step id that is also a property name of Object is renamed like any other', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'constructor', type: 'integration_action', tool: 'x', inputs: {} },
            { id: 'n', type: 'notification', title: '{{steps.constructor.output.a}}', body: '{{steps.toString.output.b}}' },
        ],
        edges: [{ from: 'trg', to: 'constructor' }, { from: 'constructor', to: 'n' }, { from: 'n', to: 'valueOf' }],
    };
    const { definition, renameMap } = rekeyDefinition(def);
    const fresh = renameMap.root.constructor;
    assert.ok(typeof fresh === 'string' && fresh !== 'constructor', `fresh id: ${fresh}`);
    assert.strictEqual(definition.steps[1].title, `{{steps.${fresh}.output.a}}`);
    // An id nobody has stays as it is — never Object.prototype.toString.
    assert.strictEqual(definition.steps[1].body, '{{steps.toString.output.b}}');
    assert.strictEqual(definition.edges[2].to, 'valueOf');
});

test('a `{{{ steps.x… }}}` placeholder follows the rename, so the copy still validates and renders', () => {
    // The shared template scanner reads `{{{ x }}}` as `{{ x }}`: the runner
    // resolves it and the validator checks it. A copy that kept the old id
    // there rendered a blank and could not be activated (ref.unknown_step).
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'calc', type: 'code', code: 'return { total: 42 };', inputs: {} },
            { id: 'tell', type: 'notification', channel: 'in_app', title: 'Total', body: 'Total: {{{ steps.calc.output.total }}} EUR | {{{steps["calc"].output.total}}}' },
        ],
        edges: [{ from: 'trg', to: 'calc' }, { from: 'calc', to: 'tell' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'the original validates');
    const { definition, renameMap } = rekeyDefinition(def);
    const c = renameMap.root.calc;
    assert.strictEqual(definition.steps[1].body, `Total: {{{ steps.${c}.output.total }}} EUR | {{{steps["${c}"].output.total}}}`);
    const v = validateDefinition(definition);
    assert.deepStrictEqual(v.errors.map(e => `${e.code} ${e.message}`), []);
    assert.strictEqual(v.ok, true);
});

test('a bare path field with a broken tail is renamed in its head, like any other path', () => {
    // The run cannot read `…Story Points` either way, but after an import,
    // install or upgrade it must not ALSO name a step that no longer exists:
    // that is a second, blocking error (ref.unknown_step), and the fix the
    // validator offers for the tail would carry the old id along.
    const tails = {
        overRef: 'steps.src.output.Story Points',
        arrayRef: 'steps.src.output.items[0',
        input: 'steps.src.output.',
        input2: 'steps["src"].output.due date',
    };
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'src', type: 'integration_action', tool: 'http_get', inputs: {} },
            { id: 'lp', type: 'loop', overRef: tails.overRef, itemVar: 'it', body: [] },
            { id: 'fl', type: 'filter', arrayRef: tails.arrayRef, expr: 'item.ok' },
            { id: 'dtm', type: 'datetime', op: 'diff', input: tails.input, input2: tails.input2 },
            // Prose that merely starts with a step address stays the author's.
            { id: 'say', type: 'notification', title: 'steps.src failed', body: 'steps.src.output.total\nis the number to watch' },
        ],
        edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'lp' }, { from: 'lp', to: 'fl' }, { from: 'fl', to: 'dtm' }, { from: 'dtm', to: 'say' }],
    };
    const { definition, renameMap } = rekeyDefinition(def);
    const n = renameMap.root.src;
    const byOld = (id) => definition.steps.find(x => x.id === renameMap.root[id]);
    assert.strictEqual(byOld('lp').overRef, `steps.${n}.output.Story Points`);
    assert.strictEqual(byOld('fl').arrayRef, `steps.${n}.output.items[0`);
    assert.strictEqual(byOld('dtm').input, `steps.${n}.output.`);
    assert.strictEqual(byOld('dtm').input2, `steps["${n}"].output.due date`);
    assert.strictEqual(byOld('say').title, 'steps.src failed');
    assert.strictEqual(byOld('say').body, 'steps.src.output.total\nis the number to watch');

    const v = validateDefinition(definition, { stage: 'draft' });
    const unknown = [...v.errors, ...v.warnings].filter(f => f.code === 'ref.unknown_step');
    assert.deepStrictEqual(unknown.map(f => f.message), []);
});
