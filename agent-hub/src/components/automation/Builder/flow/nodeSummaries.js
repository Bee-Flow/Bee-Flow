/**
 * The one line under a node's name on the canvas.
 *
 * The well-made cards (Loop, Condition, Notification, the privacy trio) already
 * say something a person can read. The Lists and Data cards printed raw config
 * instead: "by deep-equal", a bare field name in monospace, "addDays", "7200s",
 * "first 10". Worse, none of them named the LIST they act on — so four Lists
 * nodes hanging off one search read as four identical cards with different
 * titles, and the only way to tell them apart was to open each one.
 *
 * Pure string functions, no React, so they can be tested directly and reused by
 * any surface that needs a one-line description of a step.
 *
 * `stepLabelById` comes from flow/layout.js via every node's `data`, and turns
 * `steps.s1.output.results` into `‹Search email›.results`.
 */

import { humanizeExpression, humanizeFieldKey } from './displayHelpers';
import { formatWaitDuration } from './waitDuration';
import { listPathLabel } from '../mapping/listPathLabel';

/**
 * The source list, named the way the user named the step that made it.
 * `stepLabelById` is the Map from displayHelpers.buildStepLabelMap. The ‹›
 * marks stay: they are the canvas's existing way of saying "this bit is a step
 * you named", and LoopNode already reads that way.
 */
function listName(arrayRef, stepLabelById) {
    if (!arrayRef) return null;
    return humanizeExpression(arrayRef, stepLabelById) || arrayRef;
}

/** "… of ‹Search email›", or nothing at all when no list is picked yet. */
function fromList(arrayRef, stepLabelById, preposition = 'of') {
    const name = listName(arrayRef, stepLabelById);
    return name ? ` ${preposition} ${name}` : '';
}

/**
 * Each returns either a plain string, or `{ muted: string }` for the
 * "not answered yet" state the card renders in italic. Never a raw config key.
 */

export function limitSummary(step, { stepLabelById } = {}) {
    if (!step.arrayRef) return { muted: 'no list picked yet' };
    const n = Number(step.count);
    const count = Number.isFinite(n) ? n : 0;
    if (count === 0) return `Nothing${fromList(step.arrayRef, stepLabelById, 'from')}`;
    const which = step.mode === 'last' ? 'Last' : 'First';
    return `${which} ${count}${fromList(step.arrayRef, stepLabelById)}`;
}

export function dedupeSummary(step, { stepLabelById } = {}) {
    if (!step.arrayRef) return { muted: 'no list picked yet' };
    // "by deep-equal" was the old line: accurate, and the single most
    // developer-only string on the canvas.
    return step.keyField
        ? `One per ${humanizeFieldKey(step.keyField)}${fromList(step.arrayRef, stepLabelById, '· from')}`
        : `Identical items removed${fromList(step.arrayRef, stepLabelById, 'from')}`;
}

/** "From Read many ▸ Messages": the outer list a flatten works through, or "Pick a list" (muted). */
/** @param {any} step @param {{ stepLabelById?: Map<string, string>, t?: any }} [opts] */
export function flattenSummary(step, { stepLabelById, t = null } = {}) {
    const route = String(step?.arrayRef || '');
    const wild = route.indexOf('[*]');
    const outer = wild > 0 ? route.slice(0, wild) : route.trim();
    if (!outer) return { muted: t ? t('flatten_node.card.pick', 'Pick a list') : 'Pick a list' };
    const source = listPathLabel(outer, stepLabelById, t, { compact: true }) || outer;
    return t ? t('flatten_node.card.from', 'From {source}', { source }) : `From ${source}`;
}

export function aggregateSummary(step, { stepLabelById } = {}) {
    if (!step.arrayRef) return { muted: 'no list picked yet' };
    if (!step.field) return { muted: 'pick which field to collect' };
    return `${humanizeFieldKey(step.field)} from every item${fromList(step.arrayRef, stepLabelById)}`;
}

/**
 * What a datatable node says on the canvas without being opened.
 *
 * The table's NAME, never its id — a user picked "Customers" from a list and
 * must see "Customers" back. `tableNameById` is threaded from the catalog; when
 * it has not loaded yet the summary stays muted rather than showing tbl_1a2b3c,
 * which would read as an error.
 */
const DATATABLE_VERB = {
    find_rows: 'Find rows in',
    add_row: 'Add a row to',
    save_row: 'Add or update a row in',
    update_rows: 'Update rows in',
    delete_rows: 'Delete rows from',
};

export function datatableSummary(step, { tableNameById } = {}) {
    if (!step.datatableId) return { muted: 'no table picked yet' };
    const name = tableNameById?.[step.datatableId];
    const verb = DATATABLE_VERB[step.op] || DATATABLE_VERB.find_rows;
    const where = Array.isArray(step.where) && step.where.length
        ? ` where ${step.where.map(w => w && w.field).filter(Boolean).map(humanizeFieldKey).join(' and ')}`
        : '';
    // Was reached on EVERY datatable card until the name map was threaded
    // through buildLayout (K10): `tableNameById` was never supplied, so a
    // perfectly good table always read as one you could no longer see. Kept as
    // a fallback because a genuinely deleted table still lands here — but only
    // once the catalog has actually loaded.
    if (!name) {
        return tableNameById
            ? { muted: `${verb.toLowerCase()} a table you can no longer see` }
            : { muted: `${verb.toLowerCase()} a table` };
    }
    if (step.op === 'save_row' && !step.matchColumn) return { muted: 'pick the column that decides add or update' };
    if ((step.op === 'update_rows' || step.op === 'delete_rows') && !where) {
        return { muted: 'add a condition — without one this changes every row' };
    }
    return `${verb} ${name}${where}`;
}

/**
 * A knowledge write, in the order the author needs to see it: WHERE it lands,
 * and whether it will keep leaving new documents behind.
 *
 * The sourceUri line earns its place on the card. Without one, an automation that
 * runs nightly writes a new document every night and nothing about the
 * knowledge base says why it grew — and that is invisible until somebody opens
 * the base months later.
 */
export function knowledgeWriteSummary(step, { kbNameById } = {}) {
    if (!step.knowledgeBaseId) return { muted: 'no knowledge base picked yet' };
    // The name is ENRICHMENT, not a requirement. An absent one usually means
    // the catalog has not arrived yet, so "a knowledge base you can no longer
    // see" would be a card accusing the author of something on every first
    // paint. Say the true, less specific thing instead.
    const name = kbNameById?.[step.knowledgeBaseId] || null;
    const where = name ? name : 'a knowledge base';
    if (!String(step.content || '').trim()) return { muted: `nothing to write into ${where} yet` };
    return `Save into ${where}`;
}

const SUMMARIZE_VERB = { sum: 'Total', count: 'Count', avg: 'Average', min: 'Lowest', max: 'Highest' };

export function summarizeSummary(step, { stepLabelById } = {}) {
    if (!step.arrayRef) return { muted: 'no list picked yet' };
    const op = step.op || 'sum';
    // count ignores the field entirely — saying "Count of Amount" would be a lie.
    if (op === 'count') return `How many items${fromList(step.arrayRef, stepLabelById, 'in')}`;
    if (!step.field) return { muted: 'pick which field to add up' };
    const verb = SUMMARIZE_VERB[op] || op;
    return `${verb} of ${humanizeFieldKey(step.field)}${fromList(step.arrayRef, stepLabelById, '· from')}`;
}

const DATETIME_PHRASE = {
    now: () => 'Today’s date and time',
    parse: () => 'Read a date from text',
    format: (s) => (s.format ? `Reformat as ${s.format}` : 'Reformat a date'),
    diff: (s) => `Time between two dates${s.unit ? ` in ${s.unit}` : ''}`,
    extract: (s) => (s.part ? `Take the ${humanizeFieldKey(s.part).toLowerCase()}` : 'Take part of a date'),
};

const DATETIME_ADD = { addDays: 'day', addHours: 'hour', addMinutes: 'minute' };

export function dateTimeSummary(step) {
    const op = step.op || 'now';
    const unit = DATETIME_ADD[op];
    if (unit) {
        const n = Number(step.amount);
        // A negative amount is a subtraction and should read as one.
        if (!Number.isFinite(n) || n === 0) return `Add or subtract ${unit}s`;
        const verb = n < 0 ? 'Subtract' : 'Add';
        const abs = Math.abs(n);
        return `${verb} ${abs} ${unit}${abs === 1 ? '' : 's'}`;
    }
    const phrase = DATETIME_PHRASE[op];
    // An unknown op is a hand-edited or imported definition; show it plainly
    // rather than pretending to understand it.
    return phrase ? phrase(step) : humanizeFieldKey(op);
}

/**
 * "PDF · from step 3" — the format, and where the text comes from. A step with
 * no content bound yet says so, because that is the one thing that stops it
 * producing anything.
 */
export function generateDocumentSummary(step) {
    const kind = step.format === 'docx' ? 'Word' : 'PDF';
    if (!step.content) return { muted: `${kind} — no text chosen yet` };
    const name = step.fileName || step.title;
    const look = step.preset || step.logo === 'none' ? ` · ${step.preset || ''}${step.preset && step.logo === 'none' ? ', ' : ''}${step.logo === 'none' ? 'no logo' : ''}` : '';
    return `${name ? `${kind} · ${name}` : kind}${look}`;
}

/** "Omzet" / "one per item" — the slide's title, or what it still needs. */
export function slideSummary(step) {
    const chart = step.chart && typeof step.chart === 'object' ? step.chart : null;
    const has = (step.title || '').trim() || (step.content || '').trim() || (step.image || '').trim() || chart || step.stats;
    if (!has) return { muted: 'no title or content yet' };
    const visual = chart ? ` · ${chart.type || 'column'} chart` : (step.stats ? ' · KPI tiles' : (step.layout === 'timeline' ? ' · timeline' : ''));
    const per = step.forEach ? ' · one per item' : '';
    return `${(step.title || '').trim() || 'untitled'}${visual}${per}`;
}

/** "PowerPoint · Q3 review" — the file kind and its name, or what it still needs. */
export function presentationSummary(step) {
    const kind = step.format === 'pdf' ? 'PDF deck' : 'PowerPoint';
    const s = step.slides;
    const empty = s === undefined || s === null || (typeof s === 'string' && !s.trim()) || (Array.isArray(s) && s.length === 0);
    if (empty) return { muted: `${kind} — no slides chosen yet` };
    const name = step.fileName || step.title;
    const look = step.preset || step.logo === 'none' ? ` · ${step.preset || ''}${step.preset && step.logo === 'none' ? ', ' : ''}${step.logo === 'none' ? 'no logo' : ''}` : '';
    return `${name ? `${kind} · ${name}` : kind}${look}`;
}

/**
 * "Factuur · 6 values" — which document, and how much of it is bound. A step
 * with no document chosen says so: that is the one thing that stops it
 * producing anything, and unlike the values it cannot be inferred from a card.
 *
 * The document's NAME is carried on the step as `documentName` when the picker
 * wrote one; a step the AI built has only the id, which is not worth showing —
 * the editor resolves it.
 */
export function fillDocumentSummary(step) {
    if (!step.documentId) return { muted: 'no document chosen yet' };
    const bound = Object.keys(step.values || {}).length;
    const name = step.documentName || step.fileName || '';
    const values = bound ? `${bound} value${bound === 1 ? '' : 's'}` : 'nothing bound yet';
    return name ? `${name} · ${values}` : `PDF · ${values}`;
}

/**
 * "datum · totaal · leverancier" — the fields the step pulls out, by name, so
 * two extraction cards under one loop read differently. Six names fit a card
 * line; past that the tail is counted rather than listed. A step with no named
 * field yet says so — that, and an unbound source, are the two things that
 * stop it extracting anything.
 */
export function dataExtractionSummary(step) {
    const names = (Array.isArray(step?.fields) ? step.fields : [])
        .map(f => (f && typeof f.name === 'string' ? f.name.trim() : ''))
        .filter(Boolean);
    if (!names.length) return { muted: 'no fields yet' };
    const shown = names.slice(0, 6);
    const rest = names.length - shown.length;
    return rest > 0 ? `${shown.join(' · ')} · +${rest}` : shown.join(' · ');
}

export function waitSummary(step) {
    const phrase = formatWaitDuration(step.seconds);
    return phrase || { muted: 'no wait set' };
}

/**
 * An approval's summary is the QUESTION, not the mechanism.
 *
 * Every other pause card can describe itself by its config ("2 hours", "first
 * 10"); this one is asking a person for a decision, so the only thing worth a
 * canvas line is what is being decided. First line only — a multi-line prompt
 * is a paragraph of context whose opening sentence is the ask.
 */
export function approvalSummary(step) {
    const q = typeof step.prompt === 'string' ? step.prompt.trim().split('\n')[0].trim() : '';
    if (!q) return { muted: 'no question yet' };
    return q.length > 60 ? `${q.slice(0, 59)}…` : q;
}

/**
 * The deadline chip. Mirrors the engine's resolution order
 * (approval.expiresInHours → legacy top-level → 7-day default) so the card
 * never claims a deadline the run would not enforce. 0 means no deadline.
 */
export function approvalDeadline(step) {
    const raw = step?.approval?.expiresInHours ?? step?.expiresInHours ?? 168;
    const h = Number(raw);
    if (!Number.isFinite(h) || h <= 0) return 'No deadline';
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
    const days = Math.round(h / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
}
