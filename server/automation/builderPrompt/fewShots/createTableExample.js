// @typecheck
'use strict';
/**
 * Create-table + repair + finalize (Dutch).
 *
 * One of the builder agent's few-shot dialogues, assembled by
 * ../fewShotExamples.js (which documents the echo contract every tool
 * result here follows and the order the profiles see them in). A factory
 * rather than a constant: each call returns fresh message objects, so a
 * caller that edits a message cannot change the next conversation's copy.
 */

// The refusal the create-table example records (builder_add_steps, ex_c5):
// the real builders' answer to a write that binds the extraction field
// `total` where the extraction declares `totaal` — verbatim, ids mapped.
const EX_C5_REFUSAL = {
    error: 'steps[1] ($save): datatable values — values.totaal: "steps.ex_71a76c.output.total" does not resolve: steps.ex_71a76c.output has no "total". Did you mean steps.ex_71a76c.output.totaal? steps.ex_71a76c.output has: leverancier, factuurnummer, totaal.',
    failedIndex: 1,
    added: [{ tempId: 'extract', id: 'ex_71a76c', type: 'data_extraction' }],
    resendFrom: 1,
    lastAppliedId: 'ex_71a76c',
    idMap: { extract: 'ex_71a76c' },
    resendAs: {
        tool: 'builder_add_steps',
        args: {
            steps: [{
                tempId: 'save', type: 'datatable',
                spec: {
                    op: 'add_row', datatableId: 'tbl_7c2d9e', datatableKey: 'inkomende_facturen',
                    values: {
                        leverancier: { kind: 'ref', path: 'steps.ex_71a76c.output.leverancier' },
                        factuurnummer: { kind: 'ref', path: 'steps.ex_71a76c.output.factuurnummer' },
                        totaal: { kind: 'ref', path: 'steps.ex_71a76c.output.total' },
                    },
                    label: 'Rij toevoegen',
                    afterStepId: 'ex_71a76c',
                },
            }],
        },
    },
    _fixHint: "Reject reason: entry 1 was refused — see the error. Entries 0..0 are built (ids ex_71a76c) and stay built. Fix entry 1 and resend ONLY entries 1.. — steps.$<tempId> of the built entries still resolves, and the first resent entry chains after \"ex_71a76c\" unless you set afterStepId. Resending the built entries again is harmless (they are not added twice).",
    _draftSteps: [
        { id: 'trg', type: 'trigger', kind: 'form' },
        { id: 'ex_71a76c', type: 'data_extraction', label: 'Factuurvelden uitlezen', fields: ['leverancier', 'factuurnummer', 'totaal'] },
    ],
    _wiring: 'main: trg→ex_71a76c',
};

// Create-table + repair + finalize — Dutch, on the shape the playbook's
// automation phase and the live briefs use (form → data_extraction → new
// datatable → add_row). Three things nothing else showed the small band:
//   · builder_create_datatable at DESIGN time, then add_row with the id
//     and key it RETURNED (the echo carries them and the column keys);
//   · reading a refusal as the answer: the write bound
//     `steps.<ex>.output.total`, the binding check knows the extraction
//     declares `totaal` and says "Did you mean …totaal?", entry 0 stays
//     built, and the fix is to resend ONLY the refused entry, corrected
//     (resendAs) — before 2026-10 this mistake surfaced only as a missing
//     column in the dry run;
//   · a dry run of a form trigger has no submission, so the extraction
//     returns the runner's typed samples; that is enough to prove the
//     wiring and it is what the model will see live.
// `tbl_7c2d9e` / `inkomende_facturen` stand for what the create call
// returns; the key is what keyFromTitle derives from the name.
function createTableExample() {
    return [
        { role: 'user', content: "Formulier: iemand plakt een factuurtekst. Haal leverancier, factuurnummer en totaal eruit en zet ze in een nieuwe tabel 'Inkomende facturen'." },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_c1', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ todos: [{ text: 'Formulier-trigger + tabel Inkomende facturen' }, { text: 'Extractie → rij toevoegen' }, { text: 'Testrun en afronden' }] }) } },
                { id: 'ex_c2', type: 'function', function: { name: 'builder_propose_trigger', arguments: JSON.stringify({ kind: 'form', form: { title: 'Factuur invoeren', fields: [{ name: 'tekst', type: 'textarea', label: 'Factuurtekst', required: true }] } }) } },
                { id: 'ex_c3', type: 'function', function: { name: 'builder_set_metadata', arguments: JSON.stringify({ title: 'Factuurformulier naar tabel Inkomende facturen', description: 'Leest leverancier, factuurnummer en totaal uit een geplakte factuurtekst en voegt een rij toe aan Inkomende facturen.' }) } },
                { id: 'ex_c4', type: 'function', function: { name: 'builder_create_datatable', arguments: JSON.stringify({ name: 'Inkomende facturen', fields: [{ name: 'Leverancier', type: 'text' }, { name: 'Factuurnummer', type: 'text' }, { name: 'Totaal', type: 'number' }] }) } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_c1', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Formulier-trigger + tabel Inkomende facturen', done: false }, { i: 1, text: 'Extractie → rij toevoegen', done: false }, { i: 2, text: 'Testrun en afronden', done: false }], next: 'Formulier-trigger + tabel Inkomende facturen' }) },
        { role: 'tool', tool_call_id: 'ex_c2', content: JSON.stringify({ trigger: { id: 'trg', type: 'trigger', kind: 'form', output: {}, form: { title: 'Factuur invoeren', fields: [{ name: 'tekst', type: 'textarea', label: 'Factuurtekst', required: true }] } }, _draftSteps: [{ id: 'trg', type: 'trigger', kind: 'form' }], _wiring: 'main: (no edges yet)' }) },
        { role: 'tool', tool_call_id: 'ex_c3', content: JSON.stringify({ title: 'Factuurformulier naar tabel Inkomende facturen', description: 'Leest leverancier, factuurnummer en totaal uit een geplakte factuurtekst en voegt een rij toe aan Inkomende facturen.', _draftSteps: [{ id: 'trg', type: 'trigger', kind: 'form' }], _wiring: 'main: (no edges yet)' }) },
        // applyCreateDatatable (datatableCreate.js): the id, the key, the
        // column keys and the `_next` line naming the exact write call.
        { role: 'tool', tool_call_id: 'ex_c4', content: JSON.stringify({ datatableId: 'tbl_7c2d9e', datatableKey: 'inkomende_facturen', name: 'Inkomende facturen', fields: [{ key: 'leverancier', type: 'text' }, { key: 'factuurnummer', type: 'text' }, { key: 'totaal', type: 'number' }], created: true, _next: 'Write into it with builder_add_datatable {op:"add_row", datatableId:"tbl_7c2d9e", datatableKey:"inkomende_facturen", values:{<columnKey>: <binding>}} — keys: leverancier, factuurnummer, totaal. The table is empty; the automation fills it.' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_c5', type: 'function',
                function: {
                    name: 'builder_add_steps',
                    arguments: JSON.stringify({
                        steps: [
                            { tempId: 'extract', type: 'data_extraction', spec: { source: { kind: 'ref', path: 'trigger.output.tekst' }, fields: [{ name: 'leverancier', type: 'string', description: 'Naam van de leverancier' }, { name: 'factuurnummer', type: 'string', description: 'Factuurnummer', required: true }, { name: 'totaal', type: 'number', description: 'Totaalbedrag inclusief btw' }], label: 'Factuurvelden uitlezen' } },
                            { tempId: 'save', type: 'datatable', spec: { op: 'add_row', datatableId: 'tbl_7c2d9e', datatableKey: 'inkomende_facturen', values: { leverancier: { kind: 'ref', path: 'steps.$extract.output.leverancier' }, factuurnummer: { kind: 'ref', path: 'steps.$extract.output.factuurnummer' }, totaal: { kind: 'ref', path: 'steps.$extract.output.total' } }, label: 'Rij toevoegen' } },
                        ],
                    }),
                },
            }],
        },
        // The binding check knows the extraction's output (its fields ARE the
        // shape), so `output.total` is refused on the spot with the field
        // that does exist; entry 0 stays built and `resendAs` is the call
        // that continues.
        {
            role: 'tool', tool_call_id: 'ex_c5',
            content: JSON.stringify(EX_C5_REFUSAL),
        },
        {
            role: 'assistant',
            content: 'Het extractieveld heet `totaal`, niet `total` — alleen de rij-stap opnieuw.',
            tool_calls: [{
                id: 'ex_c5b', type: 'function',
                function: {
                    name: 'builder_add_steps',
                    arguments: JSON.stringify({
                        steps: [
                            { tempId: 'save', type: 'datatable', spec: { op: 'add_row', datatableId: 'tbl_7c2d9e', datatableKey: 'inkomende_facturen', values: { leverancier: { kind: 'ref', path: 'steps.ex_71a76c.output.leverancier' }, factuurnummer: { kind: 'ref', path: 'steps.ex_71a76c.output.factuurnummer' }, totaal: { kind: 'ref', path: 'steps.ex_71a76c.output.totaal' } }, label: 'Rij toevoegen', afterStepId: 'ex_71a76c' } },
                        ],
                    }),
                },
            }],
        },
        {
            role: 'tool', tool_call_id: 'ex_c5b',
            content: JSON.stringify({
                added: [{ tempId: 'save', id: 'dt_b5b5c4', type: 'datatable' }],
                idMap: { extract: 'ex_71a76c', save: 'dt_b5b5c4' },
                _draftSteps: [
                    { id: 'trg', type: 'trigger', kind: 'form' },
                    { id: 'ex_71a76c', type: 'data_extraction', label: 'Factuurvelden uitlezen', fields: ['leverancier', 'factuurnummer', 'totaal'] },
                    { id: 'dt_b5b5c4', type: 'datatable', label: 'Rij toevoegen', op: 'add_row', table: 'inkomende_facturen (tbl_7c2d9e)', values: ['leverancier', 'factuurnummer', 'totaal'] },
                ],
                _wiring: 'main: trg→ex_71a76c, ex_71a76c→dt_b5b5c4',
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_c6', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ markDone: [0, 1] }) } },
                { id: 'ex_c7', type: 'function', function: { name: 'builder_summarise', arguments: '{}' } },
                { id: 'ex_c8', type: 'function', function: { name: 'builder_request_dry_run', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_c6', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Formulier-trigger + tabel Inkomende facturen', done: true }, { i: 1, text: 'Extractie → rij toevoegen', done: true }, { i: 2, text: 'Testrun en afronden', done: false }], next: 'Testrun en afronden' }) },
        { role: 'tool', tool_call_id: 'ex_c7', content: JSON.stringify({ summary: '**Trigger:** On trigger (form).\n\n**Steps:**\n1. Extract 3 field(s) (leverancier, factuurnummer, totaal) from `trigger.output.tekst` — Factuurvelden uitlezen.\n2. Add a row to "Rij toevoegen".', hasSideEffects: true }) },
        // A dry run of a form trigger has no submission: the extraction
        // returns the runner's typed samples, and the previewed row shows all
        // three columns in its _hint shape — the dry-run echo carries shapes,
        // never payloads (compactDryRunForModel, 2026-09-18).
        {
            role: 'tool', tool_call_id: 'ex_c8',
            content: JSON.stringify({
                run: { id: 'r2', status: 'success', stepCount: 2 },
                ok: true,
                note: 'Clean run: every step succeeded. Nothing to fix: finish with builder_finalize.',
                steps: [
                    { stepId: 'ex_71a76c', stepType: 'data_extraction', status: 'success', _hint: { outputType: 'object', topKeys: ['leverancier', 'factuurnummer', 'totaal', '_dryRunSynthesised', '_dryRunFallback'], shape: 'leverancier: string; factuurnummer: string; totaal: number; _dryRunSynthesised: boolean; _dryRunFallback: null' } },
                    { stepId: 'dt_b5b5c4', stepType: 'datatable', status: 'success', _hint: { outputType: 'object', topKeys: ['row', 'id', 'created', 'updated', '_dryRunSynthesised'], shape: 'row: { leverancier, factuurnummer, totaal }; id: null; created: boolean; updated: integer; _dryRunSynthesised: boolean' } },
                ],
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_c11', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ markDone: [2] }) } },
                { id: 'ex_c12', type: 'function', function: { name: 'builder_finalize', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_c11', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Formulier-trigger + tabel Inkomende facturen', done: true }, { i: 1, text: 'Extractie → rij toevoegen', done: true }, { i: 2, text: 'Testrun en afronden', done: true }], next: null }) },
        { role: 'tool', tool_call_id: 'ex_c12', content: JSON.stringify({ automation: { id: 'auto_3', title: 'Factuurformulier naar tabel Inkomende facturen' }, ok: true }) },
        { role: 'assistant', content: 'Klaar — "Factuurformulier naar tabel Inkomende facturen" staat klaar om te activeren.' },
    ];
}

module.exports = { createTableExample };
