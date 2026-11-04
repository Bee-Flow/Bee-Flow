// @typecheck strict
// Part 1 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { BINDING_HINT, PICK_SOURCES, FORM_FIELD_TYPES, FORM_OPTIONS_HINT, FORM_WIZARD_FIELD_PROPS, SPLICE_DESCRIPTION } = require('./schemaFragments');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_1 = [
    {
        type: 'function',
        function: {
            name: 'builder_propose_trigger',
            // One paragraph on purpose: the per-provider app_event catalogue
            // (every event, filter key and payload field, ~16k characters for
            // every provider) does not belong in a schema every user receives
            // on every turn. It renders in the per-user "App events you may
            // use" block, for the providers THIS user has:
            // builderPrompt/triggerBlock.js (renderAppEventProviderLines),
            // checked by promptCatalogSync.test.js.
            description: 'Set or replace the automation trigger: ALWAYS the first call on a new draft (calling it again replaces the trigger). kind: manual (the user clicks Run) | schedule (5-field cron + IANA tz, e.g. {kind:"schedule",cron:"0 9 * * 1",tz:"Europe/Amsterdam"}) | webhook (an inbound HTTPS POST to a signed URL; trigger.output = the POSTed JSON) | form (Bee Flow hosts a public page; declare the questions in form.fields, answers arrive as trigger.output.<fieldName>) | app_event (appProvider + appEvent + optional filter) | agent_call — the automation becomes a TOOL an AI agent can call: set toolName, a description saying when to call it and what it returns, and every argument in params | app_trigger — fired by a button or action in a Studio App, its typed inputs in params. An agent_call or app_trigger argument arrives as trigger.output.<name> — there is no trigger.payload; you cannot choose the agents yourself, so after building an agent_call tell the person to link it under "Who can call this" in the trigger panel. For app_event read the "App events you may use" block (in the per-turn context; over MCP at the end of automations_get_guide): it lists only the providers that fire for THIS user, one line per provider with its events, then one line per event with the filter keys in [brackets] (use only those; an omitted filter = every event), the payload fields after → (bind them as trigger.output.<field>; never add a search step for data the payload already has) and the caution after —. An event marked [needs the connector] fires only when the user\'s connector delivers it, an event under NEVER propose has no producer, and a provider missing from the block cannot fire for this user: say so rather than propose it.',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['schedule', 'manual', 'webhook', 'form', 'app_event', 'agent_call', 'app_trigger'] },
                    form: {
                        type: 'object',
                        description: 'When kind=form: the public page Bee Flow hosts. Answers arrive as trigger.output.<fieldName>. Field `name` must be an identifier (letters/digits/underscore, no leading underscore) and is what you bind — it never changes when the label does.',
                        properties: {
                            title: { type: 'string' },
                            description: { type: 'string' },
                            submitLabel: { type: 'string' },
                            successMessage: { type: 'string' },
                            fields: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        type: { type: 'string', enum: FORM_FIELD_TYPES },
                                        label: { type: 'string' },
                                        required: { type: 'boolean' },
                                        placeholder: { type: 'string' },
                                        options: { type: 'array', items: { type: 'string' }, description: FORM_OPTIONS_HINT },
                                        accept: { type: 'string', description: 'When type=file: a MIME allowlist, e.g. "application/pdf,image/*".' },
                                        maxSizeMb: { type: 'number', description: 'When type=file: 1–25.' },
                                        source: { type: 'string', description: `REQUIRED when type=app_pick: which app the person filling the form searches. One of: ${PICK_SOURCES}. The search runs against THEIR OWN account, so use this instead of asking someone to paste a transcript or forward an email.` },
                                        multiple: { type: 'boolean', description: 'When type=app_pick: let them pick several records. The answer is then a LIST of descriptors instead of one.' },
                                        maxItems: { type: 'number', description: 'When type=app_pick and multiple: 1–10 (default 5).' },
                                        withText: { type: 'boolean', description: 'When type=app_pick: read the record\'s content into the run (default true). Set false when only a reference is wanted.' },
                                        ...FORM_WIZARD_FIELD_PROPS,
                                        // A file field binds as an OBJECT, never a string:
                                        // trigger.output.<name> is { kind, fileId, filename, mimeType, size,
                                        // text, textTruncated, textError }. `.text` is the extracted content —
                                        // a workbook as one markdown table per sheet, a PDF as its text layer —
                                        // so an ai_step reads the document by binding
                                        // trigger.output.<name>.text, NOT trigger.output.<name>.
                                        //
                                        // An app_pick field binds the same way: trigger.output.<name> is
                                        // { kind:'app_pick', source, app, recordId, title, url, text,
                                        // textTruncated, textError } — or a LIST of those when `multiple`.
                                        // `.text` is the transcript / email body / note, so an ai_step binds
                                        // trigger.output.<name>.text, never trigger.output.<name>.
                                    },
                                    required: ['name', 'type', 'label'],
                                },
                            },
                        },
                    },
                    cron: { type: 'string', description: 'Standard 5-field cron, REQUIRED when kind=schedule. Use exact format: minute hour day-of-month month day-of-week. Example: "0 9 * * 1" = every Monday at 9:00.' },
                    tz: { type: 'string', description: 'IANA timezone, e.g. Europe/Amsterdam (when kind=schedule).' },
                    appProvider: { type: 'string', description: 'When kind=app_event: a provider id from the "App events you may use" block.' },
                    appEvent: { type: 'string', description: 'When kind=app_event: an event id listed on that provider\'s line of the block.' },
                    filter: { type: 'object', description: 'Optional filter object. Use ONLY the keys the block lists for that event — several events have their own matcher (a tag list is an ANY-of, not an equality), and unknown keys are ignored rather than rejected. An omitted or empty filter means "every event of this kind", never "no events".' },
                    // §28 agent-callable trigger: automation is exposed as a tool the agent can invoke.
                    toolName: { type: 'string', description: 'When kind=agent_call: the tool name agents will see (lower-case letters, digits, underscores; anything else is rewritten). Defaults to automation_<id>.' },
                    description: { type: 'string', description: 'When kind=agent_call: what the tool does and when an agent should call it (the agent reads this to decide). Required for an agent_call that goes live.' },
                    parametersSchema: { type: 'object', description: 'When kind=agent_call: the arguments as a JSON Schema {type:"object", properties:{<name>:{type,description}}, required:[…]}. Prefer `params`; pass one of the two. Each argument arrives as trigger.output.<name>.' },
                    // App trigger: the automation is fired by a Studio App action with typed inputs.
                    params: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Identifier (letters/digits/underscore, no leading underscore).' },
                                type: { type: 'string', enum: ['string', 'number', 'boolean', 'array', 'object', 'file'] },
                                required: { type: 'boolean' },
                                description: { type: 'string' },
                            },
                            required: ['name', 'type'],
                        },
                        description: 'When kind=app_trigger: the typed inputs a Studio App action passes. When kind=agent_call: the arguments the agent passes (type string | number | boolean | array | object; `file` is for app_trigger only). Bind them in steps as trigger.output.<name>. A `file` input arrives at runtime as { fileId, name, mime, size, url } — bind trigger.output.<name>.url into steps that fetch the file (http_request, transcribe_audio, upload tools).',
                    },
                },
                required: ['kind'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_action',
            description: `Append an integration action that calls a real connected tool. The tool name MUST match the catalog exactly. ${BINDING_HINT} EXAMPLE — search Gmail for unread invoices: {tool:"gmail_search",inputs:{query:{kind:"literal",value:"label:Invoices is:unread"},maxResults:{kind:"literal",value:20}},label:"Find invoices"}. EXAMPLE — read EVERY email a previous search found, as ONE step (no loop container): {tool:"gmail_read",inputs:{messageId:{kind:"ref",path:"loop.e.id"}},forEach:{overRef:"steps.a_1a2b3c.output.messages",itemVar:"e"}} — the next step then runs per result with its own forEach over steps.<thisId>.output.results. NEVER pass plain strings as input values; ALWAYS wrap in {kind,...}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string', description: 'Insert after this step id. Default: last step.' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    tool: { type: 'string', description: 'Exact tool name from the catalog (e.g. gmail_search, gmail_compose, calendar_create_event).' },
                    inputs: { type: 'object', description: `Map of input-name to a binding object. ${BINDING_HINT}` },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string', description: 'Short human-readable label for the diagram.' },
                },
                required: ['tool'],
            },
        },
    },
];

module.exports = { TOOL_SCHEMAS_PART_1 };
