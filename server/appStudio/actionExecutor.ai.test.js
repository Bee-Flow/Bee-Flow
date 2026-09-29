/**
 * App Studio — native AI action steps (ai_extract / ai_generate / kb_query).
 *
 * executeDataStep is exercised with the REAL queryCompiler + rlsGateway (so the
 * ai_extract → writeTo → writeRecord path really compiles inserts), but
 * appStudio/aiRuntime is stubbed so no model/provider/KB/storage is touched.
 *
 * Run: cd server && node --test appStudio/actionExecutor.ai.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Record-write plumbing stubs (mirror actionExecutor.test.js) ──────────────
const execCalls = [];
const batchCalls = [];
const queryCalls = [];
let queryRows = [];
let batchThrows = null;
stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params) => { queryCalls.push({ sql, params }); return { rows: queryRows }; },
    exec: async (ownerId, appId, sql, params) => { execCalls.push({ ownerId, appId, sql, params }); return { changes: 1, lastInsertRowid: 0 }; },
    // All-or-nothing like the real store's transaction: a failure records nothing.
    batch: async (ownerId, appId, statements) => {
        if (batchThrows) throw batchThrows;
        batchCalls.push({ ownerId, appId, statements });
        return statements.map(() => ({ changes: 1, lastInsertRowid: 0 }));
    },
    sizeBytes: async () => 0,
});
stub('../stores/studioAppDataStore', {
    bumpDataVersion: async () => 1,
    bumpRowCount: async () => ({}),
    getRowCounts: async () => ({}),
    getMemberRole: async () => null,
    getAttachment: async () => null,
});
stub('../stores/storageStore', { buildStudioAppAttachmentKey: (o, a, s) => `studio-apps/${o}/${a}/attachments/${s}` });
stub('../utils/tempDownloadUrl', { generateTempDownloadUrl: () => 'https://host/tmp' });
stub('../stores/automationStore', { getAutomation: async () => null, getRunSteps: async () => [] });
stub('../core/automationRunner', { executeAutomation: async () => ({ id: 'r', status: 'success' }) });

// ── aiRuntime stub (controllable per test) ───────────────────────────────────
const calls = { resolveOwnerModel: [], extractDocuments: [], groundWithKB: [], runStructured: [], runText: [] };
const aiState = {
    model: { modelId: 'm-std', options: {}, supportsVision: false, tierName: 'standard' },
    structured: { rows: [{ vendor: 'ACME', amount: 10 }, { vendor: 'Globex', amount: 20 }] },
    genStructured: { title: 'Ticket', priority: 'high' },
    text: 'a concise summary',
    chunks: [{ title: 'Handbook', content: 'policy body', score: 0.91, source_uri: '' }],
    docBlocks: [{ type: 'text', text: '[invoice.pdf — extracted]\nINVOICE ACME 10' }],
};
stub('./aiRuntime', {
    resolveOwnerModel: async (app, tier) => { calls.resolveOwnerModel.push({ tier }); return aiState.model; },
    extractDocuments: async (app, descriptors, opts) => { calls.extractDocuments.push({ descriptors, opts }); return aiState.docBlocks; },
    groundWithKB: async (app, args) => { calls.groundWithKB.push(args); return { context: '', chunks: aiState.chunks }; },
    runStructured: async (app, model, args) => {
        calls.runStructured.push(args);
        // ai_extract wraps rows; ai_generate passes a flat object schema.
        const isExtract = !!(args.parameters && args.parameters.properties && args.parameters.properties.rows);
        return { structured: isExtract ? aiState.structured : aiState.genStructured };
    },
    runText: async (app, model, args) => { calls.runText.push(args); return { text: aiState.text }; },
    // The tool-loop variants the executor now calls; with no `datasets` binding
    // on a step, tools is [] and the real implementations delegate to the plain
    // calls — the stub mirrors that so every existing expectation holds.
    runStructuredWithTools: async (app, model, args) => {
        calls.runStructured.push(args);
        const isExtract = !!(args.parameters && args.parameters.properties && args.parameters.properties.rows);
        return { structured: isExtract ? aiState.structured : aiState.genStructured };
    },
    runTextWithTools: async (app, model, args) => { calls.runText.push(args); return { text: aiState.text }; },
    fieldsToObjectSchema: (fields) => ({ type: 'object', properties: Object.fromEntries((fields || []).map((f) => [f.name, { type: 'string' }])) }),
    normalizeSchemaFields: (fields) => (Array.isArray(fields) ? fields.filter((f) => f && f.name).map((f) => ({ name: f.name, type: f.type || 'string', required: !!f.required })) : []),
    coerceRowToFields: (row, fields) => { const o = {}; for (const f of fields) o[f.name] = row ? row[f.name] : undefined; return o; },
    MAX_EXTRACT_ROWS: 500,
});

// A member's genome file (routes/studioAppDatasets.js) in owner-1's app —
// what an AI step's `datasets` binding names. Alice uploaded it.
stub('../stores/datasetFileStore', {
    getDataset: async (id, appId, ownerId) => (id === 'ds-alice' && appId === 'app-1' && ownerId === 'owner-1'
        ? { id, appId, ownerId, uploaderId: 'alice', name: 'alice.vcf', status: 'ready', variantCount: 20, metadata: { build: 'GRCh38' } }
        : null),
});

const actionExecutor = require('./actionExecutor');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1', name: 'Ops' };
function table() {
    return {
        id: 'tbl_aaa111', key: 'invoices', name: 'Invoices',
        fields: [{ id: 'fld_v', key: 'vendor', type: 'text' }, { id: 'fld_a', key: 'amount', type: 'number', subtype: 'integer' }],
        access: { default: 'app', roles: {}, rowFilters: {} },
    };
}
const model = { modelVersion: 1, tables: [table()], roles: [], roleMapping: { default: 'app', byGroup: {} } };
function ctx(extra = {}) { return { viewerId: OWNER, role: 'owner', orgId: 'org-1', formValues: {}, vars: {}, viewer: { id: OWNER }, ...extra }; }

test.beforeEach(() => {
    execCalls.length = 0;
    batchCalls.length = 0;
    queryCalls.length = 0;
    queryRows = [];
    batchThrows = null;
    for (const k of Object.keys(calls)) calls[k].length = 0;
    aiState.structured = { rows: [{ vendor: 'ACME', amount: 10 }, { vendor: 'Globex', amount: 20 }] };
});

// The params of the i-th INSERT compiled into the single writeTo transaction.
const insertParams = (i) => batchCalls[0].statements[i].params;

// ── ai_generate ──────────────────────────────────────────────────────────────

test('ai_generate: a records-bound `attachments` reads the file descriptors out of the rows', async () => {
    // The classify case: the mail body is two polite sentences and every
    // material lives in the attachments table. A records binding resolves
    // under the viewer's access and each row is plucked for descriptor-shaped
    // values (a `file` column stores JSON text); bare ids and plain text never
    // survive the normalizer.
    queryRows = [
        { id: 'rec1', filename: 'bon.pdf', file: JSON.stringify({ kind: 'studio_attachment', fileId: 'f-1', name: 'bon.pdf', mime: 'application/pdf' }) },
        { id: 'rec2', filename: 'tek.pdf', file: JSON.stringify({ kind: 'studio_attachment', fileId: 'f-2', name: 'tek.pdf', mime: 'application/pdf' }) },
    ];
    const step = {
        kind: 'ai_generate', prompt: 'Classify the request', output: 'text', resultVar: 'out',
        attachments: { kind: 'records', tableId: 'tbl_aaa111' },
    };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(queryCalls.length >= 1, true, 'the records binding compiled a SELECT');
    const descs = calls.extractDocuments[0].descriptors;
    assert.deepStrictEqual(descs.map((d) => d.fileId), ['f-1', 'f-2']);
});

test('ai_generate (text): interpolates the prompt and returns generated text', async () => {
    const step = { kind: 'ai_generate', prompt: 'Summarize: {{form.notes}}', output: 'text', modelTier: 'fast', resultVar: 'out' };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx({ formValues: { notes: 'quarterly numbers' } }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.text, 'a concise summary');
    // citations rides along (titles/scores only — see the leak test below).
    assert.ok(Array.isArray(r.result.citations));
    assert.match(calls.runText[0].user, /quarterly numbers/); // {{form.notes}} resolved
    assert.strictEqual(calls.resolveOwnerModel[0].tier, 'fast');
});

test('ai_generate (structured): returns a coerced object from the declared schema', async () => {
    const step = {
        kind: 'ai_generate', prompt: 'Make a ticket', output: 'structured',
        schema: [{ name: 'title', type: 'string' }, { name: 'priority', type: 'string' }],
        resultVar: 'ticket',
    };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx());
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.result, { title: 'Ticket', priority: 'high' });
});

test('ai_generate: an empty prompt is a 400 (surfaced as ok:false)', async () => {
    const r = await actionExecutor.executeDataStep(app, model, { kind: 'ai_generate', prompt: '   ', output: 'text', resultVar: 'x' }, ctx());
    assert.strictEqual(r.ok, false);
});

// ── kb_query ───────────────────────────────────────────────────────────────

test('kb_query: resolves the query binding and returns KB chunks', async () => {
    const step = { kind: 'kb_query', query: { kind: 'formula', expr: 'form.q' }, knowledgeBaseIds: ['kb1'], topK: 4, resultVar: 'hits' };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx({ formValues: { q: 'refund policy' } }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.count, 1);
    assert.strictEqual(r.result.results[0].title, 'Handbook');
    assert.strictEqual(calls.groundWithKB[0].query, 'refund policy');
    assert.strictEqual(calls.groundWithKB[0].topK, 4);
});

// ── ai_extract ───────────────────────────────────────────────────────────────

test('ai_extract (no writeTo): returns extracted rows without touching the DB', async () => {
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }, { name: 'amount', type: 'number' }],
        resultVar: 'rows',
    };
    const formValues = { doc: { kind: 'studio_attachment', fileId: 'f1', name: 'invoice.pdf' } };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx({ formValues }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.count, 2);
    assert.strictEqual(r.result.written, 0);
    assert.strictEqual(batchCalls.length, 0, 'no inserts without writeTo');
    assert.strictEqual(calls.extractDocuments[0].descriptors.length, 1);
});

test('ai_extract (writeTo): inserts one record per extracted row in ONE transaction', async () => {
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }, { name: 'amount', type: 'number' }],
        writeTo: { tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' } },
    };
    const formValues = { doc: { kind: 'studio_attachment', fileId: 'f1' } };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx({ formValues }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.written, 2);
    assert.strictEqual(batchCalls.length, 1, 'the whole extraction is one batch');
    assert.strictEqual(batchCalls[0].statements.length, 2, 'one insert per extracted row');
    assert.strictEqual(batchCalls[0].ownerId, OWNER, 'the batch runs acts-as-owner');
    // the compiled insert carries the mapped values
    assert.ok(insertParams(0).includes('ACME'));
    assert.ok(insertParams(1).includes('Globex'));
});

test('ai_extract (writeTo): a failure part-way through writes NOTHING', async () => {
    // The store's transaction is all-or-nothing; the step must not report — or
    // leave behind — a half-written extraction.
    batchThrows = Object.assign(new Error('App row limit reached'), { status: 409, code: 'quota_exceeded', limit: 100, used: 100 });
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }, { name: 'amount', type: 'number' }],
        writeTo: { tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' } },
    };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx({ formValues: { doc: { kind: 'studio_attachment', fileId: 'f1' } } }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'quota_exceeded');
    assert.strictEqual(batchCalls.length, 0, 'nothing committed');
    assert.strictEqual(execCalls.length, 0, 'and no single-row insert slipped through');
});

test('ai_extract: a missing file field is a 400', async () => {
    const step = { kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' }, schema: [{ name: 'vendor', type: 'string' }] };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx({ formValues: {} }));
    assert.strictEqual(r.ok, false);
});

// ── writeTo column matching ─────────────────────────────────────────────────

const extractStep = (writeTo) => ({
    kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
    schema: [{ name: 'vendor', type: 'string' }, { name: 'amount', type: 'number' }],
    writeTo,
});
const withDoc = () => ctx({ formValues: { doc: { kind: 'studio_attachment', fileId: 'f1' } } });

test('ai_extract (writeTo, no mapping): each output field lands in the column of the same name', async () => {
    const r = await actionExecutor.executeDataStep(app, model, extractStep({ tableId: 'tbl_aaa111' }), withDoc());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.written, 2);
    assert.ok(insertParams(0).includes('ACME'));
    assert.ok(insertParams(0).includes(10), 'the number column is filled too');
});

test('ai_extract (writeTo): an empty mapping matches by name rather than inserting rows of nulls', async () => {
    const r = await actionExecutor.executeDataStep(app, model, extractStep({ tableId: 'tbl_aaa111', mapping: {} }), withDoc());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.written, 2);
    assert.ok(insertParams(0).includes('ACME'));
});

test('ai_extract (writeTo): pairs naming a dropped column or a renamed field are ignored', async () => {
    // `note` is not a column and `supplier` is not an output field; only the
    // vendor pair survives, and it alone is written.
    const step = extractStep({ tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', note: 'amount', amount: 'supplier' } });
    const r = await actionExecutor.executeDataStep(app, model, step, withDoc());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.written, 2);
    assert.ok(insertParams(0).includes('ACME'));
    assert.ok(!insertParams(0).includes(10), 'the pair pointing at a missing field is dropped, not written as null');
});

test('ai_extract (writeTo): refuses the write when no field matches a column', async () => {
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'field1', type: 'string' }],
        writeTo: { tableId: 'tbl_aaa111', mapping: {} },
    };
    const r = await actionExecutor.executeDataStep(app, model, step, withDoc());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /match a column/i);
    assert.strictEqual(batchCalls.length, 0, 'no blank rows inserted');
});

test('resolveWriteMapping: computed columns are never a target', () => {
    const t = { fields: [{ key: 'vendor', type: 'text' }, { key: 'total', type: 'computed' }] };
    const fields = [{ name: 'vendor' }, { name: 'total' }];
    assert.deepStrictEqual(actionExecutor._resolveWriteMapping(undefined, fields, t), { vendor: 'vendor' });
    // …not even when named explicitly.
    assert.deepStrictEqual(actionExecutor._resolveWriteMapping({ total: 'total' }, fields, t), { vendor: 'vendor' });
});

// ── the legacy record steps are unchanged (regression snapshot) ──────────────

test('create_record still works unchanged after the AI-step additions', async () => {
    const step = { kind: 'create_record', tableId: 'tbl_aaa111', values: { vendor: { kind: 'static', value: 'Initech' } } };
    const r = await actionExecutor.executeDataStep(app, model, step, ctx());
    assert.strictEqual(r.ok, true);
    assert.ok(r.result.id.startsWith('rec_'));
    assert.strictEqual(execCalls.length, 1);
});

// ── ai_generate: promptContext + citations ──────────────────────────────────

test('promptContext appends live data to the prompt', async () => {
    // Without this a generated draft has no ticket to write ABOUT: `prompt` is
    // a fixed string authored at design time.
    const r = await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_generate',
        prompt: 'Draft a reply.',
        promptContext: { kind: 'static', value: { subject: 'Bestelling 123', from: 'jan@example.com' } },
        output: 'text', resultVar: 'draft',
    }, ctx());

    assert.strictEqual(r.ok, true, r.error);
    const sent = calls.runText.at(-1);
    assert.match(sent.user, /Draft a reply\./);
    assert.match(sent.user, /Context:/);
    assert.match(sent.user, /Bestelling 123/);
});

test('a promptContext bound to RECORDS actually reads the table', async () => {
    // The bug this pins: resolveBinding answers null for every data kind, so an
    // author who pointed the AI draft at "the open ticket" got the instruction
    // sentence and nothing else. It read like a bad model; it was an empty
    // prompt. Now it goes through the real compiler, under the viewer's access.
    queryRows = [{ vendor: 'ACME', amount: 10 }, { vendor: 'Globex', amount: 20 }];

    const r = await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_generate', prompt: 'Draft a reply.',
        promptContext: {
            kind: 'records', tableId: 'tbl_aaa111',
            filter: [{ field: 'vendor', op: 'eq', value: { kind: 'formula', expr: 'vars.who' } }],
            limit: 10,
        },
        output: 'text', resultVar: 'draft',
    }, ctx({ vars: { who: 'ACME' } }));

    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(queryCalls.length, 1, 'one bounded query, not a table scan per row');
    assert.ok(/FROM "invoices"/.test(queryCalls[0].sql));
    assert.ok(queryCalls[0].params.includes('ACME'), 'the filter binding is resolved server-side');
    assert.match(calls.runText.at(-1).user, /Globex/);
});

test('a required filter with nothing to resolve means NO rows, not every row', async () => {
    // Nothing selected yet. Dropping the filter would hand the model every row
    // in the table — and bill the owner for it.
    queryRows = [{ vendor: 'ACME', amount: 10 }];

    await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_generate', prompt: 'Draft a reply.',
        promptContext: {
            kind: 'records', tableId: 'tbl_aaa111',
            filter: [{ field: 'vendor', op: 'eq', value: { kind: 'formula', expr: 'vars.nothing' }, required: true }],
        },
        output: 'text', resultVar: 'draft',
    }, ctx());

    assert.strictEqual(queryCalls.length, 0, 'the query is never even compiled');
    assert.ok(!/Context:/.test(calls.runText.at(-1).user));
});

test('a promptContext table that no longer exists degrades to no context', async () => {
    // Failing the whole action would be worse: the prompt still works, it just
    // has less to go on, and the validator reports the dangling id at save time.
    const r = await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_generate', prompt: 'Draft.',
        promptContext: { kind: 'record', tableId: 'tbl_gone' },
        output: 'text', resultVar: 'draft',
    }, ctx());

    assert.strictEqual(r.ok, true);
    assert.strictEqual(queryCalls.length, 0);
});

test('a string promptContext is passed through as-is', async () => {
    await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_generate', prompt: 'Vat samen.',
        promptContext: { kind: 'static', value: 'De klant wacht op pakket 123.' },
        output: 'text', resultVar: 'x',
    }, ctx());
    assert.match(calls.runText.at(-1).user, /De klant wacht op pakket 123\./);
});

test('promptContext is capped so a big binding cannot blow the context window', async () => {
    await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_generate', prompt: 'x',
        promptContext: { kind: 'static', value: 'y'.repeat(50_000) },
        output: 'text', resultVar: 'x',
    }, ctx());
    assert.ok(calls.runText.at(-1).user.length < 20_000);
});

test('no promptContext leaves the prompt untouched', async () => {
    await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_generate', prompt: 'Alleen dit.', output: 'text', resultVar: 'x',
    }, ctx());
    assert.strictEqual(calls.runText.at(-1).user, 'Alleen dit.');
});

test('ai_generate returns citation TITLES, never the KB bodies', async () => {
    // The chunk text is already in the prompt; handing it back in a
    // client-visible result would leak KB content to a viewer who may have no
    // access to that knowledge base.
    const r = await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_generate', prompt: 'Draft.', knowledgeBaseIds: ['kb_1'], output: 'text', resultVar: 'draft',
    }, ctx());

    assert.ok(Array.isArray(r.result.citations));
    assert.strictEqual(r.result.citations[0].title, 'Handbook');
    assert.strictEqual(r.result.citations[0].score, 0.91);
    assert.ok(!('content' in r.result.citations[0]), 'the chunk body must not travel to the client');
    assert.ok(!JSON.stringify(r.result.citations).includes('policy body'));
});

// ── writeTo provenance ──────────────────────────────────────────────────────
// Without constants an extracted row is an orphan: nothing records which ticket
// or document it came from, so it cannot be shown in context and a retention
// purge has no way to find it.

function provenanceTable() {
    return {
        id: 'tbl_prov', key: 'lines', name: 'Lines',
        fields: [
            { id: 'f_v', key: 'vendor', type: 'text' },
            { id: 'f_t', key: 'thread_key', type: 'text' },
            { id: 'f_c', key: 'total', type: 'number', computed: 'amount * 2' },
        ],
        access: { default: 'app', roles: {}, rowFilters: {} },
    };
}
const provModel = { modelVersion: 1, tables: [table(), provenanceTable()], roles: [], roleMapping: { default: 'app', byGroup: {} } };

test('ai_extract: constants are stamped on every row, resolved once', async () => {
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }],
        writeTo: {
            tableId: 'tbl_prov',
            mapping: { vendor: 'vendor' },
            constants: { thread_key: { kind: 'formula', expr: 'vars.thread' } },
        },
    };
    const r = await actionExecutor.executeDataStep(app, provModel, step, ctx({
        formValues: { doc: { kind: 'studio_attachment', fileId: 'f1' } },
        vars: { thread: 'T-42' },
    }));

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.written, 2);
    assert.ok(insertParams(0).includes('T-42'), 'first row carries the ticket');
    assert.ok(insertParams(1).includes('T-42'), 'and so does the second');
});

test('ai_extract: a constant beats a same-named mapping', async () => {
    // Provenance is not the model's to overwrite: if both name a column, the
    // one that records where the row came from wins.
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }],
        writeTo: {
            tableId: 'tbl_prov',
            mapping: { vendor: 'vendor' },
            constants: { vendor: { kind: 'static', value: 'FIXED' } },
        },
    };
    await actionExecutor.executeDataStep(app, provModel, step, ctx({
        formValues: { doc: { kind: 'studio_attachment', fileId: 'f1' } },
    }));
    assert.ok(insertParams(0).includes('FIXED'));
    assert.ok(!insertParams(0).includes('ACME'));
});

test('ai_extract: a computed column is never a constant target', async () => {
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }],
        writeTo: {
            tableId: 'tbl_prov',
            mapping: { vendor: 'vendor' },
            constants: { total: { kind: 'static', value: 999 } },
        },
    };
    await actionExecutor.executeDataStep(app, provModel, step, ctx({
        formValues: { doc: { kind: 'studio_attachment', fileId: 'f1' } },
    }));
    assert.ok(!insertParams(0).includes(999), 'server-managed columns stay server-managed');
});

test('ai_extract: the step viewer is handed to the document loader', async () => {
    // extractDocuments must be able to re-check that THIS viewer may read the
    // file — source resolves from client-supplied formValues/vars/item, so
    // owner-scope alone would let anyone name any fileId in the app.
    const step = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }],
    };
    await actionExecutor.executeDataStep(app, model, step, ctx({
        viewerId: 'someone-else', role: 'agent',
        formValues: { doc: { kind: 'studio_attachment', fileId: 'f1' } },
    }));
    const opts = calls.extractDocuments[0].opts;
    assert.strictEqual(opts.viewer.id, 'someone-else');
    assert.strictEqual(opts.viewer.role, 'agent');
    assert.ok(opts.model, 'and the model, so RLS can be compiled');
});

// ── Double-encoded file descriptors (the "cannot open the PDF" bug) ──────────

test('a DOUBLE-encoded descriptor from a file column still reaches the extractor', async () => {
    // Rows written while the connector pre-stringified descriptors hold JSON
    // text whose first parse yields ANOTHER string. normalizeFileDescriptors
    // dropped those outright (the trimmed string starts with `"`), so the AI
    // answered "No file was provided" about an invoice that was plainly there.
    const descriptor = { kind: 'studio_attachment', fileId: 'f1', name: 'factuur.pdf' };
    const doubleEncoded = JSON.stringify(JSON.stringify(descriptor));

    const r = await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }],
        resultVar: 'rows',
    }, ctx({ formValues: { doc: doubleEncoded } }));

    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(calls.extractDocuments[0].descriptors, [descriptor]);
});

test('a SINGLE-encoded descriptor keeps working exactly as before', async () => {
    const descriptor = { kind: 'studio_attachment', fileId: 'f1', name: 'factuur.pdf' };
    const r = await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }],
        resultVar: 'rows',
    }, ctx({ formValues: { doc: JSON.stringify(descriptor) } }));

    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(calls.extractDocuments[0].descriptors, [descriptor]);
});

// ── writeTo.upsertOn — reading the same document twice ──────────────────────

test('ai_extract (upsertOn): an existing row is UPDATEd, not doubled', async () => {
    // THE CASE: a bill of materials read after the file intake already created
    // one line per part. Without a key, "read the sheet" added 77 rows beside
    // the 77 that were there, and the second press another 77.
    queryRows = [{ id: 'rec_existing', vendor: 'ACME' }];
    const step = extractStep({
        tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' }, upsertOn: 'vendor',
    });
    const r = await actionExecutor.executeDataStep(app, model, step, withDoc());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.written, 2);
    assert.strictEqual(batchCalls.length, 0, 'the batch insert path is not taken');
    const updates = execCalls.filter((c) => /^UPDATE/i.test(c.sql.trim()));
    assert.strictEqual(updates.length, 2, 'both rows matched the existing record');
    // and it looked the row up by the key column, under the viewer's access
    assert.ok(queryCalls.some((c) => /"vendor"/.test(c.sql)), 'matched on the named column');
});

test('ai_extract (upsertOn): a row with no match is still written', async () => {
    queryRows = [];
    const step = extractStep({
        tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' }, upsertOn: 'vendor',
    });
    const r = await actionExecutor.executeDataStep(app, model, step, withDoc());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.written, 2);
    const inserts = execCalls.filter((c) => /^INSERT/i.test(c.sql.trim()));
    assert.strictEqual(inserts.length, 2, 'a key nothing matches is a new row, not a skipped one');
});

test('ai_extract (no upsertOn): the batch insert is untouched', async () => {
    // The default has to stay exactly what it was: an extraction that
    // DISCOVERS records (invoice lines off a scan) wants every one of them.
    queryRows = [{ id: 'rec_existing', vendor: 'ACME' }];
    const step = extractStep({ tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' } });
    const r = await actionExecutor.executeDataStep(app, model, step, withDoc());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(batchCalls.length, 1, 'still one transaction');
    assert.strictEqual(batchCalls[0].statements.length, 2);
});

// ── The silent-loss paths ────────────────────────────────────────────────────
//
// Every test below covers a way an extraction used to answer ok:true while
// losing the data. They were found together, on one app whose 9-line order came
// back with every column empty and a green toast.

test('ai_extract: no rows array is a 422 naming the model — after ONE retry', async () => {
    // Silently the worst of the lot: `Array.isArray(structured.rows) ? … : []`
    // turned a refusing model into "this document had nothing in it".
    let attempts = 0;
    const aiRuntime = require('./aiRuntime');
    const original = aiRuntime.runStructuredWithTools;
    aiRuntime.runStructuredWithTools = async () => { attempts += 1; return { structured: { note: 'I cannot read this' } }; };
    try {
        // The dispatcher's own contract turns a 422 into a failed STEP rather
        // than a throw, so this is exactly what the running action sees.
        const res = await actionExecutor.executeDataStep(app, model, {
            kind: 'ai_extract',
            source: { kind: 'static', value: { kind: 'studio_attachment', fileId: 'f-1', name: 'x.pdf' } },
            schema: [{ name: 'vendor', type: 'string' }],
        }, ctx());
        assert.strictEqual(res.ok, false, 'never a cheerful ok:true with nothing written');
        assert.match(res.error, /m-std/, 'the model that failed is named');
        assert.match(res.error, /standard/, 'and the tier it came from');
        assert.strictEqual(attempts, 2, 'exactly one retry — a 163-drawing loop must not triple the bill');
    } finally {
        aiRuntime.runStructuredWithTools = original;
    }
});

test('ai_extract: the result says WHICH model answered', async () => {
    const res = await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_extract',
        source: { kind: 'static', value: { kind: 'studio_attachment', fileId: 'f-1', name: 'x.pdf' } },
        schema: [{ name: 'vendor', type: 'string' }],
    }, ctx());
    // "The AI is bad at drawings" and "the AI was a 0.6B text model" look the
    // same from the outside unless the run records this.
    assert.strictEqual(res.result.model, 'm-std');
    assert.strictEqual(res.result.tier, 'standard');
});

test('ai_extract: resultDetail summary keeps the rows out of the step body', async () => {
    // A 163-line purchase order that also WRITES its rows shipped them back as
    // well and tripped the 64KB body cap.
    const step = {
        kind: 'ai_extract',
        source: { kind: 'static', value: { kind: 'studio_attachment', fileId: 'f-1', name: 'x.pdf' } },
        schema: [{ name: 'vendor', type: 'string' }],
    };
    const full = await actionExecutor.executeDataStep(app, model, step, ctx());
    assert.strictEqual(full.result.rows.length, 2);
    assert.strictEqual(full.result.count, 2);

    const lean = await actionExecutor.executeDataStep(app, model, { ...step, resultDetail: 'summary' }, ctx());
    assert.deepStrictEqual(lean.result.rows, [], 'no rows in the body');
    assert.strictEqual(lean.result.count, 2, 'but the count still tells the truth');
});

test('ai_extract: a required field the model left blank is COUNTED, not assumed filled', async () => {
    // `required` in the schema is advisory to the provider and never re-checked:
    // coerceRowToFields fills a missing field with null and nothing notices.
    aiState.structured = { rows: [{ vendor: 'ACME', amount: 10 }, { amount: 20 }] };
    const res = await actionExecutor.executeDataStep(app, model, {
        kind: 'ai_extract',
        source: { kind: 'static', value: { kind: 'studio_attachment', fileId: 'f-1', name: 'x.pdf' } },
        schema: [{ name: 'vendor', type: 'string', required: true }, { name: 'amount', type: 'number' }],
    }, ctx());
    assert.strictEqual(res.result.count, 2);
    assert.strictEqual(res.result.incomplete, 1, 'one row came back without its required field');
});

test('ai_extract (insertMissing:false): a key that matches nothing is REPORTED, not invented', async () => {
    // THE CASE: a bill of materials whose part numbers are one suffix short of
    // the file-derived ones ("3010-005424" against "3010-005424-01"). Every
    // mismatch inserted instead of updating, so an order of 85 real lines
    // carried 78 ghosts beside them — same grid, same badge, no way to tell.
    queryRows = [];
    const step = extractStep({
        tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' },
        upsertOn: 'vendor', insertMissing: false,
    });
    const r = await actionExecutor.executeDataStep(app, model, step, withDoc());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.written, 0, 'nothing invented');
    assert.strictEqual(execCalls.filter((c) => /^INSERT/i.test(c.sql.trim())).length, 0);
    assert.deepStrictEqual(r.result.unmatched, ['ACME', 'Globex'], 'named, so the action can say which');
    assert.strictEqual(r.result.unmatchedCount, 2);
});

test('ai_extract (fillOnly): a blank answer never erases what is already there', async () => {
    // THE CASE: the sheet extraction wrote null over the column defaults for
    // cut quality and certificate on 146 of 163 lines. Those rows then went
    // into the portal CSV with no cut quality at all.
    queryRows = [{ id: 'rec_existing', vendor: 'ACME', amount: 99 }];
    aiState.structured = { rows: [{ vendor: 'ACME', amount: null }] };
    const step = extractStep({
        tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' },
        upsertOn: 'vendor', fillOnly: true,
    });
    const r = await actionExecutor.executeDataStep(app, model, step, withDoc());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.written, 1);
    const update = execCalls.find((c) => /^UPDATE/i.test(c.sql.trim()));
    assert.ok(update, 'the row was still touched');
    assert.ok(!/"amount"/.test(update.sql), 'but the column it had a value for was left alone');
});

test('ai_extract (fillOnly): an EMPTY column is still filled — that is the point', async () => {
    queryRows = [{ id: 'rec_existing', vendor: 'ACME', amount: null }];
    aiState.structured = { rows: [{ vendor: 'ACME', amount: 42 }] };
    const step = extractStep({
        tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' },
        upsertOn: 'vendor', fillOnly: true,
    });
    await actionExecutor.executeDataStep(app, model, step, withDoc());
    const update = execCalls.find((c) => /^UPDATE/i.test(c.sql.trim()));
    assert.ok(/"amount"/.test(update.sql), 'the gap is filled');
    assert.ok(update.params.includes(42));
});

test('ai_extract: without the new flags nothing changes', async () => {
    // The whole point of keeping both off by default: every definition written
    // before today must behave byte-identically.
    queryRows = [];
    const step = extractStep({
        tableId: 'tbl_aaa111', mapping: { vendor: 'vendor', amount: 'amount' }, upsertOn: 'vendor',
    });
    const r = await actionExecutor.executeDataStep(app, model, step, withDoc());
    assert.strictEqual(r.result.written, 2);
    assert.strictEqual(r.result.unmatchedCount, 0);
    assert.strictEqual(execCalls.filter((c) => /^INSERT/i.test(c.sql.trim())).length, 2);
});

// ── A genome file in an AI step belongs to whoever uploaded it ──────────────

test('ai_generate: the genome tool is built over the clicking person\'s own file, and nobody else\'s', async () => {
    const step = { kind: 'ai_generate', prompt: 'What do my BRCA1 variants mean?', datasets: { kind: 'field', name: 'genome' } };
    const formValues = { genome: { kind: 'studio_dataset', datasetId: 'ds-alice', name: 'alice.vcf', build: 'GRCh38' } };
    const as = (who) => ctx({ viewerId: who, role: who === OWNER ? 'owner' : 'member', viewer: { id: who }, formValues });

    const hers = await actionExecutor.executeDataStep(app, model, step, as('alice'));
    assert.strictEqual(hers.ok, true, hers.error);
    assert.deepStrictEqual(calls.runText.at(-1).tools.map((t) => t.def.function.name), ['query_genome_dataset']);

    calls.runText.length = 0;
    const others = {};
    for (const who of ['bob', OWNER]) {
        const r = await actionExecutor.executeDataStep(app, model, step, as(who));
        others[who] = `${r.ok} ${r.error}`;
    }
    assert.deepStrictEqual(others, { bob: 'false Dataset not found', [OWNER]: 'false Dataset not found' });
    assert.strictEqual(calls.runText.length, 0, 'no model call was handed her genome');
});
