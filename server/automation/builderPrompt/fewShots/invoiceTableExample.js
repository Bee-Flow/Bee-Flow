// @typecheck strict
'use strict';
/**
 * Fan-out example: list, read per file, extract per result, add_row per result.
 *
 * One of the builder agent's few-shot dialogues, assembled by
 * ../fewShotExamples.js (which documents the echo contract every tool
 * result here follows and the order the profiles see them in). A factory
 * rather than a constant: each call returns fresh message objects, so a
 * caller that edits a message cannot change the next conversation's copy.
 */

// Fan-out example — list → read-per-file → extract-per-result → add_row-
// per-result, in ONE builder_add_steps. This is the brief the small
// profile failed on most (2026-09-12, fast local model): its datatable
// entry arrived without a type, its extraction fields landed beside spec,
// and the loop re-sent the same batch three rounds running — every
// repair in addSteps.js names that build. The batched example above
// teaches the protocol on a flat chain; nothing showed a small model the
// chained forEach shape (each step's overRef is the PREVIOUS fan-out's
// `.output.results`, its bindings read `loop.<var>.output.<field>`) or a
// datatable write keyed by column KEY, so it guessed both. Core-menu
// tools only, so every profile can replay it verbatim.
//
// `tbl_fact01` / `facturen` stand for the id and key shown in the
// "Datatables you may use" block. The builder resolves an unknown id
// through a matching key/name (datatableRefs.resolveDatatableRef), so a
// literal copy of this example still lands on the user's real table — with
// a warning, which is the one round we would rather not spend.
//
// No status==='success' filter sits between read and extract on purpose:
// the point is the four-step shape. A model that adds the filter has
// learned the shape already.
function invoiceTableExample() {
    return [
        { role: 'user', content: 'Manual trigger. Read every PDF invoice in my Nextcloud folder /Invoices-Test, extract date, supplier, invoice number, excl VAT, VAT and total, and append one row per invoice to the EXISTING datatable "Facturen" (columns Datum, Leverancier, Factuurnummer, Excl. btw, Btw, Totaal). Do not create tables or columns.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'ex_d1', type: 'function',
                    function: {
                        name: 'builder_set_plan',
                        arguments: JSON.stringify({ todos: [{ text: 'Manual trigger' }, { text: 'List → read → extract → append rows to Facturen' }, { text: 'Dry-run and finalize' }] }),
                    },
                },
                {
                    id: 'ex_d2', type: 'function',
                    function: {
                        name: 'builder_inspect_tool',
                        arguments: JSON.stringify({ tools: ['nextcloud_list_files', 'nextcloud_read_file'] }),
                    },
                },
                {
                    id: 'ex_d3', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({ kind: 'manual' }),
                    },
                },
                {
                    id: 'ex_d8', type: 'function',
                    function: {
                        name: 'builder_set_metadata',
                        arguments: JSON.stringify({ title: 'Invoices from /Invoices-Test into Facturen', description: 'Read every PDF invoice in /Invoices-Test, extract six fields and append one row per invoice to the Facturen datatable.' }),
                    },
                },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_d1', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Manual trigger', done: false }, { i: 1, text: 'List → read → extract → append rows to Facturen', done: false }, { i: 2, text: 'Dry-run and finalize', done: false }], next: 'Manual trigger' }) },
        // The batch inspect form (samples omitted); the shape strings are the
        // real describeShape() output for these two tools — `items` and
        // `content` are the two names the model used to guess.
        {
            role: 'tool', tool_call_id: 'ex_d2',
            content: JSON.stringify({
                results: {
                    nextcloud_list_files: { tool: 'nextcloud_list_files', inputs: { path: { type: 'string', required: true } }, requiredInputs: ['path'], shape: 'path: string; count: integer; items: array of { name, path, type ("file"|"folder"), size, contentType, modified, fileId }', source: 'curated', sample: null, iterableFields: ['items'] },
                    nextcloud_read_file: { tool: 'nextcloud_read_file', inputs: { path: { type: 'string', required: true } }, requiredInputs: ['path'], shape: 'path: string; size: integer; contentType: string; extractedVia: string|undefined; truncated: boolean; content: string; meta: object|undefined', source: 'curated', sample: null },
                },
            }),
        },
        { role: 'tool', tool_call_id: 'ex_d3', content: JSON.stringify({ trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, _draftSteps: [{ id: 'trg', type: 'trigger', kind: 'manual' }], _wiring: 'main: (no edges yet)' }) },
        { role: 'tool', tool_call_id: 'ex_d8', content: JSON.stringify({ title: 'Invoices from /Invoices-Test into Facturen', description: 'Read every PDF invoice in /Invoices-Test, extract six fields and append one row per invoice to the Facturen datatable.', _draftSteps: [{ id: 'trg', type: 'trigger', kind: 'manual' }], _wiring: 'main: (no edges yet)' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_d4', type: 'function',
                function: {
                    name: 'builder_add_steps',
                    arguments: JSON.stringify({
                        steps: [
                            { tempId: 'list', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices-Test' } }, label: 'List invoices' } },
                            { tempId: 'read', type: 'integration_action', spec: { tool: 'nextcloud_read_file', inputs: { path: { kind: 'ref', path: 'loop.f.path' } }, forEach: { overRef: 'steps.$list.output.items', itemVar: 'f' }, label: 'Read each PDF' } },
                            {
                                tempId: 'extract', type: 'data_extraction',
                                spec: {
                                    source: { kind: 'ref', path: 'loop.r.output.content' },
                                    fields: [
                                        { name: 'datum', type: 'date', description: 'Invoice date', required: true },
                                        { name: 'leverancier', type: 'string', description: 'Supplier name' },
                                        { name: 'factuurnummer', type: 'string', description: 'Invoice number', required: true },
                                        { name: 'excl_btw', type: 'number', description: 'Amount excluding VAT' },
                                        { name: 'btw', type: 'number', description: 'VAT amount' },
                                        { name: 'totaal', type: 'number', description: 'Total including VAT' },
                                    ],
                                    forEach: { overRef: 'steps.$read.output.results', itemVar: 'r' },
                                    label: 'Extract invoice fields',
                                },
                            },
                            {
                                tempId: 'save', type: 'datatable',
                                spec: {
                                    op: 'add_row', datatableId: 'tbl_fact01', datatableKey: 'facturen',
                                    values: {
                                        datum: { kind: 'ref', path: 'loop.x.output.datum' },
                                        leverancier: { kind: 'ref', path: 'loop.x.output.leverancier' },
                                        factuurnummer: { kind: 'ref', path: 'loop.x.output.factuurnummer' },
                                        excl_btw: { kind: 'ref', path: 'loop.x.output.excl_btw' },
                                        btw: { kind: 'ref', path: 'loop.x.output.btw' },
                                        totaal: { kind: 'ref', path: 'loop.x.output.totaal' },
                                    },
                                    forEach: { overRef: 'steps.$extract.output.results', itemVar: 'x' },
                                    label: 'Append row to Facturen',
                                },
                            },
                        ],
                    }),
                },
            }],
        },
        // The echo exactly as applyAddSteps + applyToolCall return it: added[]
        // and idMap from the batch, then — builder_add_steps is a topology
        // tool — the structured `_draftSteps` digest and the `_wiring` edge
        // line. The digest is where the model reads back which fields the
        // extraction declares and which column keys the write carries, so it
        // never has to re-inspect its own steps.
        {
            role: 'tool', tool_call_id: 'ex_d4',
            content: JSON.stringify({
                added: [
                    { tempId: 'list', id: 'a_1f2e3d', type: 'integration_action', tool: 'nextcloud_list_files' },
                    { tempId: 'read', id: 'a_4b5c6d', type: 'integration_action', tool: 'nextcloud_read_file' },
                    { tempId: 'extract', id: 'ex_7a8b9c', type: 'data_extraction' },
                    { tempId: 'save', id: 'dt_0d1e2f', type: 'datatable' },
                ],
                idMap: { list: 'a_1f2e3d', read: 'a_4b5c6d', extract: 'ex_7a8b9c', save: 'dt_0d1e2f' },
                _draftSteps: [
                    { id: 'trg', type: 'trigger', kind: 'manual' },
                    { id: 'a_1f2e3d', type: 'integration_action', tool: 'nextcloud_list_files', label: 'List invoices' },
                    { id: 'a_4b5c6d', type: 'integration_action', tool: 'nextcloud_read_file', forEach: 'over steps.a_1f2e3d.output.items as loop.f', label: 'Read each PDF' },
                    { id: 'ex_7a8b9c', type: 'data_extraction', forEach: 'over steps.a_4b5c6d.output.results as loop.r', label: 'Extract invoice fields', fields: ['datum', 'leverancier', 'factuurnummer', 'excl_btw', 'btw', 'totaal'] },
                    { id: 'dt_0d1e2f', type: 'datatable', forEach: 'over steps.ex_7a8b9c.output.results as loop.x', label: 'Append row to Facturen', op: 'add_row', table: 'facturen (tbl_fact01)', values: ['datum', 'leverancier', 'factuurnummer', 'excl_btw', 'btw', 'totaal'] },
                ],
                _wiring: 'main: trg→a_1f2e3d, a_1f2e3d→a_4b5c6d, a_4b5c6d→ex_7a8b9c, ex_7a8b9c→dt_0d1e2f',
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_d5', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ markDone: [0, 1] }) } },
                { id: 'ex_d6', type: 'function', function: { name: 'builder_summarise', arguments: '{}' } },
                { id: 'ex_d7', type: 'function', function: { name: 'builder_request_dry_run', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_d5', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Manual trigger', done: true }, { i: 1, text: 'List → read → extract → append rows to Facturen', done: true }, { i: 2, text: 'Dry-run and finalize', done: false }], next: 'Dry-run and finalize' }) },
        // applySummarise: {summary, hasSideEffects} — no `ok`. The summary is
        // summariseDefinition's own wording for this draft (it names the
        // per-item steps by their bindings, not with a "for each" prefix, and
        // the write by its label), pinned to the byte by the replay test.
        { role: 'tool', tool_call_id: 'ex_d6', content: JSON.stringify({ summary: '**Trigger:** When run manually.\n\n**Steps:**\n1. Call `nextcloud_list_files` with path="/Invoices-Test" — List invoices.\n2. Call `nextcloud_read_file` with path=`loop.f.path` — Read each PDF.\n3. Extract 6 field(s) (datum, leverancier, factuurnummer, excl_btw, btw, totaal) from `loop.r.output.content` — Extract invoice fields.\n4. Add a row to "Append row to Facturen".', hasSideEffects: true }) },
        // compactDryRunForModel shape. Every fan-out step's output is the
        // {iterations, succeeded, failed, results[]} envelope, and each
        // results[] entry is {index, item, output, status} — which is why the
        // next step binds `loop.<var>.output.<field>`, never `loop.<var>.<field>`.
        // A dry run proves the WIRING: the extraction returns the runner's
        // typed samples ("Sample datum" / 123.45 / "2026-01-15"), and the
        // write is a preview (`_dryRunSynthesised`) — status is 'success' on
        // both; a dry-run never touches the table or the extraction model.
        // compactSample cuts at depth 4, so a fan-out entry's `item` (the
        // previous fan-out's entry) shows its own item/output as '<object>',
        // and a previewed row inside a fan-out is '<object>' too — exactly
        // what the model sees live (fewShotExamples.replay.test.js pins it).
        {
            role: 'tool', tool_call_id: 'ex_d7',
            content: JSON.stringify({
                run: { id: 'r1', status: 'success', stepCount: 4 },
                ok: true,
                note: 'Clean run: every step succeeded. Nothing to fix: finish with builder_finalize.',
                steps: [
                    { stepId: 'a_1f2e3d', stepType: 'integration_action', status: 'success', _hint: { outputType: 'object', topKeys: ['path', 'count', 'items'], shape: 'path: string; count: integer; items[*]: { name, path, type, size, contentType, modified, fileId }' } },
                    { stepId: 'a_4b5c6d', stepType: 'integration_action', status: 'success', _hint: { outputType: 'object', topKeys: ['iterations', 'succeeded', 'failed', 'results'], shape: 'iterations: integer; succeeded: integer; failed: integer; results[*]: { index, item: { name, path, type, size, contentType, modified, fileId }, output: { path, size, contentType, extractedVia, truncated, content, meta: { pages } }, status }' } },
                    { stepId: 'ex_7a8b9c', stepType: 'data_extraction', status: 'success', _hint: { outputType: 'object', topKeys: ['iterations', 'succeeded', 'failed', 'results', '_dryRunSynthesised', '_dryRunFallback'], shape: 'iterations: integer; succeeded: integer; failed: integer; results[*]: { index, item: { index, item: { name, path, type, size, contentType, modified, fileId }, output: { path, size, contentType, extractedVia, truncated, content, meta: { pages } }, status }, output: { datum, leverancier, factuurnummer, excl_btw, btw, totaal }, status }; _dryRunSynthesised: boolean; _dryRunFallback: string' } },
                    { stepId: 'dt_0d1e2f', stepType: 'datatable', status: 'success', _hint: { outputType: 'object', topKeys: ['iterations', 'succeeded', 'failed', 'results', '_dryRunSynthesised', '_dryRunFallback'], shape: 'iterations: integer; succeeded: integer; failed: integer; results[*]: { index, item: { index, item: { index, item: { name, path, type, size, contentType, modified, fileId }, output: { path, size, contentType, extractedVia, truncated, content, meta: { pages } }, status }, output: { datum, leverancier, factuurnummer, excl_btw, btw, totaal }, status }, output: { row: { datum, leverancier, factuurnummer, excl_btw, btw, totaal }, id, created, updated }, status }; _dryRunSynthesised: boolean; _dryRunFallback: string' } },
                ],
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_d9', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ markDone: [2] }) } },
                { id: 'ex_d10', type: 'function', function: { name: 'builder_finalize', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_d9', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Manual trigger', done: true }, { i: 1, text: 'List → read → extract → append rows to Facturen', done: true }, { i: 2, text: 'Dry-run and finalize', done: true }], next: null }) },
        { role: 'tool', tool_call_id: 'ex_d10', content: JSON.stringify({ automation: { id: 'auto_2', title: 'Invoices from /Invoices-Test into Facturen' }, ok: true }) },
        { role: 'assistant', content: 'Done — "Invoices from /Invoices-Test into Facturen" is saved and ready to activate.' },
    ];
}

module.exports = { invoiceTableExample };
