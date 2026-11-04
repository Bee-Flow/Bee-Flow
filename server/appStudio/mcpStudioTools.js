// @typecheck strict
'use strict';

/** The MCP-only tools, in the same OpenAI shape as TOOL_SCHEMAS. */
const STUDIO_TOOLS = [
    {
        name: 'studio_get_guide',
        description: 'The App Studio builder guide: how to compose screens/sections/components, the full component catalog with every prop and style knob, the action and sequence-step vocabulary, binding kinds and the formula functions. CALL THIS FIRST, once per session, before authoring anything — the app_* tool descriptions teach the call protocol only, not the vocabulary, and ids/props invented without the catalog get rejected by the validator.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'studio_list_apps',
        description: 'List the App Studio apps this token\'s user owns (id, name, description, version, published state, template provenance). Start here to find the appId to work on.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'studio_create_app',
        description: 'Create a new, empty App Studio app owned by this token\'s user and return its appId. Optionally start from a built-in template (see app_list_templates for ids) — a template gives you screens, tables and seed rows to edit rather than a blank canvas.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'App name (max 80 chars).' },
                description: { type: 'string', description: 'One or two sentences on what the app does.' },
                icon: { type: 'string', description: 'Lucide icon name, e.g. "ClipboardList".' },
                templateId: { type: 'string', description: 'Optional template id to install into the new app (app_list_templates lists them).' },
            },
            required: ['name'],
        },
    },
    {
        name: 'app_run_action',
        description: 'Run one action of the app on the server to TEST it, as the app OWNER, and get a per-step report { ok, dryRun, free, mocked, steps:[{ path, kind, status: ok|skipped|refused|error, result?, error?, ms, mocked?, iteration? }], vars, notes, definitionVersion }. Only the app owner may call it (an editor with write access is refused: it would use the owner\'s mailbox, connectors and AI budget). It runs the latest saved draft (read fresh on every call), not the published copy; pass expectVersion to refuse a draft that changed since you read it. Default dryRun true: nothing is written and nothing is sent. Record writes come back as skipped with { wouldWrite: { kind, tableId, values?, recordId? } }; file generators, automations and approvals as "would run"; send_email is NEVER executed (skipped with { wouldSend: { to, subject } }, no body); ai_extract, ai_generate, kb_query and dataset_query DO run (without their writeTo) and cost the owner\'s AI budget like a click, unless `mock` gives them a fixed answer. Client steps (toast, navigate, confirm, open_modal, ...) are skipped. condition, switch and loop are followed; record, records and aggregate bindings are READ on the server like a click (a loop over a records binding iterates its rows: default limit 50, at most 200). With dryRun false the steps run FOR REAL (records are written, files made) except: send_email runs only with mode "draft" (a draft in the mailbox, never sent) and never inside a loop; run_automation, request_approval, ai_browse and copy_document are refused. An error stops the run (as in the product); a skipped or refused step does not. Rate limit per user (default 10 per minute): a live run pays up front, a dry run only when an unmocked AI or read step runs, so a fully mocked dry run is free (free: true). Time-boxed, results trimmed. scope: { vars?, form?, item? } is what a click would have in scope. Save repeatable cases with app_save_test and run them with app_run_tests.',
        parameters: {
            type: 'object',
            properties: {
                actionId: { type: 'string', description: 'The action to run (act_… id from app_get_draft).' },
                scope: {
                    type: 'object',
                    description: 'What the click would have in scope: vars (variable values), form (submitted form values by input name), item (the row of a list/grid click). All optional, together at most 64 KB.',
                    properties: { vars: { type: 'object' }, form: { type: 'object' }, item: {} },
                },
                dryRun: { type: 'boolean', description: 'Default true: write nothing, send nothing. false: really run the steps (send_email only as a draft).' },
                mock: {
                    type: 'object',
                    description: 'Fixed MODEL answers per step path (the paths of this report: "steps[0]", "steps[1].then[0]", "steps[2].steps[0]" for a loop body). Only ai_generate, ai_extract, kb_query and dataset_query steps. ai_generate: a string (or { text }), an object for output "structured"; ai_extract: { rows: [...] }; kb_query: [results]; { "$error": "text" } makes the step fail. The step\'s schema coercion still runs on the answer. A mocked step costs nothing and writes nothing.',
                },
                expectVersion: { type: 'integer', description: 'Optional: the draft version you expect (app_get_action / app_set_action return it). A different saved version is refused before anything runs.' },
            },
            required: ['actionId'],
        },
    },
    {
        name: 'app_save_test',
        description: 'Save (or replace, by actionId + name) a TEST of one action: a scope, optional AI mocks and expectations, kept with the app (not in its definition, so it never ships to viewers). Editors may save tests; only the owner can run them (app_run_tests). expect: [{ path, op, value }], path roots: ok, stopped, vars.<name>…, result… (the last server step\'s result), or a step path with .status / .result… / .error / .prompt / .count / .mocked (e.g. "steps[0].result.rows[0].customer", "steps[1].status" = ok|error|skipped|refused|not_run). op: is, isNot, eq, neq, contains, notContains, startsWith, endsWith, gt, gte, lt, lte, isEmpty, isNotEmpty. mock: as in app_run_action; a test whose AI steps are all mocked is free and repeatable. remove: true deletes the test by actionId + name. Returns hints (e.g. an AI step that is not mocked).',
        parameters: {
            type: 'object',
            properties: {
                actionId: { type: 'string', description: 'The action the test runs (act_… id).' },
                name: { type: 'string', description: 'The test name, unique per action (1-80 characters).' },
                scope: { type: 'object', description: 'As app_run_action scope: { vars?, form?, item? }.', properties: { vars: { type: 'object' }, form: { type: 'object' }, item: {} } },
                mock: { type: 'object', description: 'As app_run_action mock: { "<step path>": <model answer> }.' },
                expect: {
                    type: 'array',
                    description: '1-50 expectations; each must hold. A test with no expectation on ok/stopped also fails when the run stops on an error.',
                    items: {
                        type: 'object',
                        properties: { path: { type: 'string' }, op: { type: 'string' }, value: {} },
                        required: ['path', 'op'],
                    },
                },
                remove: { type: 'boolean', description: 'true: delete the test (actionId + name) instead of saving it.' },
            },
            required: ['actionId', 'name'],
        },
    },
    {
        name: 'app_run_tests',
        description: 'Run the saved tests of the app (app_save_test) against the latest saved draft, always as a dry run (nothing written or sent), as the app OWNER (owner only). Reports per test pass | fail | error | not_run with the failing expectations ({ path, op, expected, actual }), the steps of a test that did not pass, and wasStatus (the result of the previous run). Mocked AI steps are free; an unmocked AI step counts against the app_run_action rate limit. Filter with actionIds and/or names.',
        parameters: {
            type: 'object',
            properties: {
                actionIds: { type: 'array', items: { type: 'string' }, description: 'Only the tests of these actions (at most 50).' },
                names: { type: 'array', items: { type: 'string' }, description: 'Only the tests with these names (at most 50).' },
            },
        },
    },
];

module.exports = { STUDIO_TOOLS };
