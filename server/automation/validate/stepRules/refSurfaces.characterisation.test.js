'use strict';
/**
 * Every reference surface collectStepRefs reads, pinned per step type: one
 * step with every surface filled (each value names its own field, so the
 * golden reads as a map of where references are found) and one with the same
 * fields in shapes the collector must skip or read differently.
 *
 * Refresh (only for a deliberate change of a surface):
 *   cd server && UPDATE_GOLDEN=1 node --test automation/validate/stepRules/refSurfaces.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { collectStepRefs } = require('./refSurfaces');

const GOLDEN_PATH = path.join(__dirname, 'refSurfaces.characterisation.golden.json');
const T = (name) => `{{steps.s.output.${name}}}`;
const P = (name) => `steps.s.output.${name}`;
const R = (name) => ({ kind: 'ref', path: P(name) });
const TB = (name) => ({ kind: 'template', value: T(name) });
const X = (name) => ({ kind: 'expr', value: `${P(name)} > 1` });
const E = (name) => `${P(name)} == 1`;

const fields = (where) => [{ label: T(`${where}.label`), placeholder: T(`${where}.ph`), help: T(`${where}.help`), options: [{ label: T(`${where}.opt`), hint: T(`${where}.hint`) }, 'x'], content: T(`${where}.content`), optionsFrom: { ref: P(`${where}.of`) }, fieldsFrom: { ref: P(`${where}.ff`) } }, null, 'x'];

const FULL = {
    notification: { title: T('title'), body: T('body') },
    condition: { expr: E('expr') },
    guard: { sourceRef: P('sourceRef') }, tokenize: { sourceRef: P('sourceRef') }, untokenize: { sourceRef: P('sourceRef') }, parse_json: { sourceRef: P('sourceRef') },
    loop: { overRef: P('overRef') },
    set: { fields: { a: R('fields.a'), b: X('fields.b'), c: TB('fields.c') }, arrayRef: P('arrayRef') },
    layer_output: { fields: { a: R('fields.a'), b: X('fields.b') } },
    datetime: { input: P('input'), input2: '2026-01-02', arrayRef: P('arrayRef') },
    stop_error: { message: T('message') },
    return_to_app: { toast: { message: T('toast') }, navigateTo: { recordRef: T('record') } },
    ai_step: { enumFrom: [{ ref: P('enum0') }, null], checks: [{ ref: P('check0'), sameCountAs: P('same0') }, 'x'], fallback: { fields: { a: R('fallback.a') } } },
    data_extraction: { source: T('source') },
    generate_document: { content: T('content'), title: T('title'), fileName: T('fileName') },
    slide: { title: T('title'), content: T('content'), notes: T('notes'), image: T('image'), chart: { data: R('chart.data'), labels: T('labels'), values: T('values'), unit: T('unit') }, stats: [T('stat0'), R('stat1'), 5] },
    presentation: { title: T('title'), subtitle: T('subtitle'), fileName: T('fileName'), accent: T('accent'), background: T('background'), logo: T('logo'), footerText: T('footer'), copyName: T('copyName'), slides: [T('slide0'), { kind: 'ref', path: P('slide1') }, { a: T('slide2.a'), b: [T('slide2.b0')] }, [[[[T('deep')]]]], null] },
    fill_document: { fileName: T('fileName'), copyName: T('copyName'), values: { a: T('values.a'), b: R('values.b'), c: 5 } },
    switch: { expr: E('expr'), arrayRef: P('arrayRef'), cases: [{ expr: E('case0') }, null, { name: 'x' }] },
    filter: { expr: E('expr'), arrayRef: P('arrayRef') },
    limit: { arrayRef: P('arrayRef') }, dedupe: { arrayRef: P('arrayRef') }, aggregate: { arrayRef: P('arrayRef') }, summarize: { arrayRef: P('arrayRef') },
    flatten: { arrayRef: P('arrayRef'), parents: [{ overRef: P('parent0') }, null] },
    read_table: { source: R('source') },
    table: { source: R('source'), ops: [{ op: 'join', with: R('join') }, { op: 'filter', rules: [{ value: R('rule0') }], rulesFrom: R('rulesFrom'), expr: E('filterExpr') }, { op: 'derive', columns: [{ value: { kind: 'ref', path: 'row.A' } }, { value: R('derive1') }] }, null] },
    knowledge_write: { content: T('content'), title: R('title'), sourceUri: T('uri') },
    kb_query_log: { knowledgeBaseId: T('kb'), entryId: R('entry'), status: T('status'), note: T('note'), filters: { a: T('filters.a'), b: R('filters.b') } },
    datatable: { values: { a: R('values.a') }, cursor: T('cursor'), where: [{ value: R('where0') }, null] },
    http_request: { url: T('url'), headers: { A: T('headers.A'), B: 5 }, body: T('body'), query: { json: T('query.json'), items: [{ key: T('qk'), value: T('qv') }, null] } },
    approval: { prompt: T('prompt'), approval: { details: T('details'), fields: fields('approval.fields'), attachments: [{ binding: T('att0') }, null], stages: [{ name: T('stage.name'), description: T('stage.desc'), when: E('stage.when') }, 'x'] } },
    form_page: { form: { title: T('form.title'), description: T('form.desc'), submitLabel: T('form.submit'), successMessage: T('form.success'), fields: fields('form.fields') }, when: E('when') },
    unknown_type: { title: T('title') },
};

// The same fields in other shapes: wrong types, empty strings, bare strings.
const ODD = {
    notification: { title: '', body: 5 },
    condition: { expr: '' },
    loop: { overRef: '' },
    set: { fields: [R('fields0')], arrayRef: 7 },
    datetime: { input: 'today', input2: 'Jan 2, 2026', arrayRef: '' },
    datetime2: { type: 'datetime', input: '2026-01-02T10:00', input2: 'steps.s.output.when' },
    return_to_app: { toast: 'x', navigateTo: null },
    ai_step: { enumFrom: 'x', checks: null, fallback: 'x' },
    data_extraction: { source: '  steps.s.output.bare  ' },
    data_extraction2: { type: 'data_extraction', source: 'plain text' },
    data_extraction3: { type: 'data_extraction', source: R('source') },
    data_extraction4: { type: 'data_extraction', source: '   ' },
    slide: { chart: 'x', stats: R('stats') },
    slide2: { type: 'slide', stats: T('stats') },
    presentation: { slides: T('slides') },
    presentation2: { type: 'presentation', slides: { kind: 'template', value: T('slides') } },
    fill_document: { values: [T('v0')] },
    switch: { cases: 'x' },
    flatten: { parents: 'x' },
    table: { ops: 'x' },
    kb_query_log: { filters: [T('f0')] },
    datatable: { values: [R('v0')], cursor: R('cursor'), where: 'x' },
    http_request: { headers: [T('h0')], query: { items: 'x' } },
    http_request2: { type: 'http_request', query: 'x' },
    approval: { approval: 'x' },
    approval2: { type: 'approval', approval: { fields: 'x', attachments: 'x', stages: 'x' } },
    form_page: { form: null, when: '' },
    form_page2: { type: 'form_page', form: { fields: [{ optionsFrom: 'x', fieldsFrom: null, options: 'x' }] } },
};

const COMMON = { inputs: { a: R('inputs.a'), b: TB('inputs.b'), c: X('inputs.c') }, forEach: { overRef: P('forEach') } };

function cases() {
    const out = {};
    for (const [type, extra] of Object.entries(FULL)) out[`full ${type}`] = { id: 's1', type, ...COMMON, ...extra };
    for (const [name, extra] of Object.entries(ODD)) out[`odd ${name}`] = { id: 's1', type: name, forEach: 'x', ...extra };
    out['no type'] = { id: 's1', inputs: [R('in0')] };
    out['type that is an array'] = { id: 's1', type: ['notification'], title: T('title') };
    out['type named like a prototype member'] = { id: 's1', type: 'constructor', title: T('title') };
    return out;
}

const actual = Object.fromEntries(Object.entries(cases()).map(([name, step]) => [name, collectStepRefs(step)]));
// One line per reference, so a changed surface shows as a one-line diff.
const format = (all) => `{\n${Object.entries(all).map(([k, refs]) => `${JSON.stringify(k)}: [${refs.map((r) => `\n  ${JSON.stringify(r)}`).join(',')}${refs.length ? '\n' : ''}]`).join(',\n')}\n}\n`;
if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN_PATH, format(actual));
const GOLDEN = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

test('every case is in the golden file', () => {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(GOLDEN).sort());
});
for (const name of Object.keys(actual)) {
    test(`golden: ${name}`, () => assert.deepEqual(actual[name], GOLDEN[name]));
}
