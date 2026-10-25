// @typecheck noImplicitAny
'use strict';
// Part 1 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { THEME_SPEC, DESIGN_SPEC, NAV_STYLES, MAX_NAV_GROUPS, MAX_NAV_GROUP_LABEL, STYLE_KNOBS, SCREEN_SPEC, EVENT_NAMES } = require('../componentSpecs');
const { MAX_COMPONENTS_PER_CALL, TEMP_ID_MAX, MAX_BATCH_PATCHES_PER_CALL, orList, PRESET_IDS, STYLE_HINT, SECTION_HEIGHT_MODES, unitList, SIZING_HINT, ADD_NODE_LOGIC_PROPS, UPDATE_COMPONENT_PATCH_PROPS, ACTION_OBJECT_SCHEMA, batchHint } = require('./schemaFragments');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_1 = [
    {
        type: 'function',
        function: {
            name: 'app_set_meta',
            description: 'Name the app. Call it in your FIRST call group on a new app, with app_set_plan and app_set_theme. name: in the user\'s language, 2–4 words, ≤ 40 chars (max 80), what the user would call it. description: one sentence. icon: a Lucide name such as ClipboardList, Receipt, Users, BarChart3, ShoppingCart, Calendar, FileText, Gauge.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The app\'s name (2–4 words, ≤ 40 chars; max 80).' },
                    description: { type: 'string', description: 'One sentence: what the app does.' },
                    icon: { type: 'string', description: 'Lucide icon name, e.g. "ClipboardList", "Receipt", "Users".' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_theme',
            description: 'Restyle the whole app in one call. Fastest path: pass `preset` for a complete, designed look (colour, corners, density, font, surfaces, motion AND navigation style); add individual knobs to adjust it — they win over the preset. Only pass what you want to change.',
            parameters: {
                type: 'object',
                properties: {
                    preset: {
                        type: 'string',
                        enum: PRESET_IDS,
                        description: 'A whole look at once. classic = the plain default; cloud = modern light SaaS with a sidebar; atlas = product-style mega menu; midnight = dark ops console with an icon rail; field = large, airy, mobile-first; paper = warm editorial; mono = dense expert tool.',
                    },
                    primary: { type: 'string', description: 'Primary color as #rrggbb (prefer a catalog preset; never purple/violet/indigo).' },
                    accent: { type: 'string', description: 'Call-to-action colour as #rrggbb: primary buttons and form submits paint with it, everything else stays on the primary. Unset = the primary. Pass an empty string to clear it.' },
                    canvas: { type: 'string', description: 'Page ground colour as #rrggbb — the colour behind the sections. Unset = the platform light/dark ground. Pass an empty string to clear it.' },
                    radius: { type: 'string', enum: [...THEME_SPEC.radius.values] },
                    density: { type: 'string', enum: [...THEME_SPEC.density.values] },
                    fontScale: { type: 'string', enum: [...THEME_SPEC.fontScale.values] },
                    appearance: { type: 'string', enum: [...THEME_SPEC.appearance.values], description: 'dark/light now really re-theme the app itself, whatever theme the host is on.' },
                    navStyle: { type: 'string', enum: [...NAV_STYLES], description: 'How screens are navigated. tabs = a top row; sidebar = grouped and labelled, right from ~6 screens; mega = a top bar whose groups open a panel with a description per screen (needs nav groups); rail = an icon-only sidebar.' },
                    font: { type: 'string', enum: [...DESIGN_SPEC.font.values], description: 'Typeface pairing. system = the host UI font (default).' },
                    surface: { type: 'string', enum: [...DESIGN_SPEC.surface.values], description: 'How cards, stats and grids sit on the page. soft/elevated add depth; hairline is the default outline.' },
                    motion: { type: 'string', enum: [...DESIGN_SPEC.motion.values], description: 'Animation level. Reduced-motion users always get none.' },
                    chartPalette: { type: 'string', enum: [...DESIGN_SPEC.chartPalette.values], description: 'brand derives chart colours from the primary colour.' },
                    accentEdge: { type: 'string', enum: [...DESIGN_SPEC.accentEdge.values], description: 'The coloured edge on accent cards, callouts and bar headings. bar = the default stripe; none removes it everywhere at once.' },
                    logoUrl: { type: 'string', description: 'https:// URL of a logo shown in the app chrome instead of the icon tile. Pass an empty string to remove it.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_nav_groups',
            description: 'Group the screens in the nav under labelled headings — what the "mega" and "sidebar" nav styles render as dropdowns / sections. Pass the COMPLETE list: a screen belongs to exactly one group, and the order of the groups (and of the screens inside them) is the order shown. A screen you leave out still appears in the nav, just loose beside the groups. Pass groups:null to ungroup everything.',
            parameters: {
                type: 'object',
                required: ['groups'],
                properties: {
                    groups: {
                        type: 'array',
                        description: `Up to ${MAX_NAV_GROUPS} groups, in nav order. Omit ids to have them minted.`,
                        items: {
                            type: 'object',
                            required: ['label', 'screens'],
                            properties: {
                                id: { type: 'string', description: 'Existing group id (nvg_...) — keep it to preserve a group across edits.' },
                                label: { type: 'string', description: `The heading shown in the nav (max ${MAX_NAV_GROUP_LABEL} chars).` },
                                icon: { type: 'string', description: 'Lucide icon name, e.g. "BarChart3", "Settings".' },
                                screens: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Screen ids (scr_...) in the order they should appear under the heading.',
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_add_screen',
            description: 'Add a new screen (a page). Returns { screenId, sectionId } — the sectionId is the screen\'s first (empty) section, ready for app_add_components. Navigation is automatic: every screen with showInNav appears in the app\'s nav.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Screen name (labels the nav entry).' },
                    icon: { type: 'string', description: 'Lucide icon name for the nav entry.' },
                    description: { type: 'string', description: 'One line (≤120 chars) saying what the screen is for — shown in the mega menu, the mobile drawer and the collapsed sidebar. Write it for every screen.' },
                    showInNav: { type: 'boolean', description: 'Show in the app navigation (default true). Use false for detail/thanks screens reached via actions.' },
                    maxWidth: { type: 'string', enum: [...SCREEN_SPEC.maxWidth.values], description: `Content width (default ${SCREEN_SPEC.maxWidth.default}).` },
                    refreshInterval: { type: 'number', enum: [...SCREEN_SPEC.refreshInterval.values], description: "Seconds between background refreshes of this screen's data; 0 = off. Use 30 for an inbox-style screen." },
                    visibleToRoles: { type: 'array', items: { type: 'string' }, description: 'Role keys (from app_set_roles) that may open this screen. Omit or leave empty for everyone. Gates the whole screen including its nav entry — the coarse control that belongs on an admin-only page.' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_update_screen',
            description: 'Change a screen\'s settings in place (name, icon, nav visibility, width) and/or make it the home screen.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string', description: 'The screen id (scr_…).' },
                    name: { type: 'string' },
                    icon: { type: 'string' },
                    description: { type: 'string', description: 'One line (≤120 chars) saying what the screen is for. Pass an empty string to remove it.' },
                    showInNav: { type: 'boolean' },
                    maxWidth: { type: 'string', enum: [...SCREEN_SPEC.maxWidth.values] },
                    refreshInterval: { type: 'number', enum: [...SCREEN_SPEC.refreshInterval.values] },
                    visibleToRoles: { type: 'array', items: { type: 'string' }, description: 'Role keys that may open this screen (pass an empty array to clear the restriction).' },
                    makeHome: { type: 'boolean', description: 'Set this screen as the app\'s home screen (homeScreenId).' },
                },
                required: ['screenId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_remove_screen',
            description: 'Delete a screen. An app must keep at least one screen; homeScreenId is repointed automatically. Actions that navigated to the removed screen must be fixed or removed.',
            parameters: {
                type: 'object',
                properties: { screenId: { type: 'string' } },
                required: ['screenId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_add_section',
            description: 'Add an empty section (a 12-column grid row) to a screen. Returns { sectionId }. Screens are a vertical stack of sections; use several sections to separate header / form / results areas.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string' },
                    index: { type: 'number', description: 'Insert position among the screen\'s sections (omit to append).' },
                    style: {
                        type: 'object',
                        description: `Section style: { padding ${STYLE_KNOBS.padding.min}-${STYLE_KNOBS.padding.max}, gap ${STYLE_KNOBS.gap.min}-${STYLE_KNOBS.gap.max}, background ${orList(STYLE_KNOBS.background.values)}, height ${orList(STYLE_KNOBS.height.values)}, heightMode ${orList(SECTION_HEIGHT_MODES)} + heightValue (${unitList('heightValue', SECTION_HEIGHT_MODES)}) }. background "panel" = a recessed grouping surface, "gradient" = a soft wash from the app primary. height "fill" makes the section take the whole screen height — combine it with two pane components for a sidebar + detail layout that scroll independently. heightMode overrides the preset for an EXACT section height: "px" for a fixed band, "vh" for a share of the viewport ("vh" 50 = half the screen). A section can never take "pct" — it is auto-height in the screen's stack, so a percentage has nothing to measure.`,
                        properties: {
                            padding: { type: 'number' },
                            gap: { type: 'number' },
                            background: { type: 'string', enum: [...STYLE_KNOBS.background.values] },
                            height: { type: 'string', enum: [...STYLE_KNOBS.height.values] },
                            heightMode: { type: 'string', enum: [...SECTION_HEIGHT_MODES] },
                            heightValue: { type: 'number' },
                        },
                    },
                },
                required: ['screenId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_update_section',
            description: 'Restyle an existing section. Sections could only ever be styled at creation, so a section whose components have moved elsewhere kept its padding and rendered as a band of empty space nothing could close.',
            parameters: {
                type: 'object',
                properties: {
                    sectionId: { type: 'string', description: 'The section id (sec_…) to restyle.' },
                    style: {
                        type: 'object',
                        description: 'The same style knobs app_add_section takes; only the keys you pass are changed.',
                        properties: {
                            padding: { type: 'number' },
                            gap: { type: 'number' },
                            background: { type: 'string', enum: [...STYLE_KNOBS.background.values] },
                            height: { type: 'string', enum: [...STYLE_KNOBS.height.values] },
                            heightMode: { type: 'string', enum: [...SECTION_HEIGHT_MODES] },
                            heightValue: { type: 'number' },
                        },
                    },
                },
                required: ['sectionId', 'style'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_add_components',
            description: `Add one or MANY components in a single call — always prefer one batched call over serial calls. \`parentId\` is a section id (sec_…) or a container component id (card/form cmp_…). Containers take nested \`children\` trees in the same entry shape, so a whole form (inputs included) lands in ONE call. Give entries a \`tempId\` handle to read their real ids from the result (\`ids\` map) — e.g. the form node you will wire with app_bind_action. Entries belong in \`components[]\` only — never a type or children at the root, and never resend a batch that already landed (its ids are in the result). ${STYLE_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    parentId: { type: 'string', description: 'Section id or container component id the components go into. The key is parentId (not sectionId) — the `sectionId` app_add_screen returns IS the value to pass here.' },
                    index: { type: 'number', description: 'Insert position among the parent\'s children (omit to append).' },
                    components: {
                        type: 'array',
                        description: `Component entries, applied in order (max ${MAX_COMPONENTS_PER_CALL} top-level entries per call).`,
                        items: {
                            type: 'object',
                            properties: {
                                tempId: { type: 'string', description: `Optional handle ([A-Za-z][A-Za-z0-9_]*, max ${TEMP_ID_MAX} chars) to look up the real id in the result's \`ids\` map.` },
                                type: { type: 'string', description: 'A component type from the catalog (heading, text, button, form, input_text, table, …).' },
                                props: { type: 'object', description: 'Props per the catalog\'s prop table for this type. Missing props are filled with spec defaults.' },
                                style: { type: 'object', description: `Style knobs per the catalog (span 1-12, size, align, …). ${SIZING_HINT}` },
                                children: { type: 'array', items: { type: 'object' }, description: 'Containers (card/form) only: nested component entries in this same shape.' },
                                ...ADD_NODE_LOGIC_PROPS,
                            },
                            required: ['type'],
                        },
                    },
                },
                required: ['parentId', 'components'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_update_component',
            description: `Edit existing components IN PLACE — props/style are shallow-MERGED (only the keys you pass change), keeping ids and wiring. Never remove + re-add a component just to tweak it. ${batchHint('updates', 'patch')}`,
            parameters: {
                type: 'object',
                properties: {
                    ...UPDATE_COMPONENT_PATCH_PROPS,
                    updates: {
                        type: 'array',
                        description: `Batch form: up to ${MAX_BATCH_PATCHES_PER_CALL} patches, each in the same shape as the single form ({ id, props?, style?, visible?, … }). Pass this OR the single-component fields, never both.`,
                        items: {
                            type: 'object',
                            properties: { ...UPDATE_COMPONENT_PATCH_PROPS },
                            required: ['id'],
                        },
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_move_node',
            description: 'Move a component to another parent (section or container) and/or position. `index` addresses the destination children AFTER the node is lifted out.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The component id to move.' },
                    toParentId: { type: 'string', description: 'Destination section id or container component id.' },
                    index: { type: 'number', description: 'Position among the destination children (omit to append).' },
                },
                required: ['id', 'toParentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_remove_node',
            description: 'Delete a component (and, for containers, its whole subtree).',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_action',
            description: `Create or update named actions. Omit \`actionId\` to create (the result returns the new id); pass an existing id to update it in place. Actions are the app's behaviours — wire them onto buttons/forms with app_bind_action, and bind their results into components via {kind:"actionResult", actionId, path} bindings. ${batchHint('actions', '{ actionId?, action }')}`,
            parameters: {
                type: 'object',
                properties: {
                    actionId: { type: 'string', description: 'Existing action id (act_…) to update; omit to create a new action.' },
                    action: ACTION_OBJECT_SCHEMA,
                    actions: {
                        type: 'array',
                        // A patch batch is PARTIAL (see runPatchBatch): failed
                        // entries are skipped, so the flat `actionId` array is
                        // the SUCCESSES packed together — position N in it is
                        // not entry N once anything has failed. Read ids off
                        // `actions[].index` instead, or a following
                        // app_bind_action batch wires the wrong action.
                        description: `Batch form: up to ${MAX_BATCH_PATCHES_PER_CALL} { actionId?, action } entries applied in order. The result's \`actions\` array pairs every real id with the \`index\` of the entry that made it — read ids from there. The flat \`actionId\` array lists ONLY the entries that succeeded, so it lines up with your entries only when \`failed\` is absent. Pass this OR the single-action fields, never both.`,
                        items: {
                            type: 'object',
                            properties: {
                                actionId: { type: 'string', description: 'Existing action id (act_…) to update; omit to create.' },
                                // Not the properties block again: the same
                                // ~3k of schema twice per menu, for a shape
                                // `action` already declares one line up.
                                action: { type: 'object', description: 'Same shape as `action`.' },
                            },
                            required: ['action'],
                        },
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_remove_action',
            description: 'Delete an action. Every onClick/onSubmit that pointed at it is unwired automatically; actionResult bindings that referenced it must be re-bound.',
            parameters: {
                type: 'object',
                properties: { actionId: { type: 'string' } },
                required: ['actionId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_bind_action',
            description: `Wire (or clear) component events to actions: a button's onClick, a form's onSubmit, a table/timeline's onRowClick/onRowSelect, a kanban's onCardMove, or a discrete input's onChange (select/checkbox/date — fires when the value changes). The action must already exist (app_set_action first). Pass actionId null to unwire. Each component type supports only the events its catalog entry lists. ${batchHint('bindings', '{ nodeId, event, actionId }')}`,
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'The component id carrying the event (e.g. a button for onClick, a form for onSubmit, a kanban for onCardMove).' },
                    event: { type: 'string', enum: [...EVENT_NAMES] },
                    // `type: ['string','null']` renders as the literal list
                    // ['STRING', 'NULL'] on Gemma's template; `nullable` is the
                    // form every template renders.
                    actionId: { type: 'string', nullable: true, description: 'Action id (act_…); null to unwire.' },
                    bindings: {
                        type: 'array',
                        description: `Batch form: up to ${MAX_BATCH_PATCHES_PER_CALL} { nodeId, event, actionId } entries applied in order — wire a whole keypad in ONE call. Pass this OR the single-binding fields, never both.`,
                        items: {
                            type: 'object',
                            properties: {
                                nodeId: { type: 'string', description: 'The component id carrying the event.' },
                                event: { type: 'string', enum: [...EVENT_NAMES] },
                                actionId: { type: 'string', nullable: true, description: 'Action id (act_…); null to unwire.' },
                            },
                            required: ['nodeId', 'event', 'actionId'],
                        },
                    },
                },
            },
        },
    },
    // ── Data engine (per-app database) ─────────────────────────────
    {
        type: 'function',
        function: {
            name: 'app_set_plan',
            description: 'Record (and update) your own to-do list for building this app, shown to the user as a live checklist on the canvas. Call it with `todos` bundled with your FIRST build call for any build of more than one call; later bundle the cheap `markDone` diff form with the calls that complete an item. NEVER send this tool as your only call in a reply. It does not change the app.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: 'The full ordered checklist (replaces the previous one). Use for the initial plan or a restructure.',
                        items: { type: 'object', properties: { text: { type: 'string', description: 'Short task description.' }, done: { type: 'boolean', description: 'true once completed.' } }, required: ['text'] },
                    },
                    markDone: {
                        type: 'array',
                        items: { type: 'integer' },
                        description: '0-based indices of existing todos to flip done:true. Cheaper than resending todos — use this for progress updates, bundled with your next build call.',
                    },
                },
            },
        },
    },
];

module.exports = { TOOL_SCHEMAS_PART_1 };
