// @typecheck strict
'use strict';
/**
 * "## What you can build": every step a person can put on the canvas, in the
 * ribbon's groups and the palette's words, with the runtime type in brackets.
 *
 * Both builder prompts open with it, right after the role line, so the model
 * knows the whole vocabulary before any rule about it and talks to the user in
 * the names the user sees ("Ask someone to approve", not `approval`). It is
 * rendered from builderTools/stepTypeTable.js (`family`, `userLabel`,
 * `authoring`), so a step type the builder can author is never missing from a
 * band, and a canvas-only one is listed as such. builderPrompt.menuCoverage.test.js
 * pins that every batch type is named in every prompt variant.
 *
 * Two variants:
 *   full     the frontier prompt: one line per type, when to reach for it. The
 *            per-type tools and the step menu further down carry the fields.
 *   compact  the lean prompt (small and reasoning bands): the same line plus the
 *            spec keys of a builder_add_steps entry, because on the small menu
 *            most types have no single-step tool whose schema would teach them.
 *
 * Static text for a given (variant, codeStepEnabled, leanMenu): it sits in the
 * system prompt, the front of the prompt cache.
 */

const { STEP_TYPE_TABLE } = require('../builderTools/stepTypeTable');

/** The ribbon's groups, in tab order (agent-hub flow/ribbon/ribbonCategories.ts CATEGORY_DEFS). */
const FAMILIES = Object.freeze([
    { id: 'start', heading: 'How it starts' },
    { id: 'ai', heading: 'AI' },
    { id: 'logic', heading: 'Logic' },
    { id: 'people', heading: 'People' },
    { id: 'data', heading: 'Data & documents' },
    { id: 'apps', heading: 'Apps' },
    { id: 'blocks', heading: 'My building blocks' },
]);

/**
 * When to reach for each type. Key order is the order inside a group: the
 * ribbon's rows (flow/ribbon/ribbonRows.ts TAB_ROWS), the types the ribbon does
 * not show (switch, parallel) beside their sibling.
 * @type {Readonly<Record<string, string>>}
 */
const WHEN = Object.freeze({
    trigger: 'what starts a run: a form, a schedule, a button, a webhook, an event in a connected app, an AI agent or a Studio App.',
    ai_step: 'judgement and writing: classify, summarise, decide, draft a reply.',
    data_extraction: 'named, typed fields out of text (an invoice, an e-mail, a PDF). Not an AI step.',
    condition: 'one yes/no question for the whole run; then or else.',
    switch: 'one question with several named answers (cases), a route for each.',
    parallel: 'branches drawn side by side.',
    loop: 'several steps once per item of a list. For ONE step per item, use forEach on that step.',
    code: 'your own JavaScript: the last resort, after an app action and the steps here.',
    http_request: 'a request to a URL or API that has no ready-made app action.',
    guard: 'scan a value for personal data and branch: then = found, else = clean.',
    tokenize: 'swap personal data for placeholders before an AI step; the real values come back by themselves.',
    untokenize: 'put the real values back on purpose, where a value kept its placeholders.',
    stop_error: 'end the run now, with a message saying why.',
    return_to_app: 'end a run a Studio App started and tell the app what to show.',
    note: 'a sticky note that explains something on the canvas; it never runs.',
    approval: 'pause until a person approves or rejects.',
    notification: 'an in-app message or alert to the user.',
    wait: 'pause for some seconds, minutes or hours.',
    form_page: 'another page of the automation\'s own form: ask for more, or the closing page. Only with a form start.',
    set: 'add, rename and organise fields, for one record or a whole list. Free at run time.',
    datetime: 'today\'s date, reformat a date, add days, compare two dates.',
    datatable: 'rows that outlast the run and that other automations can read.',
    knowledge_write: 'save text where an agent can find and cite it later.',
    kb_query_log: 'read what people asked a knowledge base, or mark an entry as reviewed (Enterprise).',
    read_table: 'open an uploaded spreadsheet or CSV as tables, one per sheet.',
    table: 'join, filter, calculate, group or summarise a table, step by step.',
    generate_document: 'turn text into a PDF or Word file.',
    fill_document: 'fill one of the user\'s designed documents (an invoice, a quote, a letter) and keep the PDF.',
    slide: 'one slide as data, for a presentation built from rows.',
    presentation: 'a PowerPoint or PDF deck in the house style.',
    array_op: 'one entry for the six list operations below, picked by `op`.',
    filter: 'keep only the items of a list that match.',
    flatten: 'one row per item of a list inside each item (an attachment with its e-mail\'s details).',
    limit: 'keep the first or last few items.',
    dedupe: 'keep one of each.',
    aggregate: 'the same field from every item, as one list.',
    summarize: 'total, count, average, lowest or highest of one field.',
    integration_action: 'one thing in a connected app: send the mail, create the file, update the row. The connected apps are in the catalog.',
    call_layer: 'run a flowlet: a named group of steps inside this automation, built once and used again.',
    layer_output: 'what a flowlet hands back to the step that ran it.',
    call_block: 'a reusable Step this workspace built; its inputs and outputs are in the Building blocks list.',
});

/**
 * The spec keys of a builder_add_steps entry, for the compact variant (`?` =
 * optional). Each one is a property of the matching single-step tool, or of the
 * batch spec text for the types that have none (stepFamilies.test.js).
 * @type {Readonly<Record<string, string>>}
 */
const SPEC = Object.freeze({
    integration_action: 'tool, inputs',
    ai_step: 'prompt, systemPrompt?, inputs, outputSchema',
    data_extraction: 'source, fields',
    condition: 'expr',
    switch: 'expr, cases',
    loop: 'overRef, itemVar, body',
    code: 'code, inputs',
    http_request: 'url, method, headers?, body?, query?',
    guard: 'sourceRef: a path string',
    tokenize: 'sourceRef: a path string',
    untokenize: 'sourceRef: a path string',
    stop_error: 'message',
    approval: 'prompt, assignee?',
    notification: 'title, body',
    wait: 'seconds',
    form_page: 'mode, form',
    set: 'fields, arrayRef?',
    datetime: 'op, input, amount?, format?, unit?',
    datatable: 'op, datatableId, datatableKey, values | where',
    knowledge_write: 'knowledgeBaseId, content, title, sourceUri',
    kb_query_log: 'op, knowledgeBaseId, filters? | entryId, status, note?',
    read_table: 'source',
    table: 'source, ops',
    generate_document: 'content, format?, title?',
    fill_document: 'documentId, values',
    slide: 'title, content',
    presentation: 'slides, title?',
    array_op: 'op, arrayRef',
    filter: 'arrayRef, expr',
    flatten: 'arrayRef, childField',
    limit: 'arrayRef, count',
    dedupe: 'arrayRef, keyField?',
    aggregate: 'arrayRef, field',
    summarize: 'arrayRef, field, op',
    call_layer: 'layerKey, inputs',
    call_block: 'blockId, inputs',
});

/** Types the lean tool menu has no way to create (it lacks builder_add_note and the flowlet tools). */
const NOT_ON_LEAN_MENU = new Set(['note', 'layer_output']);

/** @typedef {{ variant?: 'full' | 'compact', codeStepEnabled?: boolean, leanMenu?: boolean }} RenderOptions */

/**
 * @param {import('../builderTools/stepTypeTable').StepTypeEntry} entry
 * @param {Required<RenderOptions>} opts
 */
function lineFor(entry, { variant, codeStepEnabled, leanMenu }) {
    const head = `- ${entry.userLabel} [${entry.type}] — `;
    if (entry.authoring === 'canvas_only') {
        return variant === 'full'
            ? `${head}canvas only: you cannot add it (see CANVAS-ONLY below).`
            : `${head}canvas only: you cannot add it. In a draft: ${entry.behaviour}`;
    }
    if (entry.type === 'code' && !codeStepEnabled) return `${head}switched off on this server; never propose it.`;
    const when = WHEN[entry.type];
    if (leanMenu && NOT_ON_LEAN_MENU.has(entry.type)) return `${head}${when} Not on your tool menu.`;
    const spec = variant === 'compact' && entry.authoring === 'batch' && SPEC[entry.type] ? ` Spec {${SPEC[entry.type]}}` : '';
    return `${head}${when}${spec}`;
}

/**
 * The rendered block, without a trailing newline.
 * @param {RenderOptions} [options]
 * @returns {string}
 */
function renderWhatYouCanBuild({ variant = 'full', codeStepEnabled = false, leanMenu = false } = {}) {
    const opts = { variant, codeStepEnabled, leanMenu };
    const byType = new Map(STEP_TYPE_TABLE.map((e) => [e.type, e]));
    const groups = FAMILIES.map(({ id, heading }) => {
        const lines = Object.keys(WHEN)
            .map((type) => byType.get(type))
            .filter((e) => e && e.family === id)
            .map((e) => lineFor(/** @type {import('../builderTools/stepTypeTable').StepTypeEntry} */ (e), opts));
        return `### ${heading}\n${lines.join('\n')}`;
    });
    const intro = 'Every step the user can put on the canvas, grouped as the canvas groups them. Talk to the user in these names; the [type] is what goes in your tool calls.';
    const tail = leanMenu
        ? '\n\nNot on your tool menu: a new flowlet, a second trigger and a note. If the request needs one, build everything else, then say in ONE sentence of your summary what the user adds on the canvas. Never claim a step you could not create.'
        : '';
    return `## What you can build\n\n${intro}\n\n${groups.join('\n\n')}${tail}`;
}

module.exports = { renderWhatYouCanBuild, FAMILIES, WHEN, SPEC, NOT_ON_LEAN_MENU };
