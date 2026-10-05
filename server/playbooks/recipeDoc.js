/**
 * The recipe DOCUMENT — a playbook's plan as data, so an AI (or a person)
 * can write a new one instead of a developer adding a module.
 *
 *   {
 *     id, version, title, description, source: 'builtin'|'ai'|'user',
 *     table: { fields: [{ key, name, type, options?, required?, aliases?, role? }] } | null,
 *       (the composer's tool asks the model for a top-level `columns` array;
 *        normaliseRecipeDoc hoists it — and every other place a model puts a
 *        column list — into this `table.fields`)
 *     inputs: [{ key, label, kind: 'folder'|'text', default?, placeholder? }],
 *     phases: [{ key, kind, label, brief?, requires?: 'approvals', requiresRole?: 'status' }]
 *   }
 *
 * Phase KINDS are the vocabulary the run page can stage — nothing else:
 *   table    the server creates or verifies the table (at most one, first)
 *   automation  the automation builder gets `brief`
 *   fill     the server runs the nearest automation before it once
 *   design   the server asks the model, as a DESIGNER with no tools, for the
 *            app's screens and look (`goal` in plain words); the app brief
 *            then carries that design (at most one, right before the app)
 *   app      the app builder gets `brief` on a pre-created app (at most one)
 *   app_turn a further turn of the app builder on the same app
 *
 * Briefs are TEMPLATES: `{{table.name}}`, `{{table.id}}`, `{{table.key}}`,
 * `{{field.<role>}}` (the table's real column key for a schema role — a
 * column's `role` when it declares one, else its key),
 * `{{input.<key>}}`, `{{title}}`, `{{approver}}` (the stage seat, rendered
 * as {userId:"…"} or {groupId:"…"}), `{{owner.id}}`; and one conditional,
 * `{{#if path}}…{{/if}}` (no nesting). Rendering happens once the table
 * phase has reported REAL ids — a brief never carries a placeholder id.
 *
 * `fromDocument(doc)` returns the adapter the lifecycle, the phases and the
 * route program against; the built-in recipe module exposes the same shape.
 */

'use strict';

const { keyFromTitle } = require('../core/dataEngine/sources/mirror/keys');
const { DATATABLE_FIELD_TYPES } = require('../core/dataEngine/dataModel/datatableFields');
const { copyFor } = require('./copy');
const { SYSTEM_COLUMNS, RESERVED_KEY_PREFIX_RE } = require('../core/dataEngine/dataModel/vocabulary');
const { looksGarbled } = require('../core/llm/partialJsonScan');

/**
 * A column the database already owns, or one it reserves.
 *
 * Every datatable has `id`, `created_at`, `updated_at`, `created_by` and
 * `org_id`, and `createStudioDatatable` refuses a schema that declares one —
 * "Every table already has a \"created_at\" column". A model asked for exactly
 * that and the playbook died on phase 1 with a Retry that could only fail the
 * same way, because the recipe document is stored and replayed as written
 * (owner, on the box 2026-09-17).
 */
function reservedKey(key) {
    const k = String(key || '').toLowerCase();
    return SYSTEM_COLUMNS.includes(k) || RESERVED_KEY_PREFIX_RE.test(k);
}

/**
 * The fields a table can actually be created with.
 *
 * Repaired server-side, never by asking the model again: a column whose NAME
 * means something else keeps its meaning under a key derived from that name
 * ("Sollicitatiedatum" keyed `created_at` becomes `sollicitatiedatum`), and one
 * that is genuinely asking for a stamp the table already has is dropped — a
 * second "when was this added" column is worse than none.
 */
function stripSystemColumns(fields) {
    const list = Array.isArray(fields) ? fields : [];
    const used = new Set(list.map((f) => f && f.key).filter((k) => k && !reservedKey(k)));
    const out = [];
    for (const [i, f] of list.entries()) {
        if (!f || !reservedKey(f.key)) { out.push(f); continue; }
        // `keyFromTitle` (and `slug`, which wraps it) SUFFIX rather than return
        // a reserved name, so neither can answer this. Ask the raw name: does it
        // mean the stamp the table already has? "Created at" does — drop it, a
        // second one is worse than none. "Sollicitatiedatum" does not — keep it,
        // under a key of its own.
        const meansTheStamp = reservedKey(rawSlug(f.name));
        if (meansTheStamp) continue;
        const fromName = keyFromTitle(String(f.name || ''), i, used);
        if (!fromName || reservedKey(fromName)) continue;
        used.add(fromName);
        out.push({ ...f, key: fromName, ...(f.role && reservedKey(f.role) ? { role: fromName } : {}) });
    }
    return out;
}

const DOC_VERSION = 1;
// `access` is the last phase of a playbook that built an app: who may open it
// and with which role. No model touches it — the person fills it in.
const KINDS = Object.freeze(['table', 'automation', 'fill', 'design', 'app', 'app_turn', 'access', 'compliance']);
const BRIEF_KINDS = new Set(['automation', 'app', 'app_turn']);
const INPUT_KINDS = new Set(['folder', 'text']);
const MAX_PHASES = 8;
const MAX_FIELDS = 30;
const MAX_INPUTS = 6;
// Both raised (2026-09-16) to pay for the markdown a brief is written in — a
// heading, a step per line, backticks round tool names and ids.
const MAX_BRIEF_CHARS = 1200;      // the RENDERED brief the builder reads
const MAX_TEMPLATE_CHARS = 1600;   // the template — placeholders are longer than the ids they become
const MAX_TITLE = 120;
const MAX_LABEL = 60;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const INPUT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;   // inputs keep camelCase (folderPath)
// Only these roots are the recipe's own placeholders. A brief may also carry
// the AUTOMATION builder's bindings (`{{steps.x.output.rows.0.totaal}}`,
// `{{trigger.output.recordId}}`) — those pass through verbatim.
const RECIPE_ROOTS = new Set(['table', 'field', 'input', 'title', 'approver', 'owner']);
const PLACEHOLDER_RE = /\{\{\s*((?:table|field|input|title|approver|owner)(?:\.[\w.]*)?)\s*\}\}/g;
const IF_RE = /\{\{#if\s+([a-zA-Z_][\w.]*)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

/** The name as a bare key, with no collision handling — for asking what it MEANS. */
function rawSlug(s) {
    return String(s == null ? '' : s)
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function slug(s) {
    return keyFromTitle(String(s == null ? '' : s), 0, new Set());
}

/**
 * A finding. `path` locates it in the NORMALISED document (the one the API
 * returns beside the errors); `extra` names the subject by identity — the
 * phase's label, the column's key — for a reader who holds a different
 * copy: the model, whose own call the repair round echoes, wrote phases in
 * another order and count than the normaliser left them in.
 */
function err(code, path, message, extra = null) {
    return { code, path, message, ...(extra || {}) };
}

// ── normalise: the mechanical repairs (doctrine: never ask the model to fix a batch) ──

// The model's column list, wherever it put it. A top-level `columns` array is
// the contract (since 2026-09-17 — it used to be a nested `table.fields`
// object that a small model, writing properties alphabetically, reached only
// after five long briefs and then skipped), but a small model still writes
// `fields`, hands the array over AS `table`, or joins the column names into
// one string — each of which used to lose the WHOLE table while the briefs
// went on referencing {{table.id}}: the compose then died as recipe_invalid
// with "A table phase needs table.fields" (owner's dialog, 2026-09-17).
function firstList(...candidates) {
    for (const c of candidates) {
        if (Array.isArray(c) && c.length) return c;
        if (typeof c === 'string' && c.trim()) return c.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
        // An object keyed by column name: {"invoice_date": "date", "vendor": {type:"text"}}.
        // (One column given bare — {name, type} — is one entry, not a map.)
        if (c && typeof c === 'object') {
            if (typeof c.name === 'string' || typeof c.label === 'string') return [c];
            const entries = Object.entries(c);
            if (entries.length) {
                return entries.map(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v)
                    ? { name: k, ...v, key: typeof v.key === 'string' ? v.key : k }
                    : { name: k, type: typeof v === 'string' ? v : undefined }));
            }
        }
    }
    return null;
}

// A TABLE-shaped value — `table`, `datatable`, `schema`, `tables[0]`, or the
// table phase itself: the column array bare, or an object carrying it under
// `fields`, `columns` or `schema`. An object with none of those is not a
// column list (a `{name:"Invoices"}` table stub must not become one column).
function columnsOf(t) {
    if (Array.isArray(t)) return t.length ? t : null;
    if (t && typeof t === 'object') return firstList(t.fields, t.columns, t.schema);
    return null;
}

function normaliseField(raw, i, used, copy) {
    // A string entry IS the column ("invoice_date", "Vendor Name").
    const f = raw && typeof raw === 'object' ? raw : { name: String(raw ?? '') };
    const name = String(f.name || f.label || f.key || copy.columnFallback(i + 1)).trim().slice(0, MAX_LABEL);
    let key = typeof f.key === 'string' && KEY_RE.test(f.key.toLowerCase()) ? f.key.toLowerCase() : keyFromTitle(name, i, used);
    if (used.has(key)) key = keyFromTitle(name, i, used);
    used.add(key);
    let type = String(f.type || 'text').toLowerCase();
    if (type === 'string') type = 'text';
    if (type === 'integer' || type === 'float' || type === 'decimal' || type === 'currency' || type === 'amount') type = 'number';
    if (type === 'boolean') type = 'bool';
    if (type === 'enum' || type === 'choice') type = 'select';
    if (!DATATABLE_FIELD_TYPES.includes(type)) type = 'text';
    const out = { key, name, type, required: f.required !== false };
    // A column may declare the ROLE it plays ("totaal"), so a brief can
    // address it by one stable name while the key follows the language
    // (`total` in English, `totaal` in Dutch). Without a role the key IS the
    // role — which is every recipe an AI writes.
    if (typeof f.role === 'string' && KEY_RE.test(f.role.toLowerCase())) out.role = f.role.toLowerCase();
    if (type === 'select' || type === 'multiselect') {
        const opts = Array.isArray(f.options) ? f.options.map((o) => String(o && typeof o === 'object' ? (o.value || o.label || '') : o).trim()).filter(Boolean) : [];
        out.options = [...new Set(opts)].slice(0, 30);
    }
    if (Array.isArray(f.aliases)) out.aliases = [...new Set(f.aliases.map((a) => slug(a)).filter(Boolean))].slice(0, 12);
    return out;
}

function normalisePhase(raw, i, copy) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- constant replace/test patterns without nested repeats on bounded strings: linear
    const p = raw && typeof raw === 'object' ? raw : {};
    let kind = String(p.kind || p.key || '').toLowerCase().replace(/-/g, '_');
    // An approval flow is a AUTOMATION on Studio → Approvals (the person decides
    // there), never a change to the app.
    let requires = p.requires === 'approvals' || p.requiresApprovals === true ? 'approvals' : null;
    if (kind === 'approvals' || kind === 'approval' || kind === 'approval_flow') { kind = 'automation'; requires = 'approvals'; }
    if (kind === 'turn' || kind === 'app_extend') kind = 'app_turn';
    if (kind === 'automation' || kind === 'flow') kind = 'automation';
    if (kind === 'datatable' || kind === 'data') kind = 'table';
    if (kind === 'run' || kind === 'rows' || kind === 'first_rows') kind = 'fill';
    if (kind === 'visual' || kind === 'ux' || kind === 'wireframe' || kind === 'visual_design') kind = 'design';
    const label = String(p.label || p.title || p.name || kind || copy.phaseFallback(i + 1)).trim().slice(0, MAX_LABEL);
    const brief = typeof p.brief === 'string' && p.brief.trim() ? p.brief.trim().replace(/\r\n/g, '\n') : '';
    // A kind the model made up ("bi_dashboard", "fase_1") is read off the
    // words: what it builds tells what it is.
    if (!KINDS.includes(kind)) kind = inferKind(`${kind} ${label} ${brief}`);
    const out = { key: typeof p.key === 'string' && KEY_RE.test(p.key.toLowerCase()) ? p.key.toLowerCase() : null, kind, label };
    if (brief) out.brief = brief;
    if (requires) out.requires = requires;
    if (typeof p.requiresRole === 'string' && p.requiresRole.trim()) out.requiresRole = slug(p.requiresRole);
    if (typeof p.goal === 'string' && p.goal.trim()) out.goal = p.goal.trim().slice(0, 600);
    return out;
}

/** The kind the words point at, or null when they point nowhere. */
function inferKind(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(goedkeur|approv)/.test(t)) return 'automation';
    if (/\b(dashboard|app|scherm|screen|bi\b|rapport|report|overzicht|weergave|view)/.test(t)) return 'app';
    if (/\b(automation|automation|automatis|extract|lees|read|inlezen|verwerk|process|flow|import)/.test(t)) return 'automation';
    if (/\b(tabel|table|kolom|column|datatable|opslaan|store)/.test(t)) return 'table';
    if (/\b(vul|fill|rijen|rows|run)/.test(t)) return 'fill';
    if (/\b(ontwerp|design|wireframe)/.test(t)) return 'design';
    return null;
}

/** Keys after the kinds are settled: the kind itself, or the label's slug, unique. */
function assignPhaseKeys(phases) {
    const used = new Set();
    return phases.map((p, i) => {
        let key = p.key || p.kind || slug(p.label) || `phase_${i + 1}`;
        if (used.has(key)) key = keyFromTitle(key, i, used);
        used.add(key);
        return { ...p, key };
    });
}

/**
 * Bring a raw document (an AI's tool call, a person's JSON) to the canonical
 * shape without judging it: keys derived, kinds inferred, a fill after a
 * automation that lacks one, a table phase first when a table is declared.
 */
function normaliseRecipeDoc(raw, { source = 'ai', locale = null } = {}) {
    // What the SERVER adds to the document (a fill phase, a design phase, a
    // name for something left unnamed) is written in the demo's language.
    const copy = copyFor(locale);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- constant replace/test patterns without nested repeats on bounded strings: linear
    const d = raw && typeof raw === 'object' ? raw : {};
    const title = String(d.title || '').trim().slice(0, MAX_TITLE);
    const description = String(d.description || d.blurb || '').trim().slice(0, 300);
    // Phases first: the column list may be sitting INSIDE the table phase, and
    // only the normalised kind says which raw phase that is (a `datatable`
    // phase, or one whose label reads "Tabel" with no kind at all).
    const rawPhases = (Array.isArray(d.phases) ? d.phases : []).slice(0, MAX_PHASES);
    let phases = rawPhases.map((p, i) => normalisePhase(p, i, copy));
    const rawTablePhase = rawPhases.find((p, i) => phases[i].kind === 'table' && p && typeof p === 'object') || null;
    const usedFields = new Set();
    // In this order: the contract (`columns`, then its old name), the nested
    // `table` the contract used to be, the other names a model gives a table,
    // and last the columns it put inside the phase despite being told not to —
    // `normalisePhase` drops unknown keys, so this peeks at the RAW phase.
    const rawFields = firstList(d.columns, d.fields)
        || columnsOf(d.table)
        || columnsOf(d.datatable) || columnsOf(d.schema) || (Array.isArray(d.tables) ? columnsOf(d.tables[0]) : null)
        || (rawTablePhase ? firstList(rawTablePhase.fields, rawTablePhase.columns, rawTablePhase.schema) : null);
    const normalisedFields = rawFields && rawFields.length
        ? stripSystemColumns(rawFields.slice(0, MAX_FIELDS).map((f, i) => normaliseField(f, i, usedFields, copy)))
        : [];
    const table = normalisedFields.length ? { fields: normalisedFields } : null;
    const usedInputs = new Set();
    const inputs = (Array.isArray(d.inputs) ? d.inputs : []).slice(0, MAX_INPUTS).map((x, i) => {
        const r = x && typeof x === 'object' ? x : {};
        const label = String(r.label || r.key || copy.inputFallback(i + 1)).trim().slice(0, MAX_LABEL);
        let key = typeof r.key === 'string' && INPUT_KEY_RE.test(r.key) ? r.key : (slug(label) || `input_${i + 1}`);
        if (usedInputs.has(key)) key = keyFromTitle(key, i, usedInputs);
        usedInputs.add(key);
        const kind = INPUT_KINDS.has(r.kind) ? r.kind : (/folder|map|pad|path/i.test(`${key} ${label}`) ? 'folder' : 'text');
        const out = { key, label, kind };
        if (typeof r.default === 'string' && r.default.trim()) out.default = r.default.trim().slice(0, 300);
        else if (kind === 'folder') out.default = `/${(slug(label) || copy.documentsFolder).replace(/_/g, '-')}`;
        if (typeof r.placeholder === 'string') out.placeholder = r.placeholder.slice(0, 120);
        return out;
    });
    // A document-level marker that survives the round trip: the compose
    // response's document carries `table_synthesized` when the columns were
    // read off the briefs, the dialog posts that document back, and the
    // route normalises it again before storing it — without this the stored
    // playbook lost the one trace that its schema was a guess. Only while
    // the table is still there: the marker means nothing without one.
    const warnings = table && Array.isArray(d.warnings) && d.warnings.includes('table_synthesized') ? ['table_synthesized'] : [];
    // A phase whose kind stays unknown after the words: dropped and said, so
    // one odd entry does not refuse a document that is otherwise runnable.
    phases = phases.filter((p) => {
        if (p.kind) return true;
        warnings.push(`phase "${p.label}" dropped — no known kind`);
        return false;
    });
    // A declared table without a table phase: the phase goes first.
    if (table && !phases.some((p) => p.kind === 'table')) phases.unshift({ key: null, kind: 'table', label: copy.tablePhaseLabel });
    // The table phase is always first.
    const ti = phases.findIndex((p) => p.kind === 'table');
    if (ti > 0) phases = [phases[ti], ...phases.filter((_, i) => i !== ti)];
    // An automation that FEEDS the table (not the approval automation) gets its
    // fill phase when the document has none.
    const ri = phases.findIndex((p) => p.kind === 'automation' && p.requires !== 'approvals');
    if (table && ri >= 0 && !phases.some((p) => p.kind === 'fill')) {
        phases.splice(ri + 1, 0, { key: null, kind: 'fill', label: copy.fillPhaseLabel });
    }
    // The approval automation writes a status: when the table has one, it needs it.
    for (const p of phases) {
        if (p.kind === 'automation' && p.requires === 'approvals' && !p.requiresRole && table && table.fields.some((f) => f.key === 'status')) p.requiresRole = 'status';
    }
    // Every app is designed first: a design phase right before the first
    // app phase when the document has none (its goal = the app's brief in
    // plain words, or the description).
    let seenApp = false;
    phases = phases.map((p) => {
        if (p.kind !== 'app' && p.kind !== 'app_turn') return p;
        const kind = seenApp ? 'app_turn' : 'app';
        seenApp = true;
        return { ...p, kind };
    });
    const ai = phases.findIndex((p) => p.kind === 'app');
    if (ai >= 0 && !phases.some((p) => p.kind === 'design')) {
        const app = phases[ai];
        phases.splice(ai, 0, { key: null, kind: 'design', label: copy.designPhaseLabel, goal: (app.goal || description || title).slice(0, 600) });
    }
    // One design, and it sits right before the app.
    const di = phases.findIndex((p) => p.kind === 'design');
    if (di >= 0) {
        const design = phases[di];
        phases = phases.filter((p) => p.kind !== 'design');
        const at = phases.findIndex((p) => p.kind === 'app');
        if (at >= 0) phases.splice(at, 0, design);
    }
    phases = assignPhaseKeys(phases);
    const id = typeof d.id === 'string' && /^[a-z][a-z0-9_]{2,40}$/.test(d.id) ? d.id : `custom_${slug(title).slice(0, 24) || 'playbook'}`;
    return { id, version: DOC_VERSION, source, title, description, table, inputs, phases, ...(warnings.length ? { warnings } : {}) };
}

// The column type a key's words point at. A date when it says so, a number
// for money and counts, text for everything else — `status` included: its
// options are the approval automation's to write, and a select without options
// is refused by the validator. The money/count words are matched as WHOLE
// key segments (`total_amount`, `amount_excl_vat`, `qty`), never as a
// substring: `summary` contains `sum` and `country` contains `count`, and a
// text column typed as a number makes the extraction drop every value while
// the preview reads plausible at a glance.
const DATE_KEY_RE = /_date$|^date$|datum/;
const NUMBER_KEY_RE = /(^|_)(amount|total|totaal|subtotal|subtotaal|vat|btw|price|prijs|bedrag|sum|qty|count|aantal)s?(_|$)/;
// A status or a path is something a row may lack — the extraction writes the
// business columns, a later phase writes these.
const OPTIONAL_KEY_RE = /status|path|file|url/;

/** The distinct `{{field.<key>}}` keys the briefs reference, in order of appearance. */
function fieldKeysReferenced(doc) {
    const keys = [];
    for (const p of (doc && Array.isArray(doc.phases) ? doc.phases : [])) {
        if (!p || typeof p.brief !== 'string') continue;
        for (const ph of placeholdersOf(p.brief)) {
            const [root, key] = ph.split('.');
            if (root === 'field' && key && !keys.includes(key)) keys.push(key);
        }
    }
    return keys;
}

/**
 * LAST RESORT: a table read off the briefs' `{{field.<key>}}` placeholders
 * when the model declared none — twice. Every referenced key becomes a column
 * with a type from its words, so the fill phase and the placeholders have
 * something to bind to. Returns the re-normalised document (the table phase
 * inserted first, the fill phase after the automation) with the warning
 * `table_synthesized` in its `warnings`, or null when no brief references a
 * field. The caller decides WHEN: never on the first pass, only after the
 * repair round still failed for table reasons — a synthesized schema is a
 * guess the person must see in the column preview, not a silent default.
 */
function synthesizeTableFromPlaceholders(doc, { locale = null } = {}) {
    if (!doc || typeof doc !== 'object') return null;
    const fields = [];
    for (const raw of fieldKeysReferenced(doc)) {
        const key = raw.toLowerCase();
        if (!KEY_RE.test(key) || reservedKey(key)) continue;
        const type = DATE_KEY_RE.test(key) ? 'date' : NUMBER_KEY_RE.test(key) ? 'number' : 'text';
        const name = key.replace(/_+/g, ' ').replace(/^./, (c) => c.toUpperCase());
        fields.push({ key, name, type, required: !OPTIONAL_KEY_RE.test(key) });
    }
    if (!fields.length) return null;
    const next = normaliseRecipeDoc({ ...doc, table: null, columns: fields }, { source: doc.source || 'ai', locale });
    return { ...next, warnings: [...new Set([...(doc.warnings || []), 'table_synthesized'])] };
}

// ── validate: the shape the stages can run ──────────────────────────────────

function placeholdersOf(template) {
    const out = new Set();
    for (const m of String(template || '').matchAll(IF_RE)) out.add(m[1]);
    for (const m of String(template || '').replace(IF_RE, '$2').matchAll(PLACEHOLDER_RE)) out.add(m[1]);
    return [...out];
}

function placeholderKnown(path, doc) {
    const [root, sub] = path.split('.');
    if (!RECIPE_ROOTS.has(root)) return true; // an automation binding, passed through
    if (root === 'table') return !!doc.table && ['name', 'id', 'key', 'isMirror', 'hasStatus'].includes(sub);
    if (root === 'field') return !!doc.table && doc.table.fields.some((f) => (f.role || f.key) === sub);
    if (root === 'input') return doc.inputs.some((x) => x.key === sub);
    if (root === 'title' || root === 'approver') return !sub;
    if (root === 'owner') return sub === 'id';
    return false;
}

/**
 * What a placeholder the document cannot serve needs — said as the fix, in
 * the vocabulary of the tool the model just called: a `{{field.x}}` with no
 * table wants an entry in `columns`; with a table, it names the keys that
 * exist. Anything else is simply not a placeholder this playbook knows.
 */
function unknownPlaceholderMessage(ph, doc) {
    const [root, sub] = ph.split('.');
    if (root === 'field' && !doc.table) return `{{${ph}}} needs an entry with key "${sub}" in \`columns\`.`;
    if (root === 'table' && !doc.table) return `{{${ph}}} needs \`columns\` — the table does not exist without them.`;
    if (root === 'field' && doc.table) return `{{${ph}}} is not a column key — \`columns\` declares: ${doc.table.fields.map((f) => f.role || f.key).join(', ')}.`;
    return `{{${ph}}} is not something this playbook knows.`;
}

/**
 * Errors refuse the document; warnings only describe it. `brief_garbled` is
 * the one warning: a brief carrying the punctuation run that llama.cpp's
 * Gemma parser leaves when it chops a string at a brace (`}}},key:`). The
 * document may still run — the brief reads oddly — so it is said, not refused.
 *
 * A finding on a phase carries `phase: { key, label }`, one on a column
 * `column: <key>` — the subject by identity, for the reader who does not
 * hold the normalised document (the model, in the compose repair round).
 *
 * @returns {{ ok:boolean, errors:Array<{code,path,message,phase?,column?}>, warnings:Array<{code,path,message,phase?}> }}
 */
function validateRecipeDoc(doc) {
    const errors = [];
    const warnings = [];
    if (!doc || typeof doc !== 'object') return { ok: false, errors: [err('doc_invalid', '', 'Not an object.')], warnings };
    if (!doc.title) errors.push(err('title_required', 'title', 'A title is required.'));
    if (!Array.isArray(doc.phases) || !doc.phases.length) errors.push(err('phases_required', 'phases', 'At least one phase.'));
    if (Array.isArray(doc.phases) && doc.phases.length > MAX_PHASES) errors.push(err('too_many_phases', 'phases', `At most ${MAX_PHASES} phases.`));
    // A table alone builds nothing (measured: a vague description came back as one table phase).
    if (Array.isArray(doc.phases) && doc.phases.length && !doc.phases.some((p) => p && (p.kind === 'automation' || p.kind === 'app'))) errors.push(err('no_builder_phase', 'phases', 'A playbook needs an automation or an app phase — a table alone builds nothing.'));
    // The paths say `columns`, as the tool the model called does — a finding
    // at `table.fields[2]` sent a model adding a top-level `table` object
    // instead of fixing the entry it wrote. The index is the normalised
    // list's (system columns stripped), so the key is what locates it.
    if (doc.table) {
        if (!doc.table.fields.length) errors.push(err('fields_required', 'columns', 'A table needs at least one column.'));
        for (const [i, f] of doc.table.fields.entries()) {
            if ((f.type === 'select' || f.type === 'multiselect') && !(f.options && f.options.length)) errors.push(err('select_needs_options', `columns[${i}]`, `Column "${f.key}" is a select without options.`, { column: f.key }));
        }
    }
    const phases = Array.isArray(doc.phases) ? doc.phases : [];
    // The keys the briefs bind to — named in the table finding, so the repair
    // round knows WHICH columns to declare rather than that some are missing.
    const refs = fieldKeysReferenced(doc);
    let sawAutomation = false; let sawApp = false; let sawTable = false;
    for (const [i, p] of phases.entries()) {
        const at = `phases[${i}]`;
        // Every finding on a phase names it: `phases[4]` is where the
        // normaliser put it (the table moved first, a fill and a design
        // inserted), not where the model wrote it — its own call has three
        // phases, and told about the fifth it adds one rather than fix one.
        const phaseErr = (code, sub, message) => err(code, sub ? `${at}.${sub}` : at, message, { phase: { key: p.key, label: p.label } });
        if (!p.kind) { errors.push(phaseErr('kind_unknown', null, `Phase "${p.key}" has no known kind (table, automation, fill, app, app_turn).`)); continue; }
        if (p.kind === 'table') {
            if (i !== 0) errors.push(phaseErr('table_not_first', null, 'The table phase must come first.'));
            if (sawTable) errors.push(phaseErr('table_twice', null, 'Only one table phase.'));
            if (!doc.table) errors.push(phaseErr('table_schema_missing', null, `Phase "${p.label}" is a table phase but the document has no columns. Add a top-level \`columns\` array with one entry {key, name, type} per column${refs.length ? ` — the briefs reference: ${refs.join(', ')}` : ''}.`));
            sawTable = true;
        }
        if (p.kind === 'fill' && !sawAutomation) errors.push(phaseErr('fill_without_automation', null, 'A fill phase needs an automation phase before it.'));
        if (p.kind === 'fill' && !doc.table) errors.push(phaseErr('fill_without_table', null, 'A fill phase counts rows in the table — add `columns`, or remove the fill phase.'));
        if (p.kind === 'app_turn' && !sawApp) errors.push(phaseErr('turn_without_app', null, 'An app_turn needs an app phase before it.'));
        if (p.kind === 'app' && sawApp) errors.push(phaseErr('app_twice', null, 'Only one app phase; later work on it is an app_turn.'));
        if (p.kind === 'design' && !phases.slice(i + 1).some((q) => q.kind === 'app')) errors.push(phaseErr('design_without_app', null, 'A design phase needs an app phase after it.'));
        // `normaliseRecipeDoc` supplies a goal only for a design phase IT
        // inserts, so a model-authored one could reach the designer with nothing
        // but the playbook title to design from. The one repair round can fix
        // this if it is told; silently it could not.
        if (p.kind === 'design' && !p.goal) errors.push(phaseErr('goal_required', 'goal', `Phase "${p.label || p.key}" needs a goal: what the app is for, in plain words.`));
        if (BRIEF_KINDS.has(p.kind)) {
            if (!p.brief) errors.push(phaseErr('brief_required', 'brief', `Phase "${p.label}" needs a brief.`));
            else if (p.brief.length > MAX_TEMPLATE_CHARS) errors.push(phaseErr('brief_too_long', 'brief', `Brief of "${p.label}" is ${p.brief.length} chars — over ${MAX_TEMPLATE_CHARS}.`));
            else {
                for (const ph of placeholdersOf(p.brief)) {
                    if (!placeholderKnown(ph, doc)) errors.push(phaseErr('unknown_placeholder', 'brief', unknownPlaceholderMessage(ph, doc)));
                    if (ph.startsWith('table.') && !sawTable) errors.push(phaseErr('placeholder_before_table', 'brief', `{{${ph}}} is used before any table phase.`));
                }
                if (looksGarbled(p.brief)) warnings.push(phaseErr('brief_garbled', 'brief', `Brief of "${p.label}" carries a run of JSON punctuation — a string the model's parser chopped at a brace.`));
            }
        }
        if (p.requiresRole && !(doc.table && doc.table.fields.some((f) => (f.role || f.key) === p.requiresRole))) errors.push(phaseErr('requires_role_unknown', null, `requiresRole "${p.requiresRole}" is not a column of the table.`));
        if (p.kind === 'automation') sawAutomation = true;
        if (p.kind === 'app') sawApp = true;
    }
    return { ok: errors.length === 0, errors, warnings };
}

// ── render ──────────────────────────────────────────────────────────────────

function lookup(ctx, path) {
    let cur = ctx;
    for (const part of path.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[part];
    }
    return cur;
}

/** Render a brief template against the playbook's real artifacts. */
function renderBrief(template, ctx) {
    const withIfs = String(template || '').replace(IF_RE, (_, path, body) => (lookup(ctx, path) ? body : ''));
    const out = withIfs.replace(PLACEHOLDER_RE, (_, path) => {
        const v = lookup(ctx, path);
        if (v === undefined || v === null) { const e = new Error(`{{${path}}} is not available yet`); e.code = 'artifacts_missing'; e.placeholder = path; throw e; }
        return String(v);
    });
    // Trailing spaces go, runs of spaces INSIDE a line collapse — but the
    // indentation a line starts with survives: a brief is markdown, and two
    // spaces at the head of a line are what makes a nested list item nested.
    return out.replace(/[ \t]+\n/g, '\n').replace(/(?<=\S) {2,}/g, ' ').trim();
}

// ── the adapter ─────────────────────────────────────────────────────────────

function rolesOf(doc) {
    const roles = {};
    for (const f of (doc.table ? doc.table.fields : [])) {
        const aliases = new Set([f.key, f.role, slug(f.name), ...(f.aliases || [])].filter(Boolean));
        const types = f.type === 'number' ? ['number', 'text'] : f.type === 'date' ? ['date', 'datetime', 'text'] : f.type === 'select' ? ['select', 'text'] : [f.type, 'text'];
        roles[f.role || f.key] = { required: f.required !== false, aliases: [...aliases], types: [...new Set(types)] };
    }
    return roles;
}

/**
 * Map a table's fields onto the recipe's roles (the schema keys). Match by
 * key first, then by the slug of the title. `ok` when every required role
 * is present. Shared by the built-in recipe (with its richer aliases).
 */
function verifyAgainstRoles(fields, roles) {
    const list = Array.isArray(fields) ? fields.filter((f) => f && typeof f.key === 'string') : [];
    const mapping = {};
    const typeWarnings = [];
    const taken = new Set();
    for (const [role, spec] of Object.entries(roles)) {
        const hit = list.find((f) => !taken.has(f.key) && (spec.aliases.includes(f.key.toLowerCase()) || spec.aliases.includes(slug(f.name || ''))));
        if (!hit) continue;
        mapping[role] = hit.key;
        taken.add(hit.key);
        if (hit.type && !spec.types.includes(hit.type)) typeWarnings.push(`${role}: column "${hit.key}" is ${hit.type}, expected ${spec.types.join('|')}`);
    }
    const missing = Object.keys(roles).filter((r) => roles[r].required && !mapping[r]);
    return { ok: missing.length === 0, mapping, missing, hasStatus: !!mapping.status, typeWarnings };
}

/** The phase objects a fresh playbook starts with. */
function phaseObjectsFor(doc, { approvalsAllowed = false } = {}) {
    return doc.phases.map((p, i) => ({
        key: p.key,
        kind: p.kind,
        label: p.label,
        ...(p.requires ? { requires: p.requires } : {}),
        ...(p.requiresRole ? { requiresRole: p.requiresRole } : {}),
        ...(p.goal ? { goal: p.goal } : {}),
        status: i === 0 ? 'ready' : (p.requires === 'approvals' && !approvalsAllowed ? 'locked' : 'pending'),
        startedAt: null,
        finishedAt: null,
        brief: null,
        briefVersion: doc.version || DOC_VERSION,
        briefEdited: false,
        attempt: 0,
        artifacts: {},
        summary: null,
        error: null,
    }));
}

/** Build the render context from the playbook's table artifacts + options. */
function briefContext({ table, options = {}, playbook = {} }) {
    const field = {};
    if (table && table.mapping) for (const [role, key] of Object.entries(table.mapping)) if (key) field[role] = key;
    const approver = options.approverGroupId ? `{groupId:"${options.approverGroupId}"}` : `{userId:"${playbook.userId || ''}"}`;
    return {
        table: table ? { name: table.name, id: table.id, key: table.key, isMirror: !!table.isMirror, hasStatus: table.hasStatus !== false && !!field.status } : null,
        field,
        input: { ...(options.inputs || {}), ...(options.folderPath ? { folderPath: options.folderPath } : {}) },
        title: playbook.title || '',
        approver,
        owner: { id: playbook.userId || '' },
    };
}

/**
 * The adapter: what lifecycle.js, phases/*.js and routes/playbooks.js call.
 */
/** The longest prefix of whole lines that fits, so nothing is cut mid-instruction. */
function clampToLines(text, cap) {
    if (text.length <= cap) return text;
    const lines = String(text).split('\n');
    const out = [];
    let n = 0;
    for (const line of lines) {
        if (n + line.length + 1 > cap) break;
        out.push(line);
        n += line.length + 1;
    }
    return (out.length ? out.join('\n') : String(text).slice(0, cap - 1)).trimEnd();
}

function fromDocument(doc) {
    const roles = rolesOf(doc);
    // Documents written before the repair above carry whatever the model said,
    // and they are replayed as written — so the strip runs here too, or an
    // existing playbook's Retry fails identically for ever.
    const usableFields = doc.table ? stripSystemColumns(doc.table.fields) : [];
    const schema = doc.table ? usableFields.map((f) => ({ key: f.key, name: f.name, type: f.type, ...(f.options ? { options: [...f.options] } : {}) })) : null;
    return {
        RECIPE_ID: doc.id,
        BRIEF_VERSION: doc.version || DOC_VERSION,
        MAX_BRIEF_CHARS,
        PHASE_KEYS: doc.phases.map((p) => p.key),
        title: doc.title,
        description: doc.description,
        source: doc.source || 'ai',
        schema,
        inputs: doc.inputs,
        hasTable: !!doc.table,
        document: doc,
        toDocument: () => doc,
        phaseSpec: (key) => doc.phases.find((p) => p.key === key) || null,
        verifyExistingTable: (fields) => verifyAgainstRoles(fields, roles),
        schemaMapping: () => Object.fromEntries(usableFields.map((f) => [f.role || f.key, f.key])),
        defaultTableKey: (title, usedKeys) => keyFromTitle(String(title || doc.title || 'tabel'), 0, usedKeys instanceof Set ? usedKeys : new Set(usedKeys || [])),
        phasesFor: (options, opts) => phaseObjectsFor(doc, opts),
        composeBrief: (key, ctx) => {
            const spec = doc.phases.find((p) => p.key === key);
            if (!spec || !BRIEF_KINDS.has(spec.kind) || !spec.brief) return null;
            const text = renderBrief(spec.brief, briefContext(ctx));
            // Placeholders GROW: `{{table.id}}` is 13 characters and a uuid is
            // 36, so a template the validator accepted at 1600 can render past
            // 1200. This used to throw a codeless Error, which every caller
            // rethrew — pressing Continue on the design handoff answered 500
            // and the playbook was dead with no way past it. Cut on a line
            // boundary instead, so the brief stays a document.
            return text.length > MAX_BRIEF_CHARS ? clampToLines(text, MAX_BRIEF_CHARS) : text;
        },
    };
}

module.exports = {
    DOC_VERSION, KINDS, BRIEF_KINDS, clampToLines, stripSystemColumns, reservedKey, MAX_PHASES, MAX_FIELDS, MAX_INPUTS, MAX_BRIEF_CHARS, MAX_TEMPLATE_CHARS, RECIPE_ROOTS, inferKind,
    normaliseRecipeDoc, synthesizeTableFromPlaceholders, fieldKeysReferenced, validateRecipeDoc, placeholdersOf, renderBrief, briefContext,
    verifyAgainstRoles, rolesOf, phaseObjectsFor, fromDocument,
};
