/**
 * App Studio builder — few-shot worked dialogue.
 *
 * ONE compact example teaching the whole protocol on a small lookup app
 * (derived from templates.js "Lookup console"): set meta → pick an identity
 * (app_set_theme: a preset that fits the job + one knob on top, per the
 * design doctrine) → add a screen → create the action FIRST → one batched
 * app_add_components call (nested form via children, tempId capture) →
 * app_bind_action → app_finalize.
 *
 * The tool_call ids are sentinels (`ex_*`); applyToolCall never runs on
 * them — they exist purely to teach the call shapes. Mirrors
 * automation/builderPrompt/fewShotExamples.js.
 *
 * WHY THERE IS NO KEYPAD/INSTRUMENT SHOT HERE (measured, 2026-08)
 * The builder's "a calculator is a form" failure was a genuine gap, and a
 * worked keypad example was the obvious fix. The profile table says otherwise:
 *   frontier  fewShots 0  ← the profile that shipped the broken calculator
 *   mid       fewShots 1  } shot 1 only (the lookup console below)
 *   reasoning fewShots 1  }
 *   small     fewShots 3  ← the ONLY profile that would ever see a third shot,
 *                           and its 'core' menu has no app_set_variables, so it
 *                           cannot declare the variables an instrument runs on
 * A keypad shot would therefore cost ~2.4k chars of history to reach exactly
 * the one profile that cannot follow it, and reach the failing profile never.
 * The idiom lives in the system prompt instead (## App shapes), which every
 * profile reads on every turn. Revisit this if frontier's fewShots ever goes
 * above 0 — the shot is worth writing then, not now.
 */

'use strict';

/**
 * Returns OpenAI-format messages to splice in right after the system prompt.
 * On the small profile they ride EVERY turn (a cached block); elsewhere only a
 * fresh session — history replaces them once the user is chatting.
 *
 * Shot order per toolset:
 *   core  → FORM_SAVE, LINKED         (SPLIT_VIEW calls app_add_section, which
 *                                      the core menu does not have — a shot that
 *                                      teaches a call the menu cannot make; LOOKUP
 *                                      taught run_automation's inputMapping, which
 *                                      the small model misapplied to create_record)
 *   full  → LOOKUP, SPLIT_VIEW, LINKED
 * `count` caps how many of that list go out.
 */
function buildFewShotMessages(count = 0, { toolset = 'full' } = {}) {
    if (count <= 0) return [];
    const shots = toolset === 'core'
        ? [FORM_SAVE_SHOT, LINKED_TABLE_SHOT]
        : [LOOKUP_SHOT, SPLIT_VIEW_SHOT, LINKED_TABLE_SHOT];
    return shots.slice(0, Math.max(0, count)).flat();
}

// The original shot: a search form wired to a AUTOMATION (run_automation with
// inputMapping). Full toolset only since 2026-09-13 — on the core menu it was
// the sole form→action precedent, and the small model carried its
// `inputMapping` / {kind:"field"} / onError vocabulary straight into a
// create_record action four times in one turn. FORM_SAVE teaches that shape.
const LOOKUP_SHOT = [
        { role: 'user', content: 'Build a lookup console: a search form that runs my "Find customer" automation and shows the matches in a table with a count.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'ex_a1', type: 'function',
                    function: {
                        name: 'app_set_meta',
                        arguments: JSON.stringify({ name: 'Lookup console', description: 'Search customer records via an automation.', icon: 'Search' }),
                    },
                },
                {
                    // The identity pick, before any component exists (design
                    // doctrine): the preset that fits the job — a lookup
                    // console is a dense expert tool — plus ONE knob on top.
                    id: 'ex_a2', type: 'function',
                    function: {
                        name: 'app_set_theme',
                        arguments: JSON.stringify({ preset: 'mono', font: 'geist' }),
                    },
                },
                {
                    id: 'ex_a3', type: 'function',
                    function: {
                        name: 'app_add_screen',
                        arguments: JSON.stringify({ name: 'Search', icon: 'Search', maxWidth: 'medium' }),
                    },
                },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_a1', content: JSON.stringify({ meta: { name: 'Lookup console', description: 'Search customer records via an automation.', icon: 'Search' } }) },
        {
            // Byte-true to applySetTheme({preset:'mono',font:'geist'}): mono's
            // navStyle is "tabs", the default, which canonicalize prunes — so
            // the real result carries NO nav key (nav only appears for a
            // non-default style or nav groups).
            role: 'tool', tool_call_id: 'ex_a2',
            content: JSON.stringify({
                theme: { primary: '#334155', radius: 'sm', density: 'compact', fontScale: 'sm', appearance: 'auto' },
                design: { preset: 'mono', font: 'geist', surface: 'flat', motion: 'none', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
            }),
        },
        { role: 'tool', tool_call_id: 'ex_a3', content: JSON.stringify({ screenId: 'scr_look01', sectionId: 'sec_look01' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_a4', type: 'function',
                function: {
                    name: 'app_set_action',
                    arguments: JSON.stringify({
                        action: {
                            kind: 'run_automation',
                            automationId: 'auto-find-customer',
                            inputMapping: { query: { kind: 'field', name: 'query' } },
                            onError: { toast: { message: 'Search failed — try again.', tone: 'danger' } },
                        },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_a4', content: JSON.stringify({ actionId: 'act_look01', created: true }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_a5', type: 'function',
                function: {
                    name: 'app_add_components',
                    arguments: JSON.stringify({
                        parentId: 'sec_look01',
                        components: [
                            { type: 'heading', props: { text: 'Lookup', level: 1 }, style: { span: 12 } },
                            {
                                tempId: 'frm', type: 'form',
                                props: { name: 'search', submitLabel: 'Search' },
                                style: { span: 12 },
                                children: [
                                    { type: 'input_text', props: { name: 'query', label: 'Name or email', placeholder: 'e.g. jane@acme.com', required: true }, style: { span: 8 } },
                                ],
                            },
                            { type: 'stat', props: { label: 'Matches', value: { kind: 'actionResult', actionId: 'act_look01', path: 'count' }, icon: 'Hash' }, style: { span: 3 } },
                            {
                                type: 'table',
                                props: {
                                    source: { kind: 'actionResult', actionId: 'act_look01', path: 'rows' },
                                    columns: [
                                        { key: 'name', label: 'Name', format: 'text' },
                                        { key: 'email', label: 'Email', format: 'text' },
                                        { key: 'status', label: 'Status', format: 'badge' },
                                    ],
                                    emptyText: 'Run a search to see results.',
                                },
                                style: { span: 12 },
                            },
                        ],
                    }),
                },
            }],
        },
        {
            role: 'tool', tool_call_id: 'ex_a5',
            content: JSON.stringify({
                added: [
                    { id: 'cmp_lkhd01', type: 'heading' },
                    { tempId: 'frm', id: 'cmp_lkfrm1', type: 'form' },
                    { id: 'cmp_lkqry1', type: 'input_text' },
                    { id: 'cmp_lkcnt1', type: 'stat' },
                    { id: 'cmp_lktbl1', type: 'table' },
                ],
                ids: { frm: 'cmp_lkfrm1' },
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'ex_a6', type: 'function',
                    function: {
                        name: 'app_bind_action',
                        arguments: JSON.stringify({ nodeId: 'cmp_lkfrm1', event: 'onSubmit', actionId: 'act_look01' }),
                    },
                },
                {
                    id: 'ex_a7', type: 'function',
                    function: { name: 'app_finalize', arguments: '{}' },
                },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_a6', content: JSON.stringify({ nodeId: 'cmp_lkfrm1', event: 'onSubmit', actionId: 'act_look01' }) },
        { role: 'tool', tool_call_id: 'ex_a7', content: JSON.stringify({ finalized: true, appId: 'app-ex1', version: 5, name: 'Lookup console' }) },
        {
            role: 'assistant',
            content: 'Done — your Lookup console is ready. The Search screen has a query form wired to your "Find customer" automation; matches land in the table with a live count above it. Open the app and try a search.',
        },
];

const SPLIT_VIEW_SHOT = [
    { role: 'user', content: 'Now a screen with the list of tickets on the left and the selected one on the right, plus a tile showing how many are open.' },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            {
                id: 'ex_b1', type: 'function',
                function: {
                    name: 'app_add_screen',
                    arguments: JSON.stringify({ name: 'Inbox', icon: 'Inbox', maxWidth: 'full', refreshInterval: 30 }),
                },
            },
        ],
    },
    { role: 'tool', tool_call_id: 'ex_b1', content: JSON.stringify({ screenId: 'scr_inb01', sectionId: 'sec_inb00' }) },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            {
                id: 'ex_b2', type: 'function',
                function: {
                    // height 'fill' on the section is what lets the two panes
                    // scroll independently instead of growing the page.
                    name: 'app_add_section',
                    arguments: JSON.stringify({ screenId: 'scr_inb01', style: { height: 'fill', padding: 0, gap: 0 } }),
                },
            },
        ],
    },
    { role: 'tool', tool_call_id: 'ex_b2', content: JSON.stringify({ sectionId: 'sec_inb01' }) },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            {
                id: 'ex_b3', type: 'function',
                function: {
                    name: 'app_add_components',
                    arguments: JSON.stringify({
                        parentId: 'sec_inb01',
                        components: [
                            {
                                tempId: 'side', type: 'pane',
                                props: { direction: 'vertical', scroll: 'auto' },
                                style: { span: 4, height: 'fill', padding: 3 },
                                children: [
                                    {
                                        type: 'stat',
                                        props: {
                                            label: 'Open',
                                            value: {
                                                kind: 'aggregate', tableId: 'tbl_tickets',
                                                filter: [{ field: 'status', op: 'eq', value: 'open' }],
                                                aggregates: [{ fn: 'count', as: 'count' }],
                                                pick: { row: 'first', column: 'count' },
                                            },
                                        },
                                        style: { span: 12 },
                                    },
                                    {
                                        tempId: 'list', type: 'list',
                                        props: { source: { kind: 'records', tableId: 'tbl_tickets' }, titleKey: 'subject' },
                                        style: { span: 12, height: 'fill' },
                                    },
                                ],
                            },
                            {
                                type: 'pane',
                                props: { direction: 'vertical', scroll: 'auto' },
                                style: { span: 8, height: 'fill', padding: 3 },
                                children: [
                                    {
                                        type: 'record_detail',
                                        props: {
                                            source: {
                                                kind: 'record', tableId: 'tbl_tickets',
                                                filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.selected' } }],
                                            },
                                        },
                                        style: { span: 12, height: 'fill' },
                                    },
                                ],
                            },
                        ],
                    }),
                },
            },
        ],
    },
    {
        role: 'tool',
        tool_call_id: 'ex_b3',
        content: JSON.stringify({ added: [{ tempId: 'side', id: 'cmp_side01', type: 'pane' }, { tempId: 'list', id: 'cmp_list01', type: 'list' }], ids: { side: 'cmp_side01', list: 'cmp_list01' } }),
    },
    {
        role: 'assistant',
        content: 'The Inbox screen is a full-height split: the ticket list scrolls on the left, the selected ticket fills the right, and the tile counts open tickets. Clicking a row still needs an action that sets vars.selected — say the word and I will add it.',
    },
];

// ── LINKED_TABLE_SHOT ──────────────────────────────────────────────────────
// The demo's own shape on a generic table, so it does not read as canned: a
// Studio table that already exists ("Orders", filled elsewhere) is LINKED by
// name — the result carries the tbl_ id and the exact field keys — then ONE
// batched add binds a header, a total, a count, a chart per month, a filter
// bar and a grid to it. app_set_plan rides the first build call (the bundle
// rule) and markDone the last. Every tool result is byte-true to the real
// tools (fewShots.test.js runs the arguments through them).
// A form that SAVES rows into the app's own table — the shape the 2026-09-13
// trace never saw taught: create the table first (the result's tbl_ id and
// field keys are the only ids that exist), the form's inputs by props.name, a
// SEQUENCE action whose create_record reads them as form.<name>, refresh the
// table, wire the form's onSubmit. Every tool result below is byte-true to the
// real builders for these arguments (ids are sentinels).
const FORM_SAVE_SHOT = [
    { role: 'user', content: 'Make me a small contact book: a form to add a contact (name, email, company) and a table of everyone saved.' },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            {
                id: 'ex_d1', type: 'function',
                function: {
                    name: 'app_set_plan',
                    arguments: JSON.stringify({ todos: [{ text: 'Name the app and pick a look' }, { text: 'Create the Contacts table' }, { text: 'Contacts screen with the add form and the table' }, { text: 'Save action wired to the form' }, { text: 'Finalize' }] }),
                },
            },
            {
                id: 'ex_d2', type: 'function',
                function: { name: 'app_set_meta', arguments: JSON.stringify({ name: 'Contact book', description: 'Add and browse contacts.', icon: 'Users' }) },
            },
            {
                id: 'ex_d3', type: 'function',
                function: { name: 'app_set_theme', arguments: JSON.stringify({ preset: 'paper' }) },
            },
            {
                // The table FIRST: everything after this binds to the tbl_ id and
                // field keys the result returns. One call per table.
                id: 'ex_d4', type: 'function',
                function: {
                    name: 'app_upsert_table',
                    arguments: JSON.stringify({
                        name: 'Contacts',
                        fields: [
                            { key: 'name', name: 'Name', type: 'text', required: true },
                            { key: 'email', name: 'Email', type: 'text' },
                            { key: 'company', name: 'Company', type: 'text' },
                        ],
                    }),
                },
            },
        ],
    },
    { role: 'tool', tool_call_id: 'ex_d1', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Name the app and pick a look', done: false }, { i: 1, text: 'Create the Contacts table', done: false }, { i: 2, text: 'Contacts screen with the add form and the table', done: false }, { i: 3, text: 'Save action wired to the form', done: false }, { i: 4, text: 'Finalize', done: false }], next: 'Name the app and pick a look' }) },
    { role: 'tool', tool_call_id: 'ex_d2', content: JSON.stringify({ meta: { name: 'Contact book', description: 'Add and browse contacts.', icon: 'Users' } }) },
    {
        // Byte-true to applySetTheme({preset:'paper'}): paper's navStyle is the
        // default "tabs", pruned by canonicalize — no nav key.
        role: 'tool', tool_call_id: 'ex_d3',
        content: JSON.stringify({
            theme: { primary: '#B45309', radius: 'sm', density: 'comfortable', fontScale: 'md', appearance: 'light' },
            design: { preset: 'paper', font: 'cabinet', surface: 'hairline', motion: 'subtle', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
        }),
    },
    {
        // Byte-true to applyUpsertTable: the key derived from the name, the
        // three fields with their fld_ ids, the migration summary (80 chars).
        role: 'tool', tool_call_id: 'ex_d4',
        content: JSON.stringify({
            tableId: 'tbl_cont01', key: 'contacts',
            fields: [{ fieldId: 'fld_cn0001', key: 'name', type: 'text' }, { fieldId: 'fld_cn0002', key: 'email', type: 'text' }, { fieldId: 'fld_cn0003', key: 'company', type: 'text' }],
            modelVersion: 1,
            migration: 'CREATE TABLE IF NOT EXISTS "contacts" ( id TEXT PRIMARY KEY, created_at TEXT, up',
            rowCount: 0,
            _hints: ['key derived from name: "Contacts" → contacts.'],
        }),
    },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            {
                id: 'ex_d5', type: 'function',
                function: {
                    name: 'app_seed_records',
                    arguments: JSON.stringify({ tableId: 'tbl_cont01', records: [{ name: 'Mara Visser', email: 'mara@lumen.nl', company: 'Lumen' }, { name: 'Tomás Ruiz', email: 'tomas@orbita.es', company: 'Orbita' }, { name: 'Anneke Bos', email: 'anneke@bos-advies.nl', company: 'Bos Advies' }] }),
                },
            },
            {
                id: 'ex_d6', type: 'function',
                function: { name: 'app_add_screen', arguments: JSON.stringify({ name: 'Contacts', icon: 'Users' }) },
            },
        ],
    },
    { role: 'tool', tool_call_id: 'ex_d5', content: JSON.stringify({ inserted: 3, ids: ['rec_ct0001', 'rec_ct0002', 'rec_ct0003'], tableId: 'tbl_cont01', rowCount: 3 }) },
    { role: 'tool', tool_call_id: 'ex_d6', content: JSON.stringify({ screenId: 'scr_cont01', sectionId: 'sec_cont01' }) },
    {
        role: 'assistant',
        content: '',
        tool_calls: [{
            id: 'ex_d7', type: 'function',
            function: {
                name: 'app_add_components',
                arguments: JSON.stringify({
                    parentId: 'sec_cont01',
                    components: [
                        { type: 'page_header', props: { title: 'Contacts', subtitle: 'Everyone you work with', look: 'banner' }, style: { span: 12 } },
                        {
                            // A titled panel is a `card` (container has no title).
                            type: 'card', props: { title: 'Add a contact', look: 'accent' }, style: { span: 5 },
                            children: [{
                                tempId: 'frm', type: 'form', props: { name: 'contact', submitLabel: 'Save contact' }, style: { span: 12 },
                                children: [
                                    { type: 'input_text', props: { name: 'name', label: 'Name', required: true }, style: { span: 12 } },
                                    { type: 'input_text', props: { name: 'email', label: 'Email' }, style: { span: 12 } },
                                    { type: 'input_text', props: { name: 'company', label: 'Company' }, style: { span: 12 } },
                                ],
                            }],
                        },
                        { type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_cont01', sort: [{ field: 'created_at', dir: 'desc' }] }, columns: [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'company', label: 'Company' }], searchable: true, emptyText: 'No contacts yet — add the first one.' }, style: { span: 7 } },
                    ],
                }),
            },
        }],
    },
    {
        role: 'tool', tool_call_id: 'ex_d7',
        content: JSON.stringify({
            added: [
                { id: 'cmp_cthd01', type: 'page_header' },
                { id: 'cmp_ctcd01', type: 'card' },
                { tempId: 'frm', id: 'cmp_ctfrm1', type: 'form' },
                { id: 'cmp_ctin01', type: 'input_text' },
                { id: 'cmp_ctin02', type: 'input_text' },
                { id: 'cmp_ctin03', type: 'input_text' },
                { id: 'cmp_ctgr01', type: 'data_grid' },
            ],
            ids: { frm: 'cmp_ctfrm1' },
            _plan: { markedDone: [2], next: 'Save action wired to the form' },
        }),
    },
    {
        role: 'assistant',
        content: '',
        tool_calls: [{
            // The save: a SEQUENCE — the record step reads the submitted inputs
            // as form.<props.name>, the refresh makes the grid show the new row.
            id: 'ex_d8', type: 'function',
            function: {
                name: 'app_set_action',
                arguments: JSON.stringify({
                    action: {
                        kind: 'sequence',
                        steps: [
                            { kind: 'create_record', tableId: 'tbl_cont01', values: { name: { kind: 'formula', expr: 'form.name' }, email: { kind: 'formula', expr: 'form.email' }, company: { kind: 'formula', expr: 'form.company' } } },
                            { kind: 'reset_form', form: 'contact' },
                            { kind: 'refresh', tableId: 'tbl_cont01' },
                            { kind: 'toast', message: 'Contact saved.', tone: 'success' },
                        ],
                    },
                }),
            },
        }],
    },
    {
        role: 'tool', tool_call_id: 'ex_d8',
        content: JSON.stringify({
            actionId: 'act_cont01', created: true,
            action: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 'tbl_cont01', values: { name: { kind: 'formula', expr: 'form.name' }, email: { kind: 'formula', expr: 'form.email' }, company: { kind: 'formula', expr: 'form.company' } } }, { kind: 'reset_form', form: 'contact' }, { kind: 'refresh', tableId: 'tbl_cont01' }, { kind: 'toast', message: 'Contact saved.', tone: 'success' }] },
        }),
    },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            { id: 'ex_d9', type: 'function', function: { name: 'app_bind_action', arguments: JSON.stringify({ nodeId: 'cmp_ctfrm1', event: 'onSubmit', actionId: 'act_cont01' }) } },
            { id: 'ex_d10', type: 'function', function: { name: 'app_set_plan', arguments: JSON.stringify({ markDone: [0, 1, 3, 4] }) } },
            { id: 'ex_d11', type: 'function', function: { name: 'app_finalize', arguments: '{}' } },
        ],
    },
    { role: 'tool', tool_call_id: 'ex_d9', content: JSON.stringify({ nodeId: 'cmp_ctfrm1', event: 'onSubmit', actionId: 'act_cont01' }) },
    { role: 'tool', tool_call_id: 'ex_d10', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Name the app and pick a look', done: true }, { i: 1, text: 'Create the Contacts table', done: true }, { i: 2, text: 'Contacts screen with the add form and the table', done: true }, { i: 3, text: 'Save action wired to the form', done: true }, { i: 4, text: 'Finalize', done: true }], next: null }) },
    { role: 'tool', tool_call_id: 'ex_d11', content: JSON.stringify({ finalized: true, appId: 'app-ex4', version: 6, name: 'Contact book' }) },
    {
        role: 'assistant',
        content: 'Done — your Contact book has a Contacts table with three example contacts, a form that saves a new contact and a table that refreshes as you add them. Open the app and add one.',
    },
];

const LINKED_TABLE_SHOT = [
    { role: 'user', content: 'Build a dashboard on my Studio table "Orders": total revenue, number of orders, revenue per month, and a searchable table of all orders.' },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            {
                id: 'ex_c1', type: 'function',
                function: {
                    name: 'app_set_plan',
                    arguments: JSON.stringify({ todos: [{ text: 'Name the app and pick a look' }, { text: 'Link the Orders table' }, { text: 'Total revenue and order count tiles' }, { text: 'Revenue per month chart' }, { text: 'Searchable orders table' }, { text: 'Finalize' }] }),
                },
            },
            {
                id: 'ex_c2', type: 'function',
                function: {
                    name: 'app_set_meta',
                    arguments: JSON.stringify({ name: 'Orders dashboard', description: 'Live view of the Orders table.', icon: 'ShoppingCart' }),
                },
            },
            {
                id: 'ex_c3', type: 'function',
                function: { name: 'app_set_theme', arguments: JSON.stringify({ preset: 'cloud' }) },
            },
            {
                id: 'ex_c4', type: 'function',
                function: { name: 'app_link_datatable', arguments: JSON.stringify({ name: 'Orders' }) },
            },
        ],
    },
    { role: 'tool', tool_call_id: 'ex_c1', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Name the app and pick a look', done: false }, { i: 1, text: 'Link the Orders table', done: false }, { i: 2, text: 'Total revenue and order count tiles', done: false }, { i: 3, text: 'Revenue per month chart', done: false }, { i: 4, text: 'Searchable orders table', done: false }, { i: 5, text: 'Finalize', done: false }], next: 'Name the app and pick a look' }) },
    { role: 'tool', tool_call_id: 'ex_c2', content: JSON.stringify({ meta: { name: 'Orders dashboard', description: 'Live view of the Orders table.', icon: 'ShoppingCart' } }) },
    {
        // Byte-true to applySetTheme({preset:'cloud'}): cloud's navStyle is
        // "sidebar", so the result carries a nav key.
        role: 'tool', tool_call_id: 'ex_c3',
        content: JSON.stringify({
            theme: { primary: '#1D4ED8', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'light' },
            design: { preset: 'cloud', font: 'satoshi', surface: 'soft', motion: 'full', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
            nav: { style: 'sidebar' },
        }),
    },
    {
        role: 'tool', tool_call_id: 'ex_c4',
        content: JSON.stringify({
            table: {
                id: 'tbl_ordr01', key: 'orders', name: 'Orders',
                fields: [{ key: 'order_date', type: 'date' }, { key: 'customer', type: 'text' }, { key: 'order_number', type: 'text' }, { key: 'amount', type: 'number' }],
                linked: { kind: 'studio', mode: 'read', rowCount: 128 },
            },
            _next: 'Bind components to tbl_ordr01 with {kind:"records", tableId:"tbl_ordr01"} / {kind:"aggregate", tableId:"tbl_ordr01", …} using these field keys exactly: order_date, customer, order_number, amount. Rows are live and read-only — never seed this table.',
        }),
    },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            {
                id: 'ex_c5', type: 'function',
                function: {
                    name: 'app_add_components',
                    arguments: JSON.stringify({
                        parentId: 'sec_home01',
                        components: [
                            { type: 'page_header', props: { title: 'Orders', subtitle: 'Live from the Orders table', look: 'banner' }, style: { span: 12 } },
                            { type: 'stat', props: { label: 'Total revenue', value: { kind: 'aggregate', tableId: 'tbl_ordr01', aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }], pick: { row: 'first', column: 'total' } }, icon: 'Euro', look: 'accent' }, style: { span: 3 } },
                            { type: 'stat', props: { label: 'Orders', value: { kind: 'aggregate', tableId: 'tbl_ordr01', aggregates: [{ fn: 'count', as: 'n' }], pick: { row: 'first', column: 'n' } }, icon: 'Hash', look: 'tile' }, style: { span: 3 } },
                            { type: 'chart', props: { title: 'Revenue per month', chartType: 'bar', source: { kind: 'aggregate', tableId: 'tbl_ordr01', groupBy: [{ field: 'order_date', bucket: 'month', as: 'month' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'revenue' }], sort: [{ field: 'month', dir: 'asc' }] }, xKey: 'month', xType: 'time', series: [{ key: 'revenue', label: 'Revenue' }], valueFormat: 'currency' }, style: { span: 6 } },
                            { type: 'filter_bar', props: { fields: [{ name: 'from', label: 'Orders since', type: 'date' }] }, style: { span: 12 } },
                            { type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_ordr01', filter: [{ field: 'order_date', op: 'gte', value: { kind: 'formula', expr: 'vars.filters.from' } }], sort: [{ field: 'order_date', dir: 'desc' }] }, columns: [{ key: 'order_date', label: 'Date', format: 'date' }, { key: 'customer', label: 'Customer' }, { key: 'order_number', label: 'Order' }, { key: 'amount', label: 'Amount', format: 'currency' }], searchable: true, look: 'striped', emptyText: 'No orders yet.' }, style: { span: 12 } },
                        ],
                    }),
                },
            },
        ],
    },
    {
        role: 'tool', tool_call_id: 'ex_c5',
        content: JSON.stringify({
            added: [
                { id: 'cmp_orhd01', type: 'page_header' },
                { id: 'cmp_orst01', type: 'stat' },
                { id: 'cmp_orst02', type: 'stat' },
                { id: 'cmp_orch01', type: 'chart' },
                { id: 'cmp_orfl01', type: 'filter_bar' },
                { id: 'cmp_orgr01', type: 'data_grid' },
            ],
            ids: {},
            _plan: { markedDone: [2, 3, 4], next: 'Finalize' },
        }),
    },
    {
        role: 'assistant',
        content: '',
        tool_calls: [
            { id: 'ex_c6', type: 'function', function: { name: 'app_set_plan', arguments: JSON.stringify({ markDone: [0, 1, 5] }) } },
            { id: 'ex_c7', type: 'function', function: { name: 'app_finalize', arguments: '{}' } },
        ],
    },
    { role: 'tool', tool_call_id: 'ex_c6', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Name the app and pick a look', done: true }, { i: 1, text: 'Link the Orders table', done: true }, { i: 2, text: 'Total revenue and order count tiles', done: true }, { i: 3, text: 'Revenue per month chart', done: true }, { i: 4, text: 'Searchable orders table', done: true }, { i: 5, text: 'Finalize', done: true }], next: null }) },
    { role: 'tool', tool_call_id: 'ex_c7', content: JSON.stringify({ finalized: true, appId: 'app-ex3', version: 4, name: 'Orders dashboard' }) },
    {
        role: 'assistant',
        content: 'Done — the Orders dashboard reads your Orders table live: total revenue and order count on top, revenue per month as a bar chart, and a searchable table of every order below. Nothing was copied or seeded; rows stay in the Orders table.',
    },
];

module.exports = { buildFewShotMessages, LOOKUP_TOOL_IDS: ['ex_a1', 'ex_a2', 'ex_a3', 'ex_a4', 'ex_a5', 'ex_a6', 'ex_a7'], _shots: { LOOKUP_SHOT, SPLIT_VIEW_SHOT, LINKED_TABLE_SHOT, FORM_SAVE_SHOT } };
