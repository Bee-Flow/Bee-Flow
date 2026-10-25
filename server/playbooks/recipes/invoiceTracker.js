// @typecheck noImplicitAny
/**
 * Playbook recipe `invoice_tracker` — read an invoice folder, load a table,
 * build an invoice app with approvals. PURE: the schema, the phase list, the
 * column-role mapping for an existing table, and the three briefs the two AI
 * builders receive, one per phase.
 *
 * The briefs are the heart of it. Each is ≤ MAX_BRIEF_CHARS, written in the
 * tool vocabulary the builders understand best (English), asks for labels in
 * the DEMO'S LANGUAGE, and names ONLY real things: the table's name, id and
 * column keys as the `table` phase reported them, the folder the user typed,
 * the owner's id for the approval stage. A brief never carries a placeholder
 * id — the small local model copies what it reads, and a tbl_… it invents is
 * the loop the 2026-09-13 trace showed. Context size follows from the same
 * rule: a phase starts a fresh builder session with one short brief; nothing
 * of a previous phase's transcript crosses over.
 *
 * The demo's language is the interface language the playbook was started in
 * (`options.locale`, Dutch or English — see playbooks/copy.js). It decides
 * the table's column names and keys, the automation and app titles, the screen
 * names, the status values and the labels the builders are asked for, so an
 * English workspace never watches a Dutch app being built. The ROLES below
 * are the constant in between: a brief always addresses a table by the keys
 * that table really has.
 *
 * Every brief exists twice over — as the function the lifecycle calls and as
 * the {{placeholder}} template of the recipe DOCUMENT — and both come out of
 * ONE writer (`automationText`/`appText`/`approvalsText` with a `vocabulary`),
 * so a change can never land in one and not the other.
 */

'use strict';

const { keyFromTitle } = require('../../core/dataEngine/sources/mirror/keys');
const { verifyAgainstRoles } = require('../recipeDoc');
const { packLocale } = require('../copy');
const { RECIPE_ID, BRIEF_VERSION, MAX_BRIEF_CHARS, PHASE_KEYS, PHASE_SHAPE, ROLES, REQUIRED_ROLES, ROLE_ORDER, PACKS, packFor, localeOf } = require('./invoiceTrackerPackFor');

/**
 * The table's columns in a language: what the `table` phase creates.
 * @param {string} locale
 */
function schemaFor(locale) {
    return packFor(locale).fields.map(({ role, ...f }) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) }));
}

const INVOICE_SCHEMA = Object.freeze(schemaFor('nl').map((f) => Object.freeze(f)));

/**
 * Map a table's fields onto the roles. Match by key first, then by the slug
 * of the title. `ok` when every required role is present.
 * @param {Array<{key:string,name?:string,type?:string}>} fields
 */
function verifyExistingTable(fields) {
    return verifyAgainstRoles(fields, ROLES);
}

/**
 * The mapping a NEW table gets — role → the key that language gives it.
 * @param {string} locale
 */
function schemaMapping(locale) {
    /** @type {Record<string, string>} */
    const mapping = {};
    for (const f of packFor(locale).fields) mapping[f.role] = f.key;
    return mapping;
}

/**
 * @param {string|null|undefined} title
 * @param {Set<string>|string[]|null|undefined} usedKeys
 * @param {string} locale
 */
function defaultTableKey(title, usedKeys, locale) {
    return keyFromTitle(String(title || packFor(locale).tableTitle), 0, usedKeys instanceof Set ? usedKeys : new Set(usedKeys || []));
}

/**
 * The ordered phase list for a fresh playbook.
 * @param {Parameters<typeof localeOf>[0]} [options]
 * @param {{ approvalsAllowed?: boolean }} [opts]
 */
function phasesFor(options = {}, { approvalsAllowed = false } = {}) {
    const pack = packFor(localeOf(options));
    return PHASE_SHAPE.map(({ key, kind, requires, requiresRole }) => ({
        key,
        kind,
        label: pack.phaseLabels[key],
        ...(requires ? { requires } : {}),
        ...(requiresRole ? { requiresRole } : {}),
        ...(kind === 'design' ? { goal: pack.designGoal } : {}),
        status: key === 'table' ? 'ready' : (key === 'approvals' && !approvalsAllowed ? 'locked' : 'pending'),
        startedAt: /** @type {string|null} */ (null),
        finishedAt: /** @type {string|null} */ (null),
        brief: /** @type {string|null} */ (null),
        briefVersion: BRIEF_VERSION,
        briefEdited: false,
        attempt: 0,
        artifacts: {},
        summary: /** @type {string|null} */ (null),
        error: /** @type {string|null} */ (null),
    }));
}

/**
 * @param {string} text
 * @param {string} what
 */
function assertLength(text, what) {
    if (text.length > MAX_BRIEF_CHARS) throw new Error(`${what} brief is ${text.length} chars — over the ${MAX_BRIEF_CHARS} cap`);
    return text;
}

// ── one writer, two readings ───────────────────────────────────────────────

/** @typedef {{ id: string, name: string, key: string, mapping: Record<string, string>, isMirror?: boolean, hasStatus?: boolean }} BriefTable */
/** @typedef {typeof PACKS[keyof typeof PACKS]} Pack */
/**
 * @typedef {{ f: (role: string) => string, name: string, id: string, key: string, folder: string, title: string, approver: string,
 *   when: (path: string, fn: () => string) => string }} Vocabulary
 */

/**
 * The words a brief writer plugs the real world into. `render` fills in a
 * table's actual keys and ids; `template` writes the document's placeholders.
 * `when(path, fn)` is the single conditional: a real test in render mode,
 * `{{#if path}}…{{/if}}` in template mode.
 * @param {string} mode
 * @param {{ table?: BriefTable|null, folderPath?: string, title?: string, approver?: { userId?: string, groupId?: string }|null }} [opts]
 * @returns {Vocabulary}
 */
function vocabulary(mode, { table = null, folderPath = '', title = '', approver = null } = {}) {
    if (mode === 'template') {
        return {
            f: (/** @type {string} */ role) => `{{field.${role}}}`,
            name: '{{table.name}}', id: '{{table.id}}', key: '{{table.key}}',
            folder: '{{input.folderPath}}', title: '{{title}}', approver: '{{approver}}',
            when: (/** @type {string} */ path, /** @type {() => string} */ fn) => `{{#if ${path}}}${fn()}{{/if}}`,
        };
    }
    const m = /** @type {Record<string, string>} */ ((table && table.mapping) || {});
    /** @param {string} path */
    const truth = (path) => (path === 'table.isMirror' ? !!(table && table.isMirror) : !!m[path.replace(/^field\./, '')]);
    return {
        f: (/** @type {string} */ role) => m[role],
        name: table ? table.name : '', id: table ? table.id : '', key: table ? table.key : '',
        folder: folderPath, title,
        approver: approver && approver.groupId ? `{groupId:"${approver.groupId}"}` : `{userId:"${(approver && approver.userId) || ''}"}`,
        when: (/** @type {string} */ path, /** @type {() => string} */ fn) => (truth(path) ? fn() : ''),
    };
}

/**
 * Phase `automation`: the manual-trigger automation that fills the table.
 * @param {Vocabulary} v
 * @param {Pack} pack
 * @param {string} title
 */
function automationText(v, pack, title) {
    return [
        '## Build an automation',
        'I start it by hand: manual trigger, no schedule, no file event.',
        '',
        `1. \`nextcloud_list_files\` on folder "${v.folder}".`,
        '2. `nextcloud_read_file` for each item of step 1 (forEach over its items, path = the item\'s path).',
        `3. \`data_extraction\` for each result of step 2 on its content, with exactly these fields: ${v.f('datum')} (date), ${v.f('leverancier')} (string), ${v.f('factuurnummer')} (string), ${v.f('excl_btw')} (number), ${v.when('field.btw', () => `${v.f('btw')} (number), `)}${v.f('totaal')} (number).`,
        `4. \`datatable add_row\` for each result of step 3 into the EXISTING datatable **"${v.name}"** (id \`${v.id}\`, key \`${v.key}\`)${v.when('table.isMirror', () => ' — a Nextcloud Tables mirror; rows go to Nextcloud')}. Map the fields by column key${v.when('field.status', () => ` and set ${v.f('status')} to the literal "${pack.status.open}"`)}.`,
        '',
        `**Rules:** do not create a table or columns. Dates as 2026-09-19; amounts as plain numbers with a dot (1554.25). Keep file order. Title "${title}".`,
    ].join('\n');
}

/**
 * Phase `app`: the read-only invoice app on the table.
 * @param {Vocabulary} v
 * @param {Pack} pack
 */
function appText(v, pack) {
    const grid = [
        `${v.f('datum')}, ${v.f('leverancier')}, ${v.f('factuurnummer')}, ${v.f('excl_btw')}`,
        v.when('field.btw', () => `, ${v.f('btw')}`),
        `, ${v.f('totaal')}`,
        v.when('field.status', () => `, ${v.f('status')}`),
    ].join('');
    return [
        `## Build a professional ${pack.language} invoice app`,
        `It runs on my EXISTING Studio table **"${v.name}"** (key \`${v.key}\`; read only — an automation fills it from PDF invoices).`,
        '',
        `**Start with:** \`app_set_plan\`, then \`app_link_datatable {datatableId:"${v.id}"}\` and use the \`tbl_\` id it returns. Never \`app_upsert_table\` or \`app_seed_records\`.`,
        '',
        `### Screen "${pack.screens.overview}"`,
        `- Stat tiles: ${pack.tiles.count} (count), ${pack.tiles.excl} (sum ${v.f('excl_btw')})${v.when('field.btw', () => `, ${pack.tiles.vat} (sum ${v.f('btw')})`)}, ${pack.tiles.total} (sum ${v.f('totaal')}).`,
        `- A \`chart\` of ${v.f('totaal')} per month over ${v.f('datum')}.`,
        `- A \`filter_bar\` on ${v.f('leverancier')}, ${v.f('datum')}${v.when('field.status', () => `, ${v.f('status')}`)}.`,
        `- A \`data_grid\` with ${grid}.`,
        '',
        `### Screen "${pack.screens.detail}"`,
        '- A `record_detail` of one row (all fields), opened from the grid row.',
        '',
        `**Finally:** ${pack.language} labels everywhere (${pack.labelWords}). App name "${v.title}". Finish with \`app_finalize\`.`,
    ].join('\n');
}

/**
 * Phase `approvals`: a SECOND automation — the approval lives in Studio →
 * Approvals, the automation parks the oldest open invoice, asks, and writes the
 * outcome back. One invoice per run (an approval never sits in a loop); the
 * person starts it by hand and may put it on a schedule later.
 * @param {Vocabulary} v
 * @param {Pack} pack
 * @param {string} title
 */
function approvalsText(v, pack, title) {
    const status = v.f('status') || 'status';
    const prompt = pack.approvalPrompt((/** @type {string} */ role) => `{{steps.<step1>.output.rows.0.${v.f(role)}}}`);
    return [
        `## Build an automation "${title}"`,
        'I start it by hand: manual trigger, no schedule, no file event. One invoice per run.',
        '',
        `1. \`datatable find_rows\` in the EXISTING datatable **"${v.name}"** (id \`${v.id}\`, key \`${v.key}\`): where ${status} equals "${pack.status.open}", sort ${v.f('datum')} ascending, limit 1 — the oldest open invoice.`,
        `2. \`datatable update_rows\` on that same table where id equals the found row's id: set ${status} to "${pack.status.review}".`,
        `3. \`builder_add_approval\` with assignee ${v.approver}, expiresInHours 168, prompt "${prompt}" (use step 1's real id). The person decides in Studio → Approvals.`,
        `4. \`datatable update_rows\` where id equals the found row's id: set ${status} to "${pack.status.approved}". (A rejection ends the run; the row stays "${pack.status.review}".)`,
        '',
        `**Rules:** do not create a table or columns. Title "${title}".`,
    ].join('\n');
}

/**
 * @param {{ table: BriefTable, folderPath: string, title?: string, locale?: string }} p
 */
function composeAutomationBrief({ table, folderPath, title, locale }) {
    const pack = packFor(locale);
    return assertLength(automationText(vocabulary('render', { table, folderPath }), pack, title || pack.automationTitle), 'automation');
}

/**
 * @param {{ table: BriefTable, title?: string, locale?: string }} p
 */
function composeAppBrief({ table, title, locale }) {
    const pack = packFor(locale);
    return assertLength(appText(vocabulary('render', { table, title: title || pack.appTitle }), pack), 'app');
}

/**
 * @param {{ table: BriefTable, approver: { userId?: string, groupId?: string }, title?: string, locale?: string }} p
 */
function composeApprovalsBrief({ table, approver, title, locale }) {
    const pack = packFor(locale);
    return assertLength(approvalsText(vocabulary('render', { table, approver }), pack, title || pack.approvalsTitle), 'approvals');
}

/**
 * The generic entry the lifecycle calls (recipeDoc.fromDocument has the
 * same): the brief of `key` for a table + options + playbook, or null for
 * the server-run phases.
 *
 * @param {string} key
 * @param {{ table: BriefTable, options?: { folderPath?: string, inputs?: { folderPath?: string }, automationTitle?: string, approverGroupId?: string, locale?: string }, playbook?: { title?: string, userId?: string } }} args
 */
function composeBrief(key, { table, options = {}, playbook = {} }) {
    const locale = localeOf(options);
    const pack = packFor(locale);
    switch (key) {
        case 'automation': return composeAutomationBrief({ table, folderPath: options.folderPath || (options.inputs && options.inputs.folderPath) || '/Invoices', title: options.automationTitle || pack.automationTitle, locale });
        case 'app': return composeAppBrief({ table, title: playbook.title || pack.appTitle, locale });
        case 'approvals': return composeApprovalsBrief({ table, approver: options.approverGroupId ? { groupId: options.approverGroupId } : { userId: playbook.userId }, locale });
        default: return null;
    }
}

// ── the recipe as a DOCUMENT ───────────────────────────────────────────────
// What the New dialog lists and previews, and what a person could copy into a
// custom playbook. Its briefs are the TEMPLATES of the same writers above;
// invoiceTracker.test.js pins that template and function agree, per language.

/**
 * @param {string} locale
 */
function buildDocument(locale) {
    const pack = packFor(locale);
    const v = vocabulary('template');
    return Object.freeze({
        id: RECIPE_ID,
        version: BRIEF_VERSION,
        source: 'builtin',
        title: pack.title,
        description: pack.description,
        // `role` is what the briefs address a column by: the key follows the
        // language ("total"/"totaal"), the role never does.
        table: { fields: pack.fields.map((f) => ({ key: f.key, name: f.name, type: f.type, ...(f.options ? { options: [...f.options] } : {}), required: ROLES[f.role].required, aliases: [...ROLES[f.role].aliases], role: f.role })) },
        inputs: [{ key: 'folderPath', label: pack.folderLabel, kind: 'folder', default: '/Invoices' }],
        phases: PHASE_SHAPE.map(({ key, kind, requires, requiresRole }) => ({
            key,
            kind,
            label: pack.phaseLabels[key],
            ...(requires ? { requires } : {}),
            ...(requiresRole ? { requiresRole } : {}),
            ...(kind === 'design' ? { goal: pack.designGoal } : {}),
            ...(key === 'automation' ? { brief: automationText(v, pack, pack.automationTitle) } : {}),
            ...(kind === 'app' ? { brief: appText(v, pack) } : {}),
            ...(key === 'approvals' ? { brief: approvalsText(v, pack, pack.approvalsTitle) } : {}),
        })),
    });
}

const DOCUMENTS = Object.freeze({ nl: buildDocument('nl'), en: buildDocument('en') });
const DOCUMENT = DOCUMENTS.nl;

/** @param {string} locale */
function toDocument(locale) {
    return DOCUMENTS[/** @type {'nl'|'en'} */ (packLocale(locale))];
}

module.exports = {
    RECIPE_ID,
    PHASE_SHAPE,
    DOCUMENT,
    DOCUMENTS,
    document: DOCUMENT,
    toDocument,
    phaseSpec: (/** @type {string} */ key, /** @type {string} */ locale) => toDocument(locale).phases.find((p) => p.key === key) || null,
    source: 'builtin',
    schema: INVOICE_SCHEMA,
    schemaFor,
    inputs: DOCUMENT.inputs,
    hasTable: true,
    composeBrief,
    PACKS,
    packFor,
    BRIEF_VERSION,
    MAX_BRIEF_CHARS,
    PHASE_KEYS,
    INVOICE_SCHEMA,
    ROLES,
    ROLE_ORDER,
    REQUIRED_ROLES,
    title: DOCUMENT.title,
    description: DOCUMENT.description,
    titleFor: (/** @type {string} */ locale) => packFor(locale).title,
    tableTitleFor: (/** @type {string} */ locale) => packFor(locale).tableTitle,
    verifyExistingTable,
    schemaMapping,
    defaultTableKey,
    phasesFor,
    composeAutomationBrief,
    composeAppBrief,
    composeApprovalsBrief,
};
