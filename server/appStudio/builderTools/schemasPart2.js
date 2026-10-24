// @typecheck
'use strict';
// Part 2 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { LIMITS, THEME_SPEC, DESIGN_SPEC, VARIABLE_TYPES } = require('../componentSpecs');
const { FIELD_TYPES, FILTER_OPS, AGG_FNS, DATE_BUCKETS, ACCESS_MODES } = require('../dataModel');
const { MAX_SEED_RECORDS } = require('./schemaFragments');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_2 = [
    {
        type: 'function',
        function: {
            name: 'app_link_datatable',
            description: 'Link an EXISTING Studio table — a Nextcloud Tables mirror the owner set up in Studio > Datatables, or any organisation table — into this app by name, key or id. Its rows stay where they are and the app reads them LIVE; the result carries the tbl_ id and the exact field keys to bind ("Excl. btw" is stored as excl_btw). Prefer this over app_upsert_table whenever the ask names a table that already exists (for example one an automation fills). Never seed a linked table. Calling it again for the same table refreshes its field copy — it never makes a second table.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The table\'s title as shown in Studio > Datatables (case-insensitive), e.g. "Facturen". Use when you do not know the id.' },
                    key: { type: 'string', description: 'The table\'s key, e.g. "facturen".' },
                    datatableId: { type: 'string', description: 'The Studio table id (tbl_…) when you know it.' },
                    mode: { type: 'string', enum: ['read', 'readwrite'], description: 'read (default): the app only reads. readwrite: record actions write back to the source table (needs editor access).' },
                    tableKey: { type: 'string', description: 'Optional key for the table inside this app (lowercase snake_case). Defaults to the source table\'s key.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_upsert_table',
            description: 'Create or evolve ONE data table in the app\'s database (the app\'s OWN storage — for a table that already exists in Studio use app_link_datatable instead). Omit `tableId` to create; pass an existing tbl_… id to evolve it. `fields` is the table\'s COMPLETE field list: existing fields are matched by fieldId (or by key) and keep their stable ids; fields you leave out are DROPPED with their column data. Returns the real tbl_/fld_ ids to use in bindings and app_seed_records, plus a migration summary. DDL limits: a field\'s type can never be converted in place (add a new field instead), and a required field added to a populated table needs a `default` to backfill.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: 'string', description: 'Existing table id (tbl_…) to evolve; omit to create a new table.' },
                    key: { type: 'string', description: 'Physical table key: lowercase snake_case, starts with a letter (e.g. "tasks"). Derived from `name` when omitted on create; pass a new key on evolve to RENAME the table.' },
                    name: { type: 'string', description: 'Human table name (e.g. "Tasks") — on create, the key is derived from it when you give none.' },
                    icon: { type: 'string', description: 'Lucide icon name for the table.' },
                    fields: {
                        type: 'array',
                        description: 'The COMPLETE field list, in order.',
                        items: {
                            type: 'object',
                            properties: {
                                fieldId: { type: 'string', description: 'Existing field id (fld_…) — pass it to rename a field (same id, new key). Omit for new fields; same-key fields match automatically.' },
                                key: { type: 'string', description: 'Column key: lowercase snake_case (derived from `name` when omitted). Never a system column (id, created_at, updated_at, created_by, org_id — those exist automatically).' },
                                name: { type: 'string', description: 'Human label (defaults to the key; a key is derived from it when the key is omitted).' },
                                type: { type: 'string', enum: [...FIELD_TYPES] },
                                subtype: { type: 'string', description: 'number only: "integer" for whole numbers.' },
                                required: { type: 'boolean' },
                                unique: { type: 'boolean' },
                                default: { type: 'string', description: 'Default for new records, written as a string and read by the field\'s type: "false" on a bool, "0" on a number, "2026-01-01" on a date (a JSON boolean or number is accepted too); also backfills when adding a required field to a populated table.' },
                                options: { type: 'array', items: { type: 'string' }, description: 'select/multiselect: the allowed values (strings; {value,label} objects are accepted too).' },
                                relation: {
                                    type: 'object',
                                    description: 'relation only: the table this field points at.',
                                    properties: {
                                        tableId: { type: 'string', description: 'Target table id (tbl_…) — must already exist in the model (create parent tables first).' },
                                        displayFieldKey: { type: 'string', description: 'Which field on the target table labels each record.' },
                                    },
                                    required: ['tableId'],
                                },
                                computed: {
                                    type: 'object',
                                    description: 'computed only: a SQL expression over this table\'s columns.',
                                    properties: {
                                        expr: { type: 'string' },
                                        type: { type: 'string', description: 'Result type: "number", "integer" or "text" (default).' },
                                        // Without this key the tool could not express a stored
                                        // computed column at all — and because unknown keys are
                                        // dropped, re-sending an existing table through this tool
                                        // silently DOWNGRADED one to read-time. Everything that
                                        // filtered or aggregated on it then failed with "is a
                                        // read-time computed field and cannot be queried", from a
                                        // call whose only intent was to edit a different field.
                                        stored: { type: 'boolean', description: 'true materialises a real column, so the field can be FILTERED, SORTED and AGGREGATED on (a read-time expression can only be read). Set at table creation; adding one to a populated table backfills it.' },
                                    },
                                    required: ['expr'],
                                },
                            },
                            required: ['key', 'type'],
                        },
                    },
                    access: {
                        type: 'object',
                        description: 'Row-level access. default: "app" (everyone with the app; use this for demo/shared data), "owner" (each user sees only their own rows), "role" (only roles listed in `roles`), "none". roles: { [roleKey]: { read: "none"|"own"|"all", create: boolean, update: …, delete: … } }. rowFilters: { [roleKey]: "<formula over row fields and viewer.*>" }.',
                        properties: {
                            default: { type: 'string', enum: [...ACCESS_MODES] },
                            roles: { type: 'object' },
                            rowFilters: { type: 'object' },
                        },
                    },
                },
                required: ['fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_remove_table',
            description: 'Delete a data table AND all its rows. Refused while the definition still references the table (bindings, sequence steps, relation inputs) — re-bind or remove those first.',
            parameters: {
                type: 'object',
                properties: { tableId: { type: 'string', description: 'The table id (tbl_…).' } },
                required: ['tableId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_roles',
            description: 'Define the app\'s roles in ONE call — writes both the data model\'s roles/roleMapping (drives row-level security) and the definition\'s role list (drives visibleToRoles) so they stay in lockstep. Replaces the existing role list.',
            parameters: {
                type: 'object',
                properties: {
                    roles: {
                        type: 'array',
                        description: 'The complete role list.',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', description: 'Role key: lowercase snake_case (e.g. "manager").' },
                                label: { type: 'string', description: 'Human label (e.g. "Manager").' },
                            },
                            required: ['key'],
                        },
                    },
                    orgDirectory: {
                        type: 'boolean',
                        description: 'Let this app read the organisation\'s member list, so `input_person` and the `sys_org_members` dataset can offer real colleagues. Off unless set. Only names are exposed, never e-mail, and only to people who can already open the app — but ask the user before turning it on.',
                    },
                    roleMapping: {
                        type: 'object',
                        description: 'How viewers get a role: default = the role every org member gets when not mapped explicitly (a role key); byGroup = { [groupName]: roleKey }.',
                        properties: {
                            default: { type: 'string' },
                            byGroup: { type: 'object' },
                        },
                    },
                },
                required: ['roles'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_variables',
            description: 'Declare the shared variables of this app in ONE call — the named values every formula reads as vars.<name> and set_variable / resultVar steps write. Replaces the existing list. Declare a variable BEFORE any formula reads it: an undeclared name resolves to nothing, and a records filter using it is DROPPED, so the component lists every row instead of the ones you meant. "filters" is reserved — a filter_bar component owns vars.filters.<field>.',
            parameters: {
                type: 'object',
                properties: {
                    variables: {
                        type: 'array',
                        description: `The complete variable list (max ${LIMITS.MAX_VARIABLES}).`,
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Identifier a formula can read as vars.<name>: a letter or _ first, then letters, digits or _ (e.g. "selectedTicketId").' },
                                label: { type: 'string', description: 'Human label shown in the editor.' },
                                type: { type: 'string', enum: [...VARIABLE_TYPES], description: 'What it holds.' },
                                default: { description: 'Starting value, matching the type. Seeded before anything runs, on the client AND the server, so a filter bound to it filters on first paint.' },
                                description: { type: 'string', description: 'What it holds and who writes it.' },
                            },
                            required: ['name', 'type'],
                        },
                    },
                },
                required: ['variables'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_public_access',
            description: 'Open ONE part of this app to anonymous visitors: name the screen(s) reachable without a login, and the app gets a public URL (/p/<token>, minted separately by its owner). Everything else stays behind the login — other screens, the nav that names them, and every action wired only there are stripped before the definition leaves the server. Anonymous visitors carry the RESERVED role "public", which is DENIED BY DEFAULT on every table: grant it explicitly per table with app_upsert_table `access.roles.public` ({create:true, read:"own"} is the usual intake shape — "own" lets a visitor see back what they themselves submitted and nothing else). The public page may carry its OWN look via `theme` / `design` (partial, merged over the app\'s when served): the form a customer fills in wears the customer\'s brand while the back office keeps the app\'s — restyling the page changes nothing about the app\'s own screens. Pass publicAccess:null to close it again. The app must be PUBLISHED for the URL to work: anonymous visitors are always served the frozen published definition.',
            parameters: {
                type: 'object',
                properties: {
                    publicAccess: {
                        type: ['object', 'null'],
                        description: 'The public surface, or null to close it.',
                        properties: {
                            entryScreenId: { type: 'string', description: 'The screen an anonymous visitor lands on (scr_…). Required.' },
                            screenIds: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Every screen they may reach, including the entry screen (which is added automatically if omitted). Prefer ONE screen with sections gated by visibleWhen over several: a multi-screen wizard can be skipped through by navigating.',
                            },
                            title: { type: 'string', description: 'Browser title for the public page. Defaults to the app name.' },
                            theme: {
                                type: 'object',
                                description: 'The public page\'s own theme, merged over the app theme. Name only what differs — e.g. { canvas: "#ffda00", accent: "#009b3e", primary: "#0064b0" } for a customer whose brand is a yellow ground, green buttons and blue headings.',
                                properties: {
                                    primary: { type: 'string', description: '#rrggbb — headings, links, progress, badges.' },
                                    accent: { type: 'string', description: '#rrggbb — primary buttons and form submits. Unset = the primary.' },
                                    canvas: { type: 'string', description: '#rrggbb — the page ground behind the sections.' },
                                    radius: { type: 'string', enum: [...THEME_SPEC.radius.values] },
                                    density: { type: 'string', enum: [...THEME_SPEC.density.values] },
                                    fontScale: { type: 'string', enum: [...THEME_SPEC.fontScale.values] },
                                    appearance: { type: 'string', enum: [...THEME_SPEC.appearance.values] },
                                },
                            },
                            design: {
                                type: 'object',
                                description: 'The public page\'s own design knobs, merged over the app design. Typically just the typeface and a logo.',
                                properties: {
                                    font: { type: 'string', enum: [...DESIGN_SPEC.font.values] },
                                    logoUrl: { type: 'string', description: 'https:// URL of the customer\'s logo.' },
                                    surface: { type: 'string', enum: [...DESIGN_SPEC.surface.values] },
                                    motion: { type: 'string', enum: [...DESIGN_SPEC.motion.values] },
                                    accentEdge: { type: 'string', enum: [...DESIGN_SPEC.accentEdge.values] },
                                    chartPalette: { type: 'string', enum: [...DESIGN_SPEC.chartPalette.values] },
                                },
                            },
                        },
                        required: ['entryScreenId'],
                    },
                },
                required: ['publicAccess'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_seed_records',
            description: `Insert sample/demo rows into a table (1-${MAX_SEED_RECORDS} per call). Each record is { fieldKey: value } using the table's field keys — system columns are filled automatically. Returns the real rec_… ids: seed PARENT tables first and use those ids as the values of relation fields in later calls. Rows that fail (unknown field, quota) are reported per-row without blocking the others.`,
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: 'string', description: 'The table id (tbl_…).' },
                    records: {
                        type: 'array',
                        description: 'Row objects, e.g. [{ title: "Fix login bug", status: "todo" }].',
                        items: { type: 'object' },
                    },
                },
                required: ['tableId', 'records'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_upsert_dataset',
            description: 'Create or update a saved dataset — a named aggregation over ONE table for charts/stats ({kind:"dataset",datasetId} bindings). Omit `datasetId` to create. The dataset is executed once immediately: the result returns a preview (first 10 rows) so you can verify it before binding.',
            parameters: {
                type: 'object',
                properties: {
                    datasetId: { type: 'string', description: 'Existing dataset id to update; omit to create.' },
                    name: { type: 'string', description: 'Dataset name (required on create).' },
                    tableId: { type: 'string', description: 'The source table id (tbl_…).' },
                    descriptor: {
                        type: 'object',
                        description: `The aggregation: groupBy?: [{field, bucket?}] (bucket for date fields: ${DATE_BUCKETS.join('|')}); aggregates: [{fn: ${AGG_FNS.join('|')}, field?, as}] (count needs no field); filters?: [{field, op, value?}] (ops: ${FILTER_OPS.join(', ')}).`,
                        properties: {
                            groupBy: { type: 'array', items: { type: 'object' } },
                            aggregates: { type: 'array', items: { type: 'object' } },
                            filters: { type: 'array', items: { type: 'object' } },
                        },
                        required: ['aggregates'],
                    },
                    cacheTtlSeconds: { type: 'number', description: 'Result cache TTL (default 60).' },
                },
                required: ['tableId', 'descriptor'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_get_data_model',
            description: 'Read the app\'s current data model: every table with its real tbl_/fld_ ids, field keys/types, row counts, datasets and roles. Use it to re-check ids before binding; the same block is also injected into the conversation each turn.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_query_data',
            description: 'Read rows from the app\'s data (owner-scoped, never mutates) — verify seeds landed, inspect real values, or check what a dataset returns. Pass tableId for raw rows (with optional filter/sort) OR datasetId for a saved aggregation, not both. More rows than one page: the answer has more:true and a nextCursor to pass back.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: 'string', description: 'Table id (tbl_…) to list rows from.' },
                    datasetId: { type: 'string', description: 'Saved dataset id to run instead of a raw table read.' },
                    filter: {
                        type: 'array',
                        description: `Optional literal filters: [{field, op, value?}] with ops ${FILTER_OPS.join(', ')}.`,
                        items: { type: 'object' },
                    },
                    sort: { type: 'object', description: 'Optional { field, dir: "asc"|"desc" } (tableId only).' },
                    limit: { type: 'number', description: 'Max rows per call (default 5, max 20; a larger value is clamped and the answer says limitClamped).' },
                    cursor: { type: 'string', description: 'The nextCursor of the previous answer, to read the next page.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_list_connectors',
            description: "List the app's external connectors — owner-authored data sources (a platform tool, an automation, or an allow-listed REST endpoint) that a viewer can run to pull live rows. Read-only, NO arguments. Returns each connector's id (conn_…), kind, name and declared viewer params — never its pinned args, url or credentials. Wire one into a component's data prop with a { kind:\"connector\", connectorId, params? } binding (params values are literals or { kind:\"formula\", expr }). You can only WIRE connectors that already exist — you never author connectors or credentials (the app owner sets those up in the Connectors tab).",
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_list_documents',
            description: "List the DESIGNED documents the app owner made in Studio → Documents (templates and ordinary documents with placeholders, at most 50) — an invoice, a quote, a letter on the company's letterhead — with the placeholders each one carries. Read-only, NO arguments. Returns [{ documentId, name, docType, kind, versionId, placeholders:[{key, kind, fields?}] }].\n\nCall it before writing a `fill_document` step: `documentId` must be one of these (never invent one, and you cannot create a document — the owner designs it), and the keys of `values` are the placeholder names EXACTLY as listed. A placeholder of kind \"list\" must be bound to a binding that resolves to an ARRAY; its `fields` are what each item needs. If the list comes back empty, say the owner has to design the document in Studio → Documents first — do not fall back to a text export and call it an invoice.",
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_dry_run',
            description: 'Pre-flight the app before app_finalize: statically cross-checks the definition against the data model AND actually EXECUTES every record/records/dataset binding read-only (as the owner, and — with asRole — as a role) so you catch a component bound to an EMPTY table, a member who would see an empty screen, or a sequence step that writes a missing field before the user ever runs the app. Never mutates. Returns { ok, static:{errors,warnings}, bindings:[{nodeId,prop,kind,ok,rowCount|error|skipped}], roleFindings, actions, emptyTables, _hints }. Zero rows is a warning (seed data / fix the filter), not a blocker. Run it — and fix its findings — for any app with data bindings before finalizing.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string', description: 'Limit the data pass to one screen (scr_…); omit to check every screen.' },
                    asRole: { type: 'string', description: 'Also re-run the bindings as this role key (from the data model\'s roles) to see what a member with that role would see — surfaces empty role views.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_screenshot',
            description: 'SEE the screen you just built: renders one screen of the current draft in a real headless browser — with its REAL data, read through the app\'s access rules — and returns a screenshot plus render diagnostics. Use it to catch what validation cannot: a row whose spans wrapped past 12 columns, a region rendered empty because a binding returned nothing, a chart with no bars, clipped or cramped content. If your model has vision the image is attached for you to inspect; either way the user sees it in the chat. Expensive (a real browser render) and capped per turn — take one after a batch of edits, not after every change.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string', description: 'Screen to render (scr_…); omit for the app\'s home screen.' },
                    asRole: { type: 'string', description: 'Render — and read data — as this role key (from the data model\'s roles), exactly as a member with that role would see the screen.' },
                    viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'], description: 'Screen width to render at (default desktop). Shoot "mobile" once per screen before finalizing: a 12-column row that reads well on a laptop wraps into a stack on a phone, and that is where cramped or clipped layouts show up.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_get_draft',
            description: 'Read the current draft as a compact ID-bearing tree (screens → sections → components, plus actions). Use when you need to re-check ids or structure; the latest draft state is also injected into the conversation each turn. On a large app read it in parts — `screenId` for one screen, or `section` for just the actions / tables / meta — instead of pulling the whole tree.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string', description: 'Return only this screen\'s tree (scr_…). Implies section:"screens".' },
                    section: { type: 'string', enum: ['screens', 'actions', 'tables', 'meta'], description: 'Return only one part of the draft. Omit for everything.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_find_nodes',
            description: 'Search the draft for the nodes that match a query instead of reading the whole tree: by component type, by the table an action or binding touches, by an action id, or by a variable name. Returns each hit with its id, type, screen and path. Use it to answer "where is this used" and "what breaks if I remove this" — deleting a table or renaming a variable without checking is how a draft ends up with dangling references.',
            parameters: {
                type: 'object',
                properties: {
                    componentType: { type: 'string', description: 'Component type to find, e.g. "chart" or "data_grid".' },
                    tableId: { type: 'string', description: 'Find components bound to this table and actions that read or write it (tbl_…).' },
                    actionId: { type: 'string', description: 'Find components whose events run this action (act_…).' },
                    variable: { type: 'string', description: 'Find components and actions that read or write this variable name.' },
                    screenId: { type: 'string', description: 'Limit the search to one screen (scr_…).' },
                },
            },
        },
    },
];

module.exports = { TOOL_SCHEMAS_PART_2 };
