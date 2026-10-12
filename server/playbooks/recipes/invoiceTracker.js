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

const RECIPE_ID = 'invoice_tracker';
const BRIEF_VERSION = 1;
// The cap pays for the markdown the briefs are written in (2026-09-16): a
// heading, one numbered step per line, tool names and ids in backticks. The
// person reads the brief rendered — in the handoff card and again as the
// builder's first message — so it has to be a document, not a paragraph.
const MAX_BRIEF_CHARS = 1200;
const PHASE_KEYS = Object.freeze(['table', 'automation', 'fill', 'design', 'app', 'approvals']);
// The five phase kinds, in order. `approvals` is a SECOND automation: the person
// decides in Studio → Approvals, the automation parks the invoice and writes the
// outcome back. The app is not touched (measured 2026-09-14: an approval turn
// on the app rebuilt screens the person never asked for).
const PHASE_SHAPE = Object.freeze([
    { key: 'table', kind: 'table' },
    { key: 'automation', kind: 'automation' },
    { key: 'fill', kind: 'fill' },
    { key: 'design', kind: 'design' },
    { key: 'app', kind: 'app' },
    { key: 'approvals', kind: 'automation', requires: 'approvals', requiresRole: 'status' },
]);

// What the briefs need from a table, by ROLE — an existing table (a Nextcloud
// mirror named by its column titles, an own table with English keys) is
// mapped onto these; the briefs then use the table's real keys. The roles
// keep their Dutch names: they are identifiers, not words a person reads.
const ROLES = Object.freeze({
    datum: { required: true, aliases: ['datum', 'date', 'factuurdatum', 'invoice_date', 'invoicedate'], types: ['date', 'datetime', 'text'] },
    leverancier: { required: true, aliases: ['leverancier', 'supplier', 'vendor', 'bedrijf', 'company'], types: ['text'] },
    factuurnummer: { required: true, aliases: ['factuurnummer', 'invoice_no', 'invoice_number', 'invoicenumber', 'nummer', 'number'], types: ['text', 'number'] },
    excl_btw: { required: true, aliases: ['excl_btw', 'exclbtw', 'excl_vat', 'exclvat', 'netto', 'subtotal', 'amount_excl', 'excl'], types: ['number', 'text'] },
    btw: { required: false, aliases: ['btw', 'vat', 'tax'], types: ['number', 'text'] },
    totaal: { required: true, aliases: ['totaal', 'total', 'amount_total', 'incl_btw', 'inclbtw', 'amount'], types: ['number', 'text'] },
    status: { required: false, aliases: ['status'], types: ['select', 'text'] },
    bestand: { required: false, aliases: ['bestand', 'file', 'path', 'document'], types: ['text', 'file'] },
});
const REQUIRED_ROLES = Object.freeze(Object.keys(ROLES).filter((r) => ROLES[r].required));
const ROLE_ORDER = Object.freeze(Object.keys(ROLES));

// ── the two languages the demo speaks ──────────────────────────────────────
// Datatable field types only (no relation/computed): datatableFields.js.
// 'in_beoordeling' / 'in_review' is the approval automation's parking state: the
// row is with the approver; declined stays there (visible in Approvals).
const PACKS = Object.freeze({
    nl: Object.freeze({
        language: 'Dutch',
        title: 'Facturen bijhouden',
        description: 'Lees een map met facturen in, vul er een tabel mee en bouw er een factuur-app met goedkeuringen op.',
        tableTitle: 'Facturen',
        automationTitle: 'Facturen inlezen',
        approvalsTitle: 'Facturen goedkeuren',
        appTitle: 'Facturen',
        folderLabel: 'Nextcloud-map met de facturen',
        phaseLabels: { table: 'Tabel', automation: 'Automatisering', fill: 'Eerste rijen', design: 'Ontwerp', app: 'App', approvals: 'Goedkeuringsflow' },
        designGoal: 'Een professionele factuur-app op de tabel: een overzicht met kerncijfers (aantal, totaal excl. btw, btw, totaal incl.), een grafiek van het totaal per maand, een filterbare lijst van alle facturen en een detailscherm per factuur; later komt er een goedkeuringsflow bij.',
        screens: { overview: 'Overzicht', detail: 'Factuur' },
        tiles: { count: 'aantal facturen', excl: 'totaal excl. btw', vat: 'totaal btw', total: 'totaal incl. btw' },
        labelWords: 'Datum, Leverancier, Factuurnummer, Excl. btw, Btw, Totaal, Status',
        status: { open: 'open', review: 'in_beoordeling', approved: 'goedgekeurd' },
        approvalPrompt: (ref) => `Factuur ${ref('factuurnummer')} van ${ref('leverancier')} — totaal ${ref('totaal')} goedkeuren?`,
        fields: Object.freeze([
            { role: 'datum', key: 'datum', name: 'Datum', type: 'date' },
            { role: 'leverancier', key: 'leverancier', name: 'Leverancier', type: 'text' },
            { role: 'factuurnummer', key: 'factuurnummer', name: 'Factuurnummer', type: 'text' },
            { role: 'excl_btw', key: 'excl_btw', name: 'Excl. btw', type: 'number' },
            { role: 'btw', key: 'btw', name: 'Btw', type: 'number' },
            { role: 'totaal', key: 'totaal', name: 'Totaal', type: 'number' },
            { role: 'status', key: 'status', name: 'Status', type: 'select', options: ['open', 'in_beoordeling', 'goedgekeurd', 'afgewezen', 'betaald'] },
            { role: 'bestand', key: 'bestand', name: 'Bestand', type: 'text' },
        ]),
    }),
    en: Object.freeze({
        language: 'English',
        title: 'Invoice tracker',
        description: 'Read an invoice folder, load a table, build an invoice app with approvals.',
        tableTitle: 'Invoices',
        automationTitle: 'Read invoices',
        approvalsTitle: 'Approve invoices',
        appTitle: 'Invoices',
        folderLabel: 'Nextcloud folder with the invoices',
        phaseLabels: { table: 'Table', automation: 'Automation', fill: 'First rows', design: 'Design', app: 'App', approvals: 'Approval flow' },
        designGoal: 'A professional invoice app on the table: an overview with the key figures (count, total excl. VAT, VAT, total incl.), a chart of the total per month, a filterable list of every invoice and a detail screen per invoice; an approval flow follows later.',
        screens: { overview: 'Overview', detail: 'Invoice' },
        tiles: { count: 'invoice count', excl: 'total excl. VAT', vat: 'total VAT', total: 'total incl. VAT' },
        labelWords: 'Date, Supplier, Invoice number, Excl. VAT, VAT, Total, Status',
        status: { open: 'open', review: 'in_review', approved: 'approved' },
        approvalPrompt: (ref) => `Approve invoice ${ref('factuurnummer')} from ${ref('leverancier')} — total ${ref('totaal')}?`,
        fields: Object.freeze([
            { role: 'datum', key: 'date', name: 'Date', type: 'date' },
            { role: 'leverancier', key: 'supplier', name: 'Supplier', type: 'text' },
            { role: 'factuurnummer', key: 'invoice_number', name: 'Invoice number', type: 'text' },
            { role: 'excl_btw', key: 'excl_vat', name: 'Excl. VAT', type: 'number' },
            { role: 'btw', key: 'vat', name: 'VAT', type: 'number' },
            { role: 'totaal', key: 'total', name: 'Total', type: 'number' },
            { role: 'status', key: 'status', name: 'Status', type: 'select', options: ['open', 'in_review', 'approved', 'rejected', 'paid'] },
            { role: 'bestand', key: 'file', name: 'File', type: 'text' },
        ]),
    }),
});

/** The pack of the playbook's language — Dutch, or English for the rest. */
function packFor(locale) {
    return PACKS[packLocale(locale)];
}

function localeOf(options) {
    return (options && options.locale) || 'nl';
}

/** The table's columns in a language: what the `table` phase creates. */
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

/** The mapping a NEW table gets — role → the key that language gives it. */
function schemaMapping(locale) {
    const mapping = {};
    for (const f of packFor(locale).fields) mapping[f.role] = f.key;
    return mapping;
}

function defaultTableKey(title, usedKeys, locale) {
    return keyFromTitle(String(title || packFor(locale).tableTitle), 0, usedKeys instanceof Set ? usedKeys : new Set(usedKeys || []));
}

/** The ordered phase list for a fresh playbook. */
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
        startedAt: null,
        finishedAt: null,
        brief: null,
        briefVersion: BRIEF_VERSION,
        briefEdited: false,
        attempt: 0,
        artifacts: {},
        summary: null,
        error: null,
    }));
}

function assertLength(text, what) {
    if (text.length > MAX_BRIEF_CHARS) throw new Error(`${what} brief is ${text.length} chars — over the ${MAX_BRIEF_CHARS} cap`);
    return text;
}

// ── one writer, two readings ───────────────────────────────────────────────

/**
 * The words a brief writer plugs the real world into. `render` fills in a
 * table's actual keys and ids; `template` writes the document's placeholders.
 * `when(path, fn)` is the single conditional: a real test in render mode,
 * `{{#if path}}…{{/if}}` in template mode.
 */
function vocabulary(mode, { table = null, folderPath = '', title = '', approver = null } = {}) {
    if (mode === 'template') {
        return {
            f: (role) => `{{field.${role}}}`,
            name: '{{table.name}}', id: '{{table.id}}', key: '{{table.key}}',
            folder: '{{input.folderPath}}', title: '{{title}}', approver: '{{approver}}',
            when: (path, fn) => `{{#if ${path}}}${fn()}{{/if}}`,
        };
    }
    const m = (table && table.mapping) || {};
    const truth = (path) => (path === 'table.isMirror' ? !!(table && table.isMirror) : !!m[path.replace(/^field\./, '')]);
    return {
        f: (role) => m[role],
        name: table ? table.name : '', id: table ? table.id : '', key: table ? table.key : '',
        folder: folderPath, title,
        approver: approver && approver.groupId ? `{groupId:"${approver.groupId}"}` : `{userId:"${(approver && approver.userId) || ''}"}`,
        when: (path, fn) => (truth(path) ? fn() : ''),
    };
}

/** Phase `automation`: the manual-trigger automation that fills the table. */
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

/** Phase `app`: the read-only invoice app on the table. */
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
 */
function approvalsText(v, pack, title) {
    const status = v.f('status') || 'status';
    const prompt = pack.approvalPrompt((role) => `{{steps.<step1>.output.rows.0.${v.f(role)}}}`);
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
 * @param {{ table:{ id, name, key, mapping, isMirror?, hasStatus? }, folderPath, title?, locale? }} p
 */
function composeAutomationBrief({ table, folderPath, title, locale }) {
    const pack = packFor(locale);
    return assertLength(automationText(vocabulary('render', { table, folderPath }), pack, title || pack.automationTitle), 'automation');
}

/**
 * @param {{ table:{ id, name, key, mapping, hasStatus? }, title?, locale? }} p
 */
function composeAppBrief({ table, title, locale }) {
    const pack = packFor(locale);
    return assertLength(appText(vocabulary('render', { table, title: title || pack.appTitle }), pack), 'app');
}

/**
 * @param {{ table:{ id, name, key, mapping }, approver:{ userId?:string, groupId?:string }, title?, locale? }} p
 */
function composeApprovalsBrief({ table, approver, title, locale }) {
    const pack = packFor(locale);
    return assertLength(approvalsText(vocabulary('render', { table, approver }), pack, title || pack.approvalsTitle), 'approvals');
}

/**
 * The generic entry the lifecycle calls (recipeDoc.fromDocument has the
 * same): the brief of `key` for a table + options + playbook, or null for
 * the server-run phases.
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

function toDocument(locale) {
    return DOCUMENTS[packLocale(locale)];
}

module.exports = {
    RECIPE_ID,
    PHASE_SHAPE,
    DOCUMENT,
    DOCUMENTS,
    document: DOCUMENT,
    toDocument,
    phaseSpec: (key, locale) => toDocument(locale).phases.find((p) => p.key === key) || null,
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
    titleFor: (locale) => packFor(locale).title,
    tableTitleFor: (locale) => packFor(locale).tableTitle,
    verifyExistingTable,
    schemaMapping,
    defaultTableKey,
    phasesFor,
    composeAutomationBrief,
    composeAppBrief,
    composeApprovalsBrief,
};
