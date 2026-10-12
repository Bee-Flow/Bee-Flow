/**
 * builder_request_dry_run's `_hint`, and what the builder learns from it.
 *
 * REGRESSION (audit:server-static-paths, 2026-10): the hint was two levels
 * deep (`messages: array of { id, payload }`) and built from the PERSISTED
 * row — for an output over 256 KB that is the truncation sentinel, so the
 * model was told the step outputs `__truncated__, originalBytes, headSample`
 * and bound `steps.x.output.headSample`. A datatable `cursor` written as
 * "{{steps.<id>.output.nextCursor}}" was stored as literal text, so every
 * page of a paging loop read page 1 again.
 *
 * Run: cd server && node --test automation/builderTools.dryRunHint.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyToolCall, emptyDefinition, _test_dryRunHint: dryRunHint, _test_validateAndFixBindings: validateAndFixBindings } = require('./builderTools');
const { resolveValue } = require('./bind');

const GRAPH_PAGE = {
    value: [
        { id: '1', subject: 'Invoice', from: { emailAddress: { name: 'A', address: 'a@x.nl' } }, internetMessageHeaders: [{ name: 'Subject', value: 'Invoice' }] },
        { id: '2', subject: 'Quote', hasAttachments: true, categories: ['Red'] },
    ],
    '@odata.nextLink': 'https://graph/next',
};

function wrapWithCode() {
    const dw = { userId: 'u_test', def: emptyDefinition() };
    dw.def.steps.push({ id: 'g', type: 'code' });
    return dw;
}

test('the hint is deep, in path grammar, the union of every entry', async () => {
    const dw = wrapWithCode();
    const h = await dryRunHint({ stepId: 'g', output: GRAPH_PAGE }, dw);
    assert.equal(h.outputType, 'object');
    assert.deepEqual(h.topKeys, ['value', '@odata.nextLink']);
    assert.match(h.shape, /value\[\*\]: \{ id, subject, from: \{ emailAddress: \{ name, address \} \}/);
    assert.match(h.shape, /hasAttachments, categories\[\*\]: string/, 'keys only entry 2 has');
    assert.match(h.shape, /\["@odata\.nextLink"\]: string/);
});

test('what the dry run returned is what the next binding is checked against', async () => {
    const dw = wrapWithCode();
    await dryRunHint({ stepId: 'g', output: GRAPH_PAGE }, dw);
    // One run: a key it lacked may be optional, so a miss is named, not refused.
    const bad = validateAndFixBindings({ to: { kind: 'ref', path: 'steps.g.output.value[0].from.emailAdress.address' } }, dw.def, { draftWrap: dw });
    assert.equal(bad.error, null);
    assert.match(bad.notes.join('\n'), /Did you mean steps\.g\.output\.value\[0\]\.from\.emailAddress/);
    const ok = validateAndFixBindings({ to: { kind: 'ref', path: 'steps.g.output.value.from.emailAddress.address' } }, dw.def, { draftWrap: dw });
    assert.equal(ok.error, null);
    assert.equal(ok.inputs.to.path, 'steps.g.output.value[0].from.emailAddress.address');
    assert.equal(resolveValue(ok.inputs.to, { steps: { g: { output: GRAPH_PAGE } } }), 'a@x.nl');
});

test('a truncated output is hinted from its full copy, never from the sentinel keys', async () => {
    const dw = wrapWithCode();
    const sentinel = { __truncated__: true, originalBytes: 334587, headSample: '{"value":[{"id"', fullOutputRef: { runId: 'r1', stepId: 'g', attempts: 1 } };
    const reads = [];
    const h = await dryRunHint({ stepId: 'g', output: sentinel }, dw, { readFullOutput: async (...a) => { reads.push(a); return GRAPH_PAGE; } });
    assert.deepEqual(reads, [['r1', 'g', 1]]);
    assert.deepEqual(h.topKeys, ['value', '@odata.nextLink']);
    assert.ok(!/headSample|__truncated__/.test(h.shape));
    assert.match(h.note, /full copy/);
});

test('without a full copy the shape-preserving preview is used; without either the shape is unknown', async () => {
    const dw = wrapWithCode();
    const withPreview = await dryRunHint({ stepId: 'g', output: { __truncated__: true, originalBytes: 9e5, headSample: 'x', preview: { value: [{ id: '1', subject: 'Invo…' }] } } }, dw);
    assert.match(withPreview.shape, /value\[\*\]: \{ id, subject \}/);
    assert.match(withPreview.note, /preview/);
    const bare = await dryRunHint({ stepId: 'g', output: { __truncated__: true, originalBytes: 9e5, headSample: 'x' } }, dw, { readFullOutput: async () => null });
    assert.equal(bare.shape, null);
    assert.equal(bare.topKeys, null);
    assert.match(bare.note, /unknown/);
});

test('a find_rows cursor written as {{…}} is stored as a binding the run resolves', async () => {
    const dw = { userId: 'u_test', def: emptyDefinition() };
    const first = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c' }, dw);
    assert.ok(!first.error, first.error);
    const id = first.added.id;
    const next = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c', cursor: `{{steps.${id}.output.nextCursor}}` }, dw);
    assert.ok(!next.error, next.error);
    assert.deepEqual(next.added.cursor, { kind: 'ref', path: `steps.${id}.output.nextCursor` });
    assert.equal(resolveValue(next.added.cursor, { steps: { [id]: { output: { nextCursor: 'eyJpZCI6NTB9' } } } }), 'eyJpZCI6NTB9');
    assert.match((next._warnings || []).join('\n'), /stored as a ref binding/);
    // An opaque token stays the literal it is; a misspelled field is refused.
    const lit = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c', cursor: 'eyJpZCI6NTB9' }, dw);
    assert.equal(lit.added.cursor, 'eyJpZCI6NTB9');
    const bad = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c', cursor: `{{steps.${id}.output.nextCurser}}` }, dw);
    assert.match(bad.error, /Did you mean steps\..*\.output\.nextCursor/);
});

// REGRESSION (code review 2026-10): the preview of an output over 256 KB
// keeps a few list entries and cuts wide records, yet its keys refused a
// binding (`messages[*].cc`, only entry 8 of 40 had it) and the one
// did-you-mean (`id`) became a patch the identical resend applied.
test('a shape read from the shortened preview never refuses a binding', async () => {
    const dw = wrapWithCode();
    const preview = { messages: [{ id: 'm0', subject: 's' }, { id: 'm1', subject: 's' }] };
    await dryRunHint({ stepId: 'g', output: { __truncated__: true, originalBytes: 9e5, headSample: 'x', preview } }, dw, { readFullOutput: async () => null });
    const r = validateAndFixBindings({ to: { kind: 'ref', path: 'steps.g.output.messages[*].cc' } }, dw.def, { draftWrap: dw });
    assert.equal(r.error, null);
    assert.equal(r._suggestedPatch, undefined);
    assert.equal(r.inputs.to.path, 'steps.g.output.messages[*].cc');
    assert.ok(!(r.notes || []).some(n => /has no "cc"/.test(n)), 'a preview cut what it lacks: not even a did-you-mean');
});

// REGRESSION (code review 2026-10, privacy): the hint is shapes, never
// payloads, yet it printed the entry names of any name/value list — people,
// addresses, sample prose — and an index into such a list was SAVED as
// `[name="Renewal - Jan Jansen …"]`, reading nothing on the next run.
test('the hint never carries entry values, and an index into the list stays an index', async () => {
    const dw = wrapWithCode();
    const out = { deals: [{ name: 'Renewal - Jan Jansen (BSN 123456782)', value: 1200 }, { name: 'Piet de Vries, Keizersgracht 12', value: 800 }] };
    const h = await dryRunHint({ stepId: 'g', output: out }, dw);
    assert.equal(h.shape, 'deals[*]: { name, value }');
    const r = validateAndFixBindings({ v: { kind: 'template', value: '{{steps.g.output.deals[0].value}}' } }, dw.def, { draftWrap: dw });
    assert.equal(r.inputs.v.value, '{{steps.g.output.deals[0].value}}');
    assert.ok(!/Jansen|Vries/.test(JSON.stringify(r)), 'no sample value in the result');
});
