// @typecheck strict
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
/** @type {ReadonlyArray<{ key: 'table'|'automation'|'fill'|'design'|'app'|'approvals', kind: string, requires?: string, requiresRole?: string }>} */
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
/** @type {Readonly<Record<string, import('../recipeDoc').RoleSpec>>} */
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
        approvalPrompt: (/** @type {(role: string) => string} */ ref) => `Factuur ${ref('factuurnummer')} van ${ref('leverancier')} — totaal ${ref('totaal')} goedkeuren?`,
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
        approvalPrompt: (/** @type {(role: string) => string} */ ref) => `Approve invoice ${ref('factuurnummer')} from ${ref('leverancier')} — total ${ref('totaal')}?`,
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

/**
 * The pack of the playbook's language — Dutch, or English for the rest.
 * @param {string} locale
 */
function packFor(locale) {
    return PACKS[/** @type {'nl'|'en'} */ (packLocale(locale))];
}

/**
 * @param {{ folderPath?: string; inputs?: { folderPath?: string; }; automationTitle?: string; approverGroupId?: string; locale?: string; }} options
 */
function localeOf(options) {
    return (options && options.locale) || 'nl';
}

module.exports = { RECIPE_ID, BRIEF_VERSION, MAX_BRIEF_CHARS, PHASE_KEYS, PHASE_SHAPE, ROLES, REQUIRED_ROLES, ROLE_ORDER, PACKS, packFor, localeOf };
