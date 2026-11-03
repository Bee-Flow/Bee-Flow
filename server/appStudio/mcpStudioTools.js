// @typecheck strict
'use strict';

/** The three MCP-only tools, in the same OpenAI shape as TOOL_SCHEMAS. */
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
        description: 'Run one action of the app on the server to TEST it, as the app OWNER, and get a per-step report { ok, dryRun, steps:[{ path, kind, status: ok|skipped|refused|error, result?, error? }], vars, notes }. Only the app owner may call it (an editor with write access is refused: it would use the owner\'s mailbox, connectors and AI budget). It runs the working draft, not the published copy. Default dryRun true: nothing is written and nothing is sent. Record writes, file generators, automations and approvals come back as skipped ("would write / would run"); send_email is NEVER executed (skipped with { wouldSend: { to, subject } }, no body); ai_extract, ai_generate, kb_query and dataset_query DO run (without their writeTo) and cost the owner\'s AI budget like a click. Client steps (toast, navigate, confirm, open_modal, ...) are skipped. condition, switch and loop are followed (a loop needs a source that resolves from scope.vars, max 200 rows; table and record bindings are not available on the server). With dryRun false the steps run FOR REAL (records are written, files made) except: send_email runs only with mode "draft" (a draft in the mailbox, never sent) and never inside a loop; run_automation, request_approval, ai_browse and copy_document are refused. An error stops the run (as in the product); a skipped or refused step does not. Rate-limited per user (default 10 per minute), time-boxed, results trimmed. scope: { vars?, form?, item? } is what a click would have in scope.',
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
            },
            required: ['actionId'],
        },
    },
];

module.exports = { STUDIO_TOOLS };
