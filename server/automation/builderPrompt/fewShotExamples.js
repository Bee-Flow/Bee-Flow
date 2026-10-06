/**
 * Few-shot worked dialogues for the builder agent (§WS5, extracted verbatim
 * from builderPrompt.js).
 *
 * Every tool ECHO in the three ordered examples is byte-true to what the real
 * builders return for that call on a lean profile (`_resultDetail:'full'`:
 * `_draftSteps` + `_wiring` on every mutator) — fewShotExamples.replay.test.js
 * replays each call through applyToolCall and compares the whole VALUE (ids
 * mapped, route-added keys aside), so a hand-written summary or a shortened
 * inspect shape fails there. The dry-run echoes follow
 * compactDryRunForModel (a runner is not replayed): status is 'success' (there is
 * no 'simulated' status; a synthesised write carries `_dryRunSynthesised`),
 * and a data_extraction step's dry-run output is the runner's typed SAMPLE
 * ("Sample <name>", 123.45, "2026-01-15"), never real values — a model that
 * has seen real-looking values in the example argues with the real run. Every
 * flat step the runner synthesises (a side-effect send, an extraction, a
 * datatable write) is pinned to the byte against the runner's own synthesis
 * functions; live reads and fan-out envelopes are shape-checked.
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

/**
 * Few-shot messages prepended to the conversation when the model profile
 * asks for them (small / mid / reasoning profiles set `fewShots: 1 or 2`).
 *
 * Each example is a short [user, assistant_with_tool_calls, tool_result]
 * triplet that teaches a concrete tool-call sequence. Small models learn
 * the binding format from these much faster than from a wall of prose.
 *
 * Returns an array of OpenAI-format messages suitable for splicing into
 * the existing messages list right after the system prompt.
 *
 * The tool_call ids are sentinels (\`ex_*\`); applyToolCall is never called
 * on them — they only exist to teach the protocol.
 */
function buildFewShotMessages(count = 0, { toolset = 'full' } = {}) {
    if (count <= 0) return [];

    // Batched protocol example — FIRST for the full toolset so the count-1
    // profiles (mid, reasoning) see it: one reply carrying plan + batch-inspect +
    // trigger, then ONE builder_add_steps with tempId cross-refs, then
    // summarise + dry-run together. The 'core' toolset sees it too (since
    // 2026-09-11 CORE_TOOL_NAMES carries builder_add_steps), but LAST — see
    // the ordering note at the bottom of this function.
    // Reply 1 carries the trigger AND the name (builder_set_metadata) beside
    // the plan and the batch inspect: an automation nobody named ships as
    // "Untitled automation", and no worked example ever showed the call, so
    // the small band never made it. The last reply is builder_finalize plus
    // one sentence — the end of a build, shown once.
    const batchedExample = [
        { role: 'user', content: 'Every weekday at 8am, search my Gmail for unread invoices and email me a summary.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'ex_b1', type: 'function',
                    function: {
                        name: 'builder_set_plan',
                        arguments: JSON.stringify({ todos: [{ text: 'Schedule trigger (weekdays 8:00)' }, { text: 'Add search → summarise → send steps' }, { text: 'Dry-run and finalize' }] }),
                    },
                },
                {
                    id: 'ex_b3', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({ kind: 'schedule', cron: '0 8 * * 1-5', tz: 'Europe/Amsterdam' }),
                    },
                },
                {
                    id: 'ex_b8', type: 'function',
                    function: {
                        name: 'builder_set_metadata',
                        arguments: JSON.stringify({ title: 'Weekday invoice digest', description: 'Every weekday at 08:00 search Gmail for unread invoices and e-mail a summary.' }),
                    },
                },
                {
                    id: 'ex_b2', type: 'function',
                    function: {
                        name: 'builder_inspect_tool',
                        arguments: JSON.stringify({ tools: ['gmail_search', 'gmail_compose'] }),
                    },
                },
            ],
        },
        // The REAL echo — {ok, todos:[{i,text,done}], next}. The old {ok,count}
        // shape here taught the model that set_plan returns nothing readable,
        // which is exactly why it re-derived the plan from the user's message
        // every round (see builderModelProfiles.js).
        { role: 'tool', tool_call_id: 'ex_b1', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Schedule trigger (weekdays 8:00)', done: false }, { i: 1, text: 'Add search → summarise → send steps', done: false }, { i: 2, text: 'Dry-run and finalize', done: false }], next: 'Schedule trigger (weekdays 8:00)' }) },
        // applyTrigger returns the trigger node itself; every mutator on a
        // lean profile adds the structured digest and the wiring line.
        { role: 'tool', tool_call_id: 'ex_b3', content: JSON.stringify({ trigger: { id: 'trg', type: 'trigger', kind: 'schedule', output: {}, schedule: { cron: '0 8 * * 1-5', tz: 'Europe/Amsterdam' } }, _draftSteps: [{ id: 'trg', type: 'trigger', kind: 'schedule' }], _wiring: 'main: (no edges yet)' }) },
        { role: 'tool', tool_call_id: 'ex_b8', content: JSON.stringify({ title: 'Weekday invoice digest', description: 'Every weekday at 08:00 search Gmail for unread invoices and e-mail a summary.', _draftSteps: [{ id: 'trg', type: 'trigger', kind: 'schedule' }], _wiring: 'main: (no edges yet)' }) },
        // The batch inspect form; the `shape` strings are the real
        // describeShape() output for the two curated tools, annotations
        // included (a shortened shape here is a shape the model never sees).
        {
            role: 'tool', tool_call_id: 'ex_b2',
            content: JSON.stringify({
                results: {
                    gmail_search: { tool: 'gmail_search', inputs: { query: { type: 'string', required: true }, maxResults: { type: 'number', required: false } }, requiredInputs: ['query'], shape: 'results: array of { id, from, to, subject, date, snippet }; total: integer (estimated total result count); message: string (only present when results is empty)', source: 'curated', sample: null, iterableFields: ['results'] },
                    gmail_compose: { tool: 'gmail_compose', inputs: { to: { type: 'string', required: true }, subject: { type: 'string', required: true }, body: { type: 'string', required: true } }, requiredInputs: ['to', 'subject', 'body'], shape: 'sent: boolean; messageId: string; threadId: string; to: string; subject: string; message: string', source: 'curated', sample: null },
                },
            }),
        },
        // The ai_step reads the search results through `inputs` (a ref
        // binding), never through a {{template}} inside `prompt`: a brace
        // inside a string value is what the local runtime's tool-call parser
        // chops (core/llm/partialJsonScan.looksGarbled).
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_b4', type: 'function',
                function: {
                    name: 'builder_add_steps',
                    arguments: JSON.stringify({
                        steps: [
                            { tempId: 'search', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'label:Invoices is:unread' }, maxResults: { kind: 'literal', value: 25 } }, label: 'Find unread invoices' } },
                            { tempId: 'sum', type: 'ai_step', spec: { prompt: 'Summarise the emails in `emails` (sender, subject, amount if visible) as a short bulleted digest.', inputs: { emails: { kind: 'ref', path: 'steps.$search.output.results' } }, outputSchema: { digest: 'string' }, label: 'Summarise invoices' } },
                            { tempId: 'send', type: 'integration_action', spec: { tool: 'gmail_compose', inputs: { to: { kind: 'literal', value: 'me@example.com' }, subject: { kind: 'literal', value: 'Invoice digest' }, body: { kind: 'ref', path: 'steps.$sum.output.digest' } }, label: 'Email me the digest' } },
                        ],
                    }),
                },
            }],
        },
        {
            role: 'tool', tool_call_id: 'ex_b4',
            content: JSON.stringify({
                added: [{ tempId: 'search', id: 'a_5e1c2b', type: 'integration_action', tool: 'gmail_search' }, { tempId: 'sum', id: 'ai_9d4f7a', type: 'ai_step' }, { tempId: 'send', id: 'a_3c8e6d', type: 'integration_action', tool: 'gmail_compose' }],
                idMap: { search: 'a_5e1c2b', sum: 'ai_9d4f7a', send: 'a_3c8e6d' },
                _draftSteps: [
                    { id: 'trg', type: 'trigger', kind: 'schedule' },
                    { id: 'a_5e1c2b', type: 'integration_action', tool: 'gmail_search', label: 'Find unread invoices' },
                    { id: 'ai_9d4f7a', type: 'ai_step', label: 'Summarise invoices' },
                    { id: 'a_3c8e6d', type: 'integration_action', tool: 'gmail_compose', label: 'Email me the digest' },
                ],
                _wiring: 'main: trg→a_5e1c2b, a_5e1c2b→ai_9d4f7a, ai_9d4f7a→a_3c8e6d',
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_b5', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ markDone: [0, 1] }) } },
                { id: 'ex_b6', type: 'function', function: { name: 'builder_summarise', arguments: '{}' } },
                { id: 'ex_b7', type: 'function', function: { name: 'builder_request_dry_run', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_b5', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Schedule trigger (weekdays 8:00)', done: true }, { i: 1, text: 'Add search → summarise → send steps', done: true }, { i: 2, text: 'Dry-run and finalize', done: false }], next: 'Dry-run and finalize' }) },
        // applySummarise: {summary, hasSideEffects} — no `ok`.
        { role: 'tool', tool_call_id: 'ex_b6', content: JSON.stringify({ summary: '**Trigger:** On schedule (`0 8 * * 1-5`, Europe/Amsterdam).\n\n**Steps:**\n1. Call `gmail_search` with query="label:Invoices is:unread", maxResults=25 — Find unread invoices.\n2. Ask the AI (auto): "Summarise the emails in `emails` (sender, subject, amount if visible) as a short bulleted digest."\n3. **Call `gmail_compose` with to="me@example.com", subject="Invoice digest", body=`steps.ai_9d4f7a.output.digest` — Email me the digest.**', hasSideEffects: true }) },
        // compactDryRunForModel: the read ran live, the AI step ran live, the
        // send was synthesised (a side effect never happens in a dry run) —
        // status 'success' on all three, `_dryRunSynthesised` marks the one
        // that was not real. A synthesised send is the tool's CURATED sample
        // (outputSchemas.js — gmail_compose's sent-email shape, six keys, with
        // its own placeholder recipient and subject, not the step's inputs)
        // stamped `_dryRunSynthesised` / `_dryRunFallback: null` by runDag;
        // the replay test derives this head from those same functions.
        {
            role: 'tool', tool_call_id: 'ex_b7',
            content: JSON.stringify({
                run: { id: 'r1', status: 'success', stepCount: 3 },
                ok: true,
                note: 'Clean run: every step succeeded. Nothing to fix: finish with builder_finalize.',
                steps: [
                    { stepId: 'a_5e1c2b', stepType: 'integration_action', status: 'success', _hint: { outputType: 'object', topKeys: ['results', 'total'], shape: 'results[*]: { id, from, to, subject, date, snippet }; total: integer' } },
                    { stepId: 'ai_9d4f7a', stepType: 'ai_step', status: 'success', _hint: { outputType: 'object', topKeys: ['digest'], shape: 'digest: string' } },
                    { stepId: 'a_3c8e6d', stepType: 'integration_action', status: 'success', _hint: { outputType: 'object', topKeys: ['sent', 'messageId', 'threadId', 'to', 'subject', 'message', '_dryRunSynthesised', '_dryRunFallback'], shape: 'sent: boolean; messageId: string; threadId: string; to: string; subject: string; message: string; _dryRunSynthesised: boolean; _dryRunFallback: null' } },
                ],
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_b9', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ markDone: [2] }) } },
                { id: 'ex_b10', type: 'function', function: { name: 'builder_finalize', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_b9', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Schedule trigger (weekdays 8:00)', done: true }, { i: 1, text: 'Add search → summarise → send steps', done: true }, { i: 2, text: 'Dry-run and finalize', done: true }], next: null }) },
        { role: 'tool', tool_call_id: 'ex_b10', content: JSON.stringify({ automation: { id: 'auto_1', title: 'Weekday invoice digest' }, ok: true }) },
        { role: 'assistant', content: 'Done — "Weekday invoice digest" is saved and ready to activate.' },
    ];

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
    const invoiceTableExample = [
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
    const createTableExample = [
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

    const examples = [
        // Example 2: INSPECT-THEN-BIND. The catalog only shows an input count,
        // so the agent inspects gmail_search first to learn the exact `q` param
        // and `results` output field — then binds those exactly (no guessing).
        [
            { role: 'user', content: 'Every morning search my Gmail for unread invoices and notify me with the list.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_i0', type: 'function',
                    function: { name: 'builder_inspect_tool', arguments: JSON.stringify({ tool: 'gmail_search' }) },
                }],
            },
            {
                role: 'tool', tool_call_id: 'ex_i0',
                content: JSON.stringify({
                    tool: 'gmail_search',
                    inputs: { q: { type: 'string', required: true }, maxResults: { type: 'number', required: false } },
                    requiredInputs: ['q'],
                    shape: 'results: array of { id, from, subject, date, snippet }; total: integer',
                    iterableFields: ['results'],
                }),
            },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_i1', type: 'function',
                    function: { name: 'builder_propose_trigger', arguments: JSON.stringify({ kind: 'schedule', cron: '0 8 * * *', tz: 'Europe/Amsterdam' }) },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_i1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_i2', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            tool: 'gmail_search',
                            inputs: { q: { kind: 'literal', value: 'label:invoices is:unread' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_i2', content: JSON.stringify({ ok: true, stepId: 's_search' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_i3', type: 'function',
                    function: {
                        name: 'builder_add_notification',
                        arguments: JSON.stringify({
                            afterStepId: 's_search',
                            title: 'Unread invoices',
                            body: '{{steps.s_search.output.results}}',
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_i3', content: JSON.stringify({ ok: true, stepId: 's_notif' }) },
        ],
        // Example 3: UPDATE-IN-PLACE. Build an ai_step, then EDIT it with
        // builder_update_step (keeps the id + wiring) — never delete + re-add.
        [
            { role: 'user', content: 'Draft a reply to incoming support emails — then make it use the thinking model and reply in Dutch.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_e1', type: 'function',
                    function: { name: 'builder_propose_trigger', arguments: JSON.stringify({ kind: 'app_event', appProvider: 'gmail', appEvent: 'mail.new' }) },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_e1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_e2', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            prompt: 'Draft a short, friendly reply. Respond with JSON {"replyText":"..."}.',
                            outputSchema: { replyText: 'string' },
                            inputs: { snippet: { kind: 'ref', path: 'trigger.output.snippet' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_e2', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_e3', type: 'function',
                    function: {
                        name: 'builder_update_step',
                        arguments: JSON.stringify({
                            stepId: 's_ai',
                            patch: { modelTier: 'thinking', systemPrompt: 'You are a courteous support agent. Always reply in Dutch.' },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_e3', content: JSON.stringify({ updated: { id: 's_ai', type: 'ai_step' } }) },
        ],
        // Example 4: an app_event trigger (Gmail) + reply via ai_step + compose.
        // Demonstrates template bindings and replyToMessageId.
        [
            { role: 'user', content: 'When an email comes from boss@example.com, draft a polite acknowledgement and reply.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_u1', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({
                            kind: 'app_event',
                            appProvider: 'gmail',
                            appEvent: 'mail.new',
                            filter: { from: 'boss@example.com', excludeFromSelf: true },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_u1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_u2', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            systemPrompt: 'You are a courteous customer-support assistant. Keep replies warm, concise, and professional.',
                            prompt: 'Draft a polite acknowledgement to this email. Respond with JSON {"replyText":"..."}.',
                            outputSchema: { replyText: 'string' },
                            inputs: {
                                from: { kind: 'ref', path: 'trigger.output.from' },
                                subject: { kind: 'ref', path: 'trigger.output.subject' },
                                snippet: { kind: 'ref', path: 'trigger.output.snippet' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_u2', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_u3', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_ai',
                            tool: 'gmail_compose',
                            inputs: {
                                replyToMessageId: { kind: 'ref', path: 'trigger.output.messageId' },
                                body: { kind: 'ref', path: 'steps.s_ai.output.replyText' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_u3', content: JSON.stringify({ ok: true, stepId: 's_send' }) },
        ],
        // Example 5 (Nextcloud): file.new (poller-backed) → read the file →
        // AI summarise → post to a Talk room. Teaches the NC binding shapes
        // (trigger.output.path, nextcloud_read_file.content) and that
        // nextcloud_talk_send_message needs a `token` (the Talk room token).
        [
            { role: 'user', content: 'When a PDF lands in my Nextcloud Documents folder, summarise it and post the summary to my Talk room.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_n1', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({
                            kind: 'app_event',
                            appProvider: 'nextcloud',
                            appEvent: 'file.new',
                            filter: { inFolder: '/Documents/', extension: 'pdf' },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_n1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_n2', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            tool: 'nextcloud_read_file',
                            inputs: { path: { kind: 'ref', path: 'trigger.output.path' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_n2', content: JSON.stringify({ ok: true, stepId: 's_read' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_n3', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            afterStepId: 's_read',
                            prompt: 'Summarise this document in 3 sentences. Respond with JSON {"summary":"..."}.',
                            outputSchema: { summary: 'string' },
                            inputs: { text: { kind: 'ref', path: 'steps.s_read.output.content' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_n3', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_n4', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_ai',
                            tool: 'nextcloud_talk_send_message',
                            inputs: {
                                // `token` is the Talk room token — ask the user for it
                                // (this placeholder must be replaced before activating).
                                token: { kind: 'literal', value: '<your-talk-room-token>' },
                                message: { kind: 'ref', path: 'steps.s_ai.output.summary' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_n4', content: JSON.stringify({ ok: true, stepId: 's_post' }) },
        ],
        // Example 6: mail attachment → Google Drive via sourceHandle (no base64
        // through the AI context). Demonstrates filter.hasAttachment, the
        // attachments[] payload, the sourceHandle pattern, and chained
        // drive_create_folder for the invoices/year/month/supplier path.
        [
            { role: 'user', content: 'When an invoice email comes in, file the PDF in Google Drive under invoices/year/month/supplier.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v1', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({
                            kind: 'app_event',
                            appProvider: 'gmail',
                            appEvent: 'mail.new',
                            filter: { hasAttachment: true },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v2', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            tool: 'gmail_read_attachment',
                            inputs: {
                                messageId: { kind: 'ref', path: 'trigger.output.messageId' },
                                attachmentId: { kind: 'ref', path: 'trigger.output.attachments[0].attachmentId' },
                                filename: { kind: 'ref', path: 'trigger.output.attachments[0].filename' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v2', content: JSON.stringify({ ok: true, stepId: 's_read' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v3', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            afterStepId: 's_read',
                            prompt: 'Determine if this text is an invoice. If yes, extract supplier, year (YYYY) and month (MM). Respond with JSON.',
                            outputSchema: { isInvoice: 'boolean', supplier: 'string', year: 'string', month: 'string' },
                            inputs: { text: { kind: 'ref', path: 'steps.s_read.output.content' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v3', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v4', type: 'function',
                    function: {
                        name: 'builder_add_condition',
                        arguments: JSON.stringify({
                            afterStepId: 's_ai',
                            expr: 'steps.s_ai.output.isInvoice === true',
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v4', content: JSON.stringify({ ok: true, stepId: 's_if' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v5', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_if',
                            tool: 'drive_create_folder',
                            inputs: { name: { kind: 'ref', path: 'steps.s_ai.output.year' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v5', content: JSON.stringify({ ok: true, stepId: 's_year' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v6', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_year',
                            tool: 'drive_create_folder',
                            inputs: {
                                name: { kind: 'ref', path: 'steps.s_ai.output.month' },
                                parentFolderId: { kind: 'ref', path: 'steps.s_year.output.folderId' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v6', content: JSON.stringify({ ok: true, stepId: 's_month' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v7', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_month',
                            tool: 'drive_create_folder',
                            inputs: {
                                name: { kind: 'ref', path: 'steps.s_ai.output.supplier' },
                                parentFolderId: { kind: 'ref', path: 'steps.s_month.output.folderId' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v7', content: JSON.stringify({ ok: true, stepId: 's_supp' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v8', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_supp',
                            tool: 'drive_upload_file',
                            inputs: {
                                name: { kind: 'ref', path: 'trigger.output.attachments[0].filename' },
                                parentFolderId: { kind: 'ref', path: 'steps.s_supp.output.folderId' },
                                sourceHandle: { kind: 'ref', path: 'steps.s_read.output.sourceHandle' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v8', content: JSON.stringify({ ok: true, stepId: 's_up' }) },
        ],
    ];

    // The full-menu bands lead with the batched example: the count-1 profiles
    // (mid, reasoning — toolset 'full') see it alone, and a worked example of
    // ONE builder_add_steps call is the strongest signal a model gets that it
    // need not spend a round per step. The fan-out sits second and the
    // create-table repair third for a profile that asks for more; the serial
    // examples after them still demonstrate the full-menu tools.
    //
    // The 'core' toolset (small band, fewShots: 3) sees the same three shots
    // in a different order: invoice fan-out, create-table repair, Gmail digest
    // LAST. The digest teaches nothing the fan-out does not (plan + inspect +
    // trigger + name in reply 1, one batch with tempId refs, summarise +
    // dry-run, finalize) — the fan-out adds the chained forEach, the
    // extraction and the datatable write, and the Dutch shot adds
    // builder_create_datatable and the dry-run repair. So a `fewShots: 2`
    // override in builder_model_profiles (the one knob that needs no code
    // change) drops the shot the small band can spare, never the Dutch one.
    // 'core' used to get the serial examples because its menu lacked
    // builder_add_steps; since 2026-09-11 CORE_TOOL_NAMES carries the batch
    // tools.
    const ordered = toolset === 'core'
        ? [invoiceTableExample, createTableExample, batchedExample, ...examples]
        : [batchedExample, invoiceTableExample, createTableExample, ...examples];
    return ordered.slice(0, count).flat();
}

module.exports = { buildFewShotMessages };
