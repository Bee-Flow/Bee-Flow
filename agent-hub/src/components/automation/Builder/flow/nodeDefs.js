/**
 * One presentation record per RUNTIME STEP TYPE.
 *
 * Why this exists: a node's user-facing identity used to be written out
 * separately in five places — the palette payload (stepPalette.js), the drop
 * scaffold (DiagramPane.buildStepFromPayload), the canvas card
 * (flow/nodes/*.jsx), the node editor's header (NodeDetailView) and the
 * server's AI-builder tool (server/automation/builderTools.js). Nothing checked
 * that they agreed, and they didn't: `dedupe` was "Remove Duplicates" in the
 * palette, "Remove duplicates" on the canvas and "Dedupe" in the editor header,
 * and `guard`/`tokenize`/`untokenize` were missing from the editor's map
 * entirely, so opening a privacy node showed the raw type name — "tokenize" —
 * as its heading. The same omission in `sectionForIssue`'s taxonomy meant a
 * validation error on one of those nodes could not force its Advanced section
 * open, and at quick density that section is hidden, so the error was reported
 * and the control to fix it was unreachable.
 *
 * THE RULE: presentation only. If the runner or the validator would need to
 * read it, it does not belong here. No settings forms, no executors, no
 * validation rules, no LLM tool schemas.
 *
 * Not owned here either: the PALETTE entry (id / icon / keywords / payload).
 * That is a different axis — one palette item (Condition) maps to three runtime
 * types, two (the form pages) map to one, and triggers and flowlets map to
 * none. stepPalette.js keeps those and imports `defaultLabel` from here.
 *
 * Translation: `label`/`desc`/`typeLabel`/`help` each carry an i18n key
 * alongside their English. Read them through the accessors at the bottom so a
 * caller with no `t` (a pure helper, a test, the canvas summary) still gets
 * sensible English. The canvas SUMMARY lines stay English for now — they
 * interpolate step and field names and need a different treatment.
 */

// `null` in an issue map = a flat, always-visible field (Label, Prompt) with no
// section to open. Re-exported so sectionForIssue.js keeps its own vocabulary.
export const FLAT = null;

/**
 * Runtime types with NO PALETTE ENTRY — nothing in the builder offers them —
 * each with the reason. The completeness test allows exactly these; anything
 * else missing from DiagramPane's NODE_TYPES is a bug.
 *
 * Absent from the palette is not the same as absent from the canvas, and the
 * list has always held both: switch/filter/parse_json are drawn by real
 * components and always were. Not-addable-but-drawable is the normal state
 * here — a type reaches a definition through the AI builder, a template or an
 * import just as readily as through the palette, and the canvas has to be able
 * to draw whatever the engine can run.
 */
export const PALETTE_ABSENT = {
    // Reached by flow/routeModel.js, which swaps the ONE "Condition" node
    // between condition / switch / filter as its editor grows from a single
    // rule to many, or starts working through a list. Deliberately not
    // separately addable — they are the same node to the user. The palette's
    // "Filter a list" (BFSF-485) drops a `filter`, but as the Condition node
    // already in list mode, with words of its own and the Condition's name.
    switch: 'runtime shape of the Condition node (many rules)',
    filter: 'runtime shape of the Condition node (works through a list); "Filter a list" adds one under the Condition name',
    // Retired from the palette; its ability moved into Edit data. Existing
    // steps still load, render and run.
    parse_json: 'retired — absorbed by Edit data',
    // Engine + validator have always supported this one; the palette still does
    // not offer it, because there is no editor for building `branches` (an
    // inline Step[][]) by hand — added from the palette it would be an empty
    // shell the user could not fill, and `parallel.branches_missing` would
    // light up the moment it landed. It DOES have a canvas component now
    // (nodes/ParallelNode.jsx), so a definition that carries one — from the AI
    // builder, from the `nc-onboarding` template, from an import — draws a
    // proper card instead of a bare React Flow default node. See WS7.
    parallel: 'engine-only; drawn on the canvas, but nothing builds `branches` yet',
};

/**
 * Node types the CANVAS draws that are not steps at all: they exist only in the
 * flat pseudo-graph an expanded container produces (flow/inlineFlowlets.js) and
 * are stripped again before anything is saved.
 *
 * They have a `typeLabel` and `help` — the user sees them and can hover them —
 * but no `defaultLabel` (nothing adds one), no editor sections and no
 * validation, because no validation record can ever name them. The completeness
 * test exempts exactly this list from those three requirements, so a real step
 * type still cannot slip through half-described.
 */
export const SYNTHETIC_TYPES = {
    loop_item: 'the "Each item" pill at the head of an expanded loop; never part of a definition',
    ai_tool: 'one tool chip under an AI step, drawn from its tools[] array; never a step of its own',
    row_label: 'the "Row n · steps a–b" gutter label above a wrapped row, derived from positions; never saved',
    ghost_step: 'the dashed "next step" slot ahead of the AI\'s frontier while it builds, placed where the next card will land; never saved',
};

const K = 'automations.node';

/**
 * @typedef {object} NodeDef
 * @property {string}   typeLabel     what KIND of node this is (editor header)
 * @property {string}   defaultLabel  the name a freshly dropped node gets
 * @property {string}   label         how the palette invites you to pick it
 * @property {string}   desc          the one-line palette description
 * @property {string}   help          "what does this node do?", 1-2 sentences
 * @property {string[]} sectionKeys   accordion sections this type's editor renders
 * @property {string[]} [simpleSections] the subset shown in Simple mode — the
 *                      sections that make this step type WORK. Every entry must
 *                      also appear in sectionKeys. Omitted (approval, parallel,
 *                      anything new): Simple falls back to the global
 *                      ADVANCED_SECTION_KEYS rule in formDensity.js — a
 *                      documented default, not an omission. Sections holding a
 *                      validation error, or already configured (hasContent),
 *                      are shown regardless.
 * @property {object}   issueSections {fallback, map} — validation path → section
 */
export const NODE_DEFS = {
    // ── Triggers ────────────────────────────────────────────────────────────
    // The trigger's label/desc/typeLabel are per-KIND, not per-type, and live
    // in flow/triggerLabels.js; only the issue map belongs here.
    trigger: {
        family: 'trigger',
        typeLabel: 'Trigger', defaultLabel: 'Trigger',
        help: 'What starts this automation. Every automation has exactly one.',
        sectionKeys: ['inputs', 'config'],
        simpleSections: ['inputs', 'config'],
        issueSections: {
            fallback: 'config',
            // All the kind-specific forms — schedule builder, app-event picker,
            // webhook panel, form editor — live in the ONE 'config' section.
            // This map used to name phantom sections 'event' and 'schedule':
            // 'event' was papered over by an extra check on the section itself,
            // and 'schedule' by nothing at all, so a bad cron reported an error
            // and left the schedule builder collapsed.
            map: { label: FLAT, kind: FLAT, params: 'config', appEvent: 'config', scheduleCron: 'config', scheduleTz: 'config' },
        },
    },

    // ── AI + apps ───────────────────────────────────────────────────────────
    ai_step: {
        family: 'ai',
        typeLabel: 'AI step', defaultLabel: 'AI step',
        label: 'AI step', desc: 'Reason and call tools with AI',
        help: 'Hands the run to an AI model with your instructions, and passes on what it produces.',
        // 'agent' (R2) is in simpleSections on purpose: it is where a step is
        // handed to an agent, and a section Simple mode leaves out is a feature
        // half the users cannot reach at all.
        sectionKeys: ['agent', 'inputs', 'advanced', 'output'],
        simpleSections: ['agent', 'inputs'],
        issueSections: {
            fallback: 'advanced',
            map: {
                label: FLAT, prompt: FLAT,
                systemPrompt: 'advanced', model: 'advanced', modelTier: 'advanced', allowTools: 'advanced', useMemory: 'advanced',
                inputs: 'inputs', outputFields: 'output', forEach: 'advanced',
                // An agent error (`ai_step.agent_unavailable`) must open the
                // section that holds the picker, not Advanced — the fallback
                // would have sent the author to a section with no agent in it.
                agentId: 'agent', skillIds: 'agent', agentPermissions: 'agent',
            },
        },
    },
    // Extraction is not a chat: it runs on ONE small model the admin sets
    // (`data_extraction_model`), thinking off, against a schema it cannot
    // wander from — so it is its own type rather than an ai_step preset. The
    // declared `fields` ARE its output shape (mapping/upstream.js reads them),
    // which is why there is no structured-output section here.
    data_extraction: {
        family: 'ai',
        typeLabel: 'Extract data', defaultLabel: 'Extract data',
        label: 'Extract data', desc: 'Pull named fields out of text — an invoice, an e-mail, a PDF',
        help: 'Reads a piece of text an earlier step produced and pulls out the fields you name — a date, an amount, a customer — as one tidy record the next steps can use.',
        sectionKeys: ['source', 'fields', 'instructions', 'advanced'],
        simpleSections: ['source', 'fields', 'instructions'],
        issueSections: {
            fallback: 'fields',
            map: { label: FLAT, source: 'source', fields: 'fields', instructions: 'instructions', forEach: 'advanced' },
        },
    },
    integration_action: {
        family: 'app',
        typeLabel: 'Action', defaultLabel: 'Integration',
        help: 'Does one thing in a connected app — send the email, create the file, update the row.',
        sectionKeys: ['basics', 'inputs', 'advanced'],
        simpleSections: ['basics', 'inputs'],
        issueSections: {
            fallback: 'basics',
            map: { label: FLAT, tool: 'basics', operation: 'basics', inputs: 'inputs', forEach: 'advanced' },
        },
    },

    // ── Flow control ────────────────────────────────────────────────────────
    // condition / switch / filter share ONE editor and one section layout —
    // see PALETTE_ABSENT above.
    condition: {
        family: 'branch',
        typeLabel: 'Condition', defaultLabel: 'Condition',
        label: 'Condition', desc: 'Keep, split or branch — one rule or many',
        help: 'Asks a yes/no question about your data and sends the run out of the matching side.',
        sectionKeys: ['rules', 'advanced'],
        simpleSections: ['rules'],
        issueSections: {
            fallback: 'rules',
            map: { label: FLAT, expr: 'rules', cases: 'rules', arrayRef: 'advanced', maxItems: 'advanced', defaultBranch: 'advanced' },
        },
    },
    switch: {
        family: 'branch',
        typeLabel: 'Condition', defaultLabel: 'Condition',
        help: 'Asks a yes/no question about your data and sends the run out of the matching side.',
        sectionKeys: ['rules', 'advanced'],
        simpleSections: ['rules'],
        issueSections: {
            fallback: 'rules',
            // arrayRef/maxItems used to map to a section called 'source' that
            // RouteFields never rendered, so the error opened the Rules section
            // while the Source-list control sat in a still-collapsed Advanced.
            // `matchMode` (BFSF-356 fan-out) lives in Advanced with them: an
            // invalid value must force open the section that holds its control,
            // not the Rules list where it cannot be corrected.
            map: { label: FLAT, expr: 'rules', cases: 'rules', arrayRef: 'advanced', maxItems: 'advanced', defaultBranch: 'advanced', matchMode: 'advanced' },
        },
    },
    filter: {
        family: 'branch',
        typeLabel: 'Condition', defaultLabel: 'Condition',
        help: 'Asks a yes/no question about your data and sends the run out of the matching side.',
        sectionKeys: ['rules', 'advanced'],
        simpleSections: ['rules'],
        issueSections: {
            fallback: 'rules',
            map: { label: FLAT, expr: 'rules', arrayRef: 'advanced', maxItems: 'advanced' },
        },
    },
    loop: {
        family: 'loop',
        typeLabel: 'Repeat', defaultLabel: 'Repeat for each',
        label: 'Repeat for each', desc: 'Run the steps inside once for every item in a list',
        help: 'Takes a list and runs the steps inside it once per item. Each item is available to those steps as loop.item.',
        sectionKeys: ['loop', 'body'],
        simpleSections: ['loop', 'body'],
        issueSections: {
            fallback: 'loop',
            map: { label: FLAT, overRef: 'loop', itemVar: 'loop', maxIterations: 'loop', batchSize: 'loop', body: 'body' },
        },
    },
    wait: {
        family: 'pause',
        typeLabel: 'Wait', defaultLabel: 'Wait',
        label: 'Wait', desc: 'Pause before the next step — seconds, minutes or hours',
        help: 'Holds the run here for a set time, then carries on. Up to 24 hours. Other branches run first and finish before the wait starts, but they cannot run during it — two waits happen one after the other, and any slow step still holds up the rest of the run.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: { fallback: 'config', map: { label: FLAT, seconds: 'config' } },
    },
    stop_error: {
        family: 'end',
        typeLabel: 'Stop', defaultLabel: 'Stop with an error',
        label: 'Stop with an error', desc: 'End the run now and record why',
        help: 'Ends the run immediately and records your message as the reason. Nothing after this node ever runs.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: { fallback: 'config', map: { label: FLAT, message: 'config' } },
    },
    // The second `end`-family type that is really TERMINAL (see
    // flow/terminalSteps.js — `layer_output` shares the family and is not).
    return_to_app: {
        family: 'end',
        typeLabel: 'Back to the app', defaultLabel: 'Back to the app',
        label: 'Back to the app', desc: 'End the run and tell the app what to do next',
        help: 'Ends the run and hands the app a message, a screen to open and what to refresh. Nothing after this node ever runs.',
        sectionKeys: ['config', 'advanced'],
        // What the visitor SEES is what makes this step work; the fallback for
        // a return that cannot be carried out is a second-order choice with a
        // safe default, so it sits in Advanced.
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, navigateTo: 'config', toast: 'config', refresh: 'config', onError: 'advanced' },
        },
    },
    notification: {
        family: 'pause',
        typeLabel: 'Notification', defaultLabel: 'Notification',
        label: 'Notification', desc: 'Send a message or alert',
        help: 'Sends a message to you or your team while the run is going — by in-app notification or email.',
        sectionKeys: ['message', 'advanced'],
        simpleSections: ['message'],
        issueSections: {
            fallback: 'message',
            map: { label: FLAT, title: 'message', body: 'message', inputs: 'message', channels: 'message', forEach: 'advanced' },
        },
    },
    form_page: {
        family: 'pause',
        typeLabel: 'Form page', defaultLabel: 'Ask for more info',
        help: 'Pauses the run and shows another page on the automation’s own form link, then continues with the answers.',
        sectionKeys: ['config', 'waiting'],
        simpleSections: ['config', 'waiting'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, mode: 'config', form: 'config', waitSeconds: 'waiting' },
        },
    },

    // ── Privacy ─────────────────────────────────────────────────────────────
    // These three were missing from the editor-header and issue-section maps
    // entirely, which is what this file exists to make impossible.
    guard: {
        family: 'guard',
        typeLabel: 'Personal data check', defaultLabel: 'Find personal data',
        label: 'Find personal data', desc: 'Scan a value and branch on whether it holds personal data',
        help: 'Looks through a value for names, addresses, ID numbers and the like, then sends the run out of the "personal data" or "clean" side.',
        sectionKeys: ['config', 'advanced'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, sourceRef: 'config', onFound: 'config', categories: 'advanced', confidence: 'advanced', forEach: 'advanced' },
        },
    },
    tokenize: {
        family: 'guard',
        typeLabel: 'Hide personal data', defaultLabel: 'Hide personal data',
        label: 'Hide personal data', desc: 'Swap personal data for placeholders; the real values come back on their own',
        help: 'Replaces personal data with placeholders before the value travels on — to an AI model, say. The real values are put back automatically wherever the run uses them again.',
        sectionKeys: ['config', 'advanced'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, sourceRef: 'config', categories: 'advanced', confidence: 'advanced', forEach: 'advanced' },
        },
    },
    untokenize: {
        family: 'guard',
        typeLabel: 'Show real values', defaultLabel: 'Show real values again',
        label: 'Show real values again', desc: 'Put the real values back where a step still holds placeholders',
        help: 'Puts the real values back in place of any placeholders left in a value. Only needed where they did not already come back on their own.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: { fallback: 'config', map: { label: FLAT, sourceRef: 'config' } },
    },

    // ── Data ────────────────────────────────────────────────────────────────
    set: {
        family: 'data',
        typeLabel: 'Edit data', defaultLabel: 'Edit data',
        // "organise", not "organize" — the product spells it anonymise /
        // organisation everywhere else.
        label: 'Edit data', desc: 'Add, rename and organise fields — for one record or a whole table',
        help: 'Builds the exact set of fields the next step needs — adding, renaming and reorganising what came before.',
        sectionKeys: ['fields', 'table', 'advanced'],
        simpleSections: ['fields', 'table'],
        issueSections: {
            fallback: 'fields',
            map: { label: FLAT, fields: 'fields', inputs: 'fields', forEach: 'advanced', arrayRef: 'advanced', maxItems: 'advanced', operations: 'table' },
        },
    },
    datetime: {
        family: 'data',
        typeLabel: 'Date & time', defaultLabel: 'Date & time',
        label: 'Date & time', desc: 'Get today’s date, reformat one, add days, or compare two',
        help: 'Works with dates and times: today’s date, reading one out of text, reformatting it, shifting it, or measuring the gap between two.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, op: 'config', input: 'config', input2: 'config', amount: 'config', format: 'config', part: 'config', unit: 'config' },
        },
    },
    http_request: {
        family: 'app',
        typeLabel: 'Web service call', defaultLabel: 'Call a web service',
        label: 'Call a web service', desc: 'Send a request to a system that has no ready-made action here',
        help: 'Sends a request straight to another system’s web address and passes on what it sends back. For systems with no ready-made action in the Action list. If you let it reuse an answer, a retry after a later failure uses the answer it already has instead of asking again — and a test run neither reuses one nor keeps one.',
        sectionKeys: ['request', 'auth', 'headers', 'body', 'options', 'advanced'],
        simpleSections: ['request', 'auth', 'body'],
        issueSections: {
            fallback: 'request',
            map: { label: FLAT, url: 'request', method: 'request', headers: 'headers', body: 'body', timeoutMs: 'options', blockPrivateTargets: 'options', auth: 'auth', forEach: 'advanced', askOnce: 'advanced' },
        },
    },
    generate_document: {
        family: 'data',
        typeLabel: 'Make a document', defaultLabel: 'Make a document',
        label: 'Make a document', desc: 'Turn text from an earlier step into a PDF or Word file',
        help: 'Takes text an earlier step produced and renders it as a real PDF or Word file, with headings, bold and links intact. Put a Form page after it to offer the file as a download. The file is deleted once its retention window is up.',
        sectionKeys: ['content', 'output', 'options'],
        simpleSections: ['content', 'output'],
        issueSections: {
            fallback: 'content',
            map: {
                label: FLAT,
                content: 'content', contentFormat: 'content',
                format: 'output', title: 'output', fileName: 'output',
                expiresInDays: 'options',
            },
        },
    },
    slide: {
        family: 'data',
        typeLabel: 'Slide', defaultLabel: 'Slide',
        label: 'Slide', desc: 'One slide of a presentation: a title with bullet points, a table, a quote or an image',
        help: 'Builds one slide as a value — no file yet. Give it a title and some content (bullets, a paragraph, a table, a quote), optionally speaker notes, and bind them to earlier steps. Use "one per item" to make a slide for every row of a list, then feed the slides to a Presentation step. Visuals: a chart from data rows, KPI tiles, a timeline of steps, or an accent-coloured emphasis slide.',
        sectionKeys: ['content', 'options'],
        simpleSections: ['content'],
        issueSections: {
            fallback: 'content',
            map: {
                label: FLAT,
                title: 'content', content: 'content', image: 'content', chart: 'content', stats: 'content',
                notes: 'options', layout: 'options', style: 'options', forEach: 'options',
            },
        },
    },
    presentation: {
        family: 'data',
        typeLabel: 'Presentation', defaultLabel: 'Presentation',
        label: 'Presentation', desc: 'Turn slides or a written outline into a PowerPoint (or PDF deck) in your house style',
        help: 'Takes slides — the outline an AI step wrote ("# " title, "## " per slide), a list of Slide steps, or the results of a loop — and builds a real PowerPoint file (or a PDF deck) in your organisation\'s house style. Put a Form page after it to offer the file as a download, or a Nextcloud upload to keep it where it opens in Nextcloud Office. The file is deleted once its retention window is up. Under Look you can set the style, colours, typeface, a logo (or none) and a footer line for this deck only.',
        sectionKeys: ['slides', 'output', 'options'],
        simpleSections: ['slides', 'output'],
        issueSections: {
            fallback: 'slides',
            map: {
                label: FLAT,
                slides: 'slides',
                title: 'output', subtitle: 'output', fileName: 'output', format: 'output',
                houseStyle: 'options', preset: 'options', accent: 'options', background: 'options', font: 'options', titleFont: 'options', coverStyle: 'options', tableStyle: 'options',
                logo: 'options', logoPlacement: 'options', footerText: 'options', slideNumbers: 'options', template: 'options',
                expiresInDays: 'options',
            },
        },
    },
    fill_document: {
        family: 'data',
        typeLabel: 'Fill a document', defaultLabel: 'Fill a document',
        label: 'Fill a document', desc: 'Fill one of your designed documents and keep the PDF',
        help: 'Takes a document you designed in Studio → Documents — an invoice, a quote, a letter on your letterhead — fills its placeholders with values from this run, and keeps the PDF. Use "Make a document" instead when there is no design and the step should lay out text for you.',
        sectionKeys: ['document', 'values', 'output', 'options'],
        simpleSections: ['document', 'values'],
        issueSections: {
            fallback: 'document',
            map: {
                label: FLAT,
                documentId: 'document',
                values: 'values',
                fileName: 'output', saveCopy: 'output', copyName: 'output',
                expiresInDays: 'options',
            },
        },
    },
    parse_json: {
        family: 'data',
        typeLabel: 'Parse JSON', defaultLabel: 'Parse JSON',
        help: 'Pulls named fields out of a block of JSON text. Retired — Edit data does this now.',
        sectionKeys: ['source', 'fields', 'options'],
        simpleSections: ['source', 'fields'],
        issueSections: {
            fallback: 'fields',
            map: { label: FLAT, sourceRef: 'source', itemsRef: 'source', mode: 'fields', fields: 'fields' },
        },
    },
    code: {
        family: 'app',
        typeLabel: 'Code', defaultLabel: 'Code',
        label: 'Code', desc: 'Run custom JavaScript',
        help: 'Runs a snippet of JavaScript in a sandbox and passes on whatever it returns.',
        sectionKeys: ['code', 'advanced'],
        simpleSections: ['code'],
        issueSections: {
            fallback: 'code',
            map: { label: FLAT, code: 'code', language: 'code', forEach: 'advanced' },
        },
    },

    // ── Lists ───────────────────────────────────────────────────────────────
    limit: {
        family: 'data',
        typeLabel: 'Shorten list', defaultLabel: 'Shorten list',
        label: 'Shorten list', desc: 'Keep only the first — or last — few items',
        help: 'Cuts a list down to the first or last few items and passes the shorter list on.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, arrayRef: 'config', count: 'config', mode: 'config', maxItems: 'config' },
        },
    },
    datatable: {
        family: 'data',
        typeLabel: 'Datatable', defaultLabel: 'Datatable',
        label: 'Datatable', desc: 'Keep rows that outlast the run — and share them with other automations',
        help: 'Reads and writes rows in a table that stays put after the run ends, so this automation can pick up where it left off and other automations can use the same data.',
        sectionKeys: ['table', 'match', 'values', 'advanced'],
        simpleSections: ['table', 'match', 'values'],
        issueSections: {
            fallback: 'table',
            map: {
                label: FLAT,
                datatableId: 'table', op: 'table',
                where: 'match', matchColumn: 'match', sort: 'match', limit: 'match',
                values: 'values',
                forEach: 'advanced',
            },
        },
    },
    knowledge_write: {
        family: 'data',
        typeLabel: 'To knowledge base', defaultLabel: 'To knowledge base',
        label: 'To knowledge base', desc: 'Save text where an agent can find it later',
        help: 'Stores text in a knowledge base, so your agents can answer from it afterwards — a resolved ticket as an article, a meeting\'s decisions, last night\'s summary. Give it a source reference and each run replaces its own entry instead of leaving a new one behind.',
        sectionKeys: ['destination', 'content', 'advanced'],
        simpleSections: ['destination', 'content'],
        issueSections: {
            fallback: 'content',
            map: {
                label: FLAT,
                knowledgeBaseId: 'destination',
                content: 'content', title: 'content', sourceUri: 'content',
                nearDuplicateStrategy: 'advanced', forEach: 'advanced',
            },
        },
    },
    dedupe: {
        family: 'data',
        typeLabel: 'Remove duplicates', defaultLabel: 'Remove duplicates',
        label: 'Remove duplicates', desc: 'Keep one of each — matching the whole item, or one field',
        help: 'Keeps one of each item and drops the repeats. Match on one field, or on the whole item.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, arrayRef: 'config', field: 'config', keyField: 'config', maxItems: 'config' },
        },
    },
    aggregate: {
        family: 'data',
        typeLabel: 'Collect one field', defaultLabel: 'Collect one field',
        label: 'Collect one field', desc: 'Take the same field from every item — every email address, say',
        help: 'Reads one field from every item in a list and hands back a plain list of just those values.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, arrayRef: 'config', field: 'config', maxItems: 'config' },
        },
    },
    summarize: {
        family: 'data',
        typeLabel: 'Add up or count', defaultLabel: 'Add up or count',
        label: 'Add up or count', desc: 'Total, count, average, lowest or highest — across one field',
        help: 'Turns a list into a single number: the total, the count, the average, or the lowest or highest value of one field.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, arrayRef: 'config', field: 'config', op: 'config', maxItems: 'config' },
        },
    },

    // ── Canvas annotations ──────────────────────────────────────────────────
    note: {
        family: null,
        typeLabel: 'Note', defaultLabel: 'Note',
        label: 'Note', desc: 'A sticky note for context — never runs',
        help: 'A free-floating annotation you can drop anywhere on the canvas to explain why a branch exists or leave a to-do. It never runs and is never wired to anything else.',
        sectionKeys: ['content'],
        simpleSections: ['content'],
        issueSections: {
            fallback: 'content',
            map: { label: FLAT, text: 'content', color: 'content', size: 'content' },
        },
    },

    // ── Flowlets and reusable Steps ─────────────────────────────────────────
    call_layer: {
        family: 'loop',
        typeLabel: 'Flowlet', defaultLabel: 'Flowlet',
        help: 'Runs a group of steps you built once and can reuse, then carries on with what it returns.',
        sectionKeys: ['flowlet', 'inputs', 'returns'],
        simpleSections: ['flowlet', 'inputs', 'returns'],
        issueSections: {
            fallback: 'inputs',
            map: { label: FLAT, layerKey: 'flowlet', layerId: 'flowlet', inputs: 'inputs' },
        },
    },
    call_block: {
        family: 'app',
        typeLabel: 'Step', defaultLabel: 'Step',
        help: 'Runs a reusable Step from your library, then carries on with what it returns.',
        // Had no issue map at all, so a bad input binding opened nothing.
        sectionKeys: ['step', 'inputs', 'returns'],
        simpleSections: ['step', 'inputs', 'returns'],
        issueSections: {
            fallback: 'inputs',
            map: { label: FLAT, blockId: 'step', inputs: 'inputs' },
        },
    },
    layer_output: {
        family: 'end',
        typeLabel: 'Return', defaultLabel: 'Return',
        label: 'Flowlet output', desc: 'Return data from this flowlet to its caller',
        help: 'Ends a flowlet and hands the fields you name back to whatever called it.',
        sectionKeys: ['fields'],
        simpleSections: ['fields'],
        issueSections: { fallback: 'fields', map: { label: FLAT, fields: 'fields' } },
    },

    // ── Approval + parallel ─────────────────────────────────────────────────
    // Both sat here as engine-only once. Approval has since grown a palette
    // entry and a real editor; parallel is drawn on the canvas now but still
    // is not addable — see PALETTE_ABSENT for why.
    approval: {
        family: 'pause',
        typeLabel: 'Approval', defaultLabel: 'Approval',
        label: 'Ask someone to approve',
        desc: 'Pause the run until a person approves or rejects it',
        help: 'Pauses the run and asks a person to approve or reject it. Approve and the run carries on from the next step; reject and the run stops here.',
        // 'waiting' rather than 'advanced' for the deadline, for the same
        // reason the form page keeps its wait out of Advanced: how long a
        // automation holds a real person's decision open is a first-class
        // choice, and hiding it behind the density filter is how an approval
        // silently expires over a holiday.
        sectionKeys: ['config', 'waiting'],
        simpleSections: ['config', 'waiting'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, prompt: 'config', approval: 'waiting', forEach: 'waiting' },
        },
    },
    parallel: {
        family: 'branch',
        typeLabel: 'Parallel', defaultLabel: 'Parallel',
        help: 'Runs several branches at the same time and continues once they have all finished.',
        sectionKeys: ['config'],
        issueSections: { fallback: 'config', map: { label: FLAT, branches: 'config' } },
    },

    // ── Canvas-only (see SYNTHETIC_TYPES) ───────────────────────────────────
    loop_item: {
        family: 'loop',
        typeLabel: 'Each item',
        help: 'Where every step inside the loop starts. One item of the list at a time, available to those steps as loop.item.',
    },
    ai_tool: {
        family: 'ai',
        typeLabel: 'Tool',
        help: 'Something the AI step above is allowed to use on its own — it decides whether to, and with what.',
    },
    row_label: {
        family: null,
        typeLabel: 'Row',
        help: 'The label above a row of a wrapped canvas, naming the row and the steps it holds. Drawn from where the cards sit; it is not a step and is never saved.',
    },
    ghost_step: {
        family: null,
        typeLabel: 'Next step',
        help: 'Where the assistant\'s next step will land while it is building, with a line on what it is working on. It is not a step and is never saved.',
    },
};

/** Every runtime step type this app knows how to present. */
export const NODE_TYPE_KEYS = Object.keys(NODE_DEFS);

// ── Accessors ───────────────────────────────────────────────────────────────
// Each takes an optional `t`. Without one they answer in English, so pure
// helpers, tests and the canvas keep working outside a React tree.

const read = (type, field, t) => {
    const def = NODE_DEFS[type];
    if (!def) return '';
    const english = def[field];
    if (!english) return '';
    return t ? t(`${K}.${type}.${field}`, english) : english;
};

/** What KIND of node this is — the node editor's heading. */
export function nodeTypeLabel(type, t = null) {
    return read(type, 'typeLabel', t);
}

/** The name a freshly dropped node of this type gets. */
export function nodeDefaultLabel(type, t = null) {
    return read(type, 'defaultLabel', t);
}

/** One or two plain sentences: what does this node do? */
export function nodeHelp(type, t = null) {
    return read(type, 'help', t);
}

/** The palette's invitation to pick this node (absent for types you can't add). */
export function nodeLabel(type, t = null) {
    return read(type, 'label', t);
}

/** The palette's one-line description. */
export function nodeDesc(type, t = null) {
    return read(type, 'desc', t);
}

// ── Step-type families (visual identity) ────────────────────────────────────
/**
 * The nine visual families the builder redesign paints a step with — the
 * 4px bar and the icon tile on a card, the palette command, the legend, the
 * minimap. Order matters nowhere; the list exists so tests can prove every
 * family is used and every type names one. The colour for a family is the
 * CSS custom property `--type-<family>` (src/index.css); the recipes that
 * turn a family into styles live in flow/nodeTypeColors.js, which imports
 * from here and nothing else in flow/.
 */
export const NODE_FAMILIES = ['trigger', 'ai', 'app', 'branch', 'loop', 'data', 'pause', 'guard', 'end'];

/**
 * Types with `family: null` — drawn on the canvas, but not as a step card,
 * with the reason. The completeness test allows exactly these.
 */
export const FAMILY_EXEMPT = {
    note: 'a movable annotation with its own colour swatches (NoteNode.jsx), not a step card',
    row_label: 'a gutter label above a wrapped row (RowLabelNode.jsx), not a step card',
    ghost_step: 'the dashed next-step slot ahead of the build frontier (GhostStepNode.jsx), not a step card',
};

/** The visual family of a runtime step type — or null for an exempt type / an unknown one. */
export function stepFamily(type) {
    const def = NODE_DEFS[type];
    if (!def) return null;
    return def.family ?? null;
}
