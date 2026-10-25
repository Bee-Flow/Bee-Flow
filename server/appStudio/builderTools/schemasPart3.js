// @typecheck strict
'use strict';
// Part 3 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { FIELD_TYPES } = require('../dataModel');
const { INSPECT_CATALOG_MAX_COMPONENTS, INSPECT_CATALOG_MAX_STEPS } = require('./schemaFragments');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_3 = [
    {
        type: 'function',
        function: {
            name: 'app_list_automations',
            description: 'List the automations (automations) the app owner can wire into run_automation actions: id, title, description, active state, trigger kind, and — for agent_call automations — the input parameter names to map via inputMapping. Returns at most 30 by default.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Only automations whose title or description contains this text (case-insensitive).' },
                    limit: { type: 'integer', description: 'Max automations to return (default 30, max 100).' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_inspect_automation',
            description: 'Inspect ONE automation in detail: its trigger and, for agent_call automations, the full input parameter schema — so the inputMapping you write matches the automation\'s real parameter names.',
            parameters: {
                type: 'object',
                properties: { automationId: { type: 'string' } },
                required: ['automationId'],
            },
        },
    },
    // ── Plan-first UX, phased generation & templates ───────────────
    {
        type: 'function',
        function: {
            name: 'app_propose_plan',
            description: 'Present an editable BUILD PLAN to the user and PAUSE for their approval — use this instead of building directly when the ask implies a NEW app with two or more screens OR any data model. The plan lists the tables, roles, screens, datasets, actions and the phases you will build in. The turn ends after you propose: the user reviews/edits the plan in the chat and approves it, and only THEN do you build. Do not call any other tool in the same turn as app_propose_plan. Small asks (a single screen, an edit, a fix) skip planning and build directly.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short app title.' },
                    summary: { type: 'string', description: 'One-paragraph summary of what the app does (max 400 chars).' },
                    tables: {
                        type: 'array',
                        description: 'The data tables you will create.',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', description: 'Snake_case table key (e.g. "tasks").' },
                                name: { type: 'string', description: 'Human table name.' },
                                fields: {
                                    type: 'array',
                                    description: 'Planned fields.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            key: { type: 'string' },
                                            type: { type: 'string', description: `A field type (${FIELD_TYPES.join(', ')}).` },
                                            options: { type: 'array', items: { type: 'string' }, description: 'select/multiselect option values.' },
                                            relationTo: { type: 'string', description: 'For a relation field: the key of the table it points at.' },
                                        },
                                        required: ['key', 'type'],
                                    },
                                },
                                seedCount: { type: 'number', description: 'How many sample rows you plan to seed (0-50).' },
                            },
                            required: ['key', 'name', 'fields'],
                        },
                    },
                    roles: {
                        type: 'array',
                        description: 'The roles the app defines.',
                        items: {
                            type: 'object',
                            properties: { key: { type: 'string' }, label: { type: 'string' } },
                            required: ['key', 'label'],
                        },
                    },
                    screens: {
                        type: 'array',
                        description: 'The screens (pages) you will build.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                icon: { type: 'string', description: 'Lucide icon name.' },
                                purpose: { type: 'string', description: 'What the screen is for (max 200 chars).' },
                                contents: { type: 'array', items: { type: 'string' }, description: 'Bullet list of the key components/areas on the screen.' },
                                forRoles: { type: 'array', items: { type: 'string' }, description: 'Role keys this screen is scoped to (omit for everyone).' },
                            },
                            required: ['name', 'purpose', 'contents'],
                        },
                    },
                    datasets: {
                        type: 'array',
                        description: 'Saved aggregations for charts/stats.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                tableKey: { type: 'string', description: 'The source table key.' },
                                purpose: { type: 'string' },
                            },
                            required: ['name', 'tableKey'],
                        },
                    },
                    actions: {
                        type: 'array',
                        description: 'The behaviours (create/update records, run automations, navigate, …).',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                kind: { type: 'string' },
                                description: { type: 'string' },
                            },
                            required: ['name', 'kind'],
                        },
                    },
                    phases: {
                        type: 'array',
                        description: 'The ordered phases you will build in (data → screens → wiring → polish). A checkpoint is saved at each phase boundary so the user can revert.',
                        items: {
                            type: 'object',
                            properties: {
                                label: { type: 'string' },
                                covers: { type: 'array', items: { type: 'string' }, description: 'What this phase delivers.' },
                            },
                            required: ['label'],
                        },
                    },
                    openQuestions: { type: 'array', items: { type: 'string' }, description: 'Anything you need the user to confirm before building.' },
                    baseTemplateId: { type: 'string', description: 'When a starter template matches the ask, its id — it will be applied first on approval (call app_list_templates to discover ids).' },
                },
                required: ['title', 'summary', 'screens'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_mark_phase',
            description: 'Announce that you are starting a build phase (from the approved plan). Zero-cost: it emits progress to the user AND saves a checkpoint the user can revert to. Call it once at the start of each phase.',
            parameters: {
                type: 'object',
                properties: {
                    index: { type: 'number', description: '0-based phase index (matches the approved plan\'s phases order).' },
                    label: { type: 'string', description: 'The phase label (e.g. "Data model", "Screens", "Wiring").' },
                },
                required: ['index', 'label'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_list_templates',
            description: 'List the starter templates you can install as a data-backed starting point (id, name, description, screen and table counts). Match one to the ask, then app_apply_template it on a fresh draft and customise from there.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_apply_template',
            description: 'Install a starter template as the foundation of the app — deep-copies its screens, creates its tables, seeds sample rows and datasets in one step. VALID ONLY on a fresh, untouched draft (one empty screen, nothing built yet); on a draft you have already started building it is refused. After applying, customise with the normal tools.',
            parameters: {
                type: 'object',
                properties: {
                    templateId: { type: 'string', description: 'The template id from app_list_templates.' },
                },
                required: ['templateId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_save_as_template',
            description: 'Save THIS app as a reusable template that anyone in the organisation can start a new app from (the inverse of app_apply_template). Captures the screens, actions and data model. Automation ids are cleared and file values, system columns and relations to rows that were not captured are stripped, so the template installs clean elsewhere. Refused while the app still has validation errors. Pass the same templateId again later to save a NEW VERSION over an existing template.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Template name as it appears in the gallery (max 80 chars).' },
                    description: { type: 'string', description: 'One or two sentences on what an app made from this does.' },
                    category: { type: 'string', description: 'Gallery grouping, e.g. "Sales" or "Compliance". Defaults to "Van je team".' },
                    icon: { type: 'string', description: 'Lucide icon name, e.g. "ClipboardList". Defaults to the app\'s own icon.' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Up to 8 short search tags.' },
                    seedTables: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Table IDS (tbl_…) whose rows to ship WITH the template, up to 100 rows each. Use this ONLY for vocabulary the app needs to work — option lists, material lists, column maps. Never name a table holding customer records, e-mail bodies or personal data: those rows would be copied into every app installed from this template. Default: no rows at all.',
                    },
                    templateId: { type: 'string', description: 'Optional: the utpl_… id of a template YOU created, to replace with a new version instead of creating a second one.' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_inspect_catalog',
            description: 'Full props/style of named component types and full field lists of named step kinds — the one-line catalog is a summary. Ask for everything you will use in ONE call, before adding them. Read-only.',
            parameters: {
                type: 'object',
                properties: {
                    components: { type: 'array', items: { type: 'string' }, description: `Component types to expand (max ${INSPECT_CATALOG_MAX_COMPONENTS}), e.g. ["data_grid", "kanban"].` },
                    steps: { type: 'array', items: { type: 'string' }, description: `Step kinds to expand (max ${INSPECT_CATALOG_MAX_STEPS}), e.g. ["request_approval", "send_email"].` },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_finalize',
            description: 'Finish the build: canonicalize + validate the draft and persist it. Only succeeds when the definition has NO validation errors — otherwise the structured errors come back for you to fix first. Call once, when the app is complete.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

module.exports = { TOOL_SCHEMAS_PART_3 };
