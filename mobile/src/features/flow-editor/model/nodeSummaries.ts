/**
 * The one line under a node's name — a port of the web builder's
 * flow/nodeSummaries.js, pinned by summaries.lockstep.test.ts.
 *
 * Each returns a plain string, or `{ muted }` for the "not answered yet"
 * state the card renders in italic. Never a raw config key, and a list step
 * always names the LIST it acts on, so four list steps off one search do not
 * read as four identical cards.
 */

import { humanizeExpression, humanizeFieldKey } from './displayHelpers';
import { formatWaitDuration } from './waitDuration';

export type Summary = string | { muted: string };
type Step = Record<string, unknown>;
interface Ctx {
    stepLabelById?: Map<string, string> | null;
    tableNameById?: Record<string, string> | null;
    kbNameById?: Record<string, string> | null;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function fromList(arrayRef: unknown, stepLabelById: Ctx['stepLabelById'], preposition = 'of'): string {
    if (!arrayRef) return '';
    const name = humanizeExpression(arrayRef, stepLabelById ?? null) || s(arrayRef);
    return name ? ` ${preposition} ${name}` : '';
}

const NO_LIST = { muted: 'no list picked yet' };

export function limitSummary(step: Step, { stepLabelById }: Ctx = {}): Summary {
    if (!step.arrayRef) return { ...NO_LIST };
    const n = Number(step.count);
    const count = Number.isFinite(n) ? n : 0;
    if (count === 0) return `Nothing${fromList(step.arrayRef, stepLabelById, 'from')}`;
    return `${step.mode === 'last' ? 'Last' : 'First'} ${count}${fromList(step.arrayRef, stepLabelById)}`;
}

export function dedupeSummary(step: Step, { stepLabelById }: Ctx = {}): Summary {
    if (!step.arrayRef) return { ...NO_LIST };
    return step.keyField
        ? `One per ${humanizeFieldKey(step.keyField)}${fromList(step.arrayRef, stepLabelById, '· from')}`
        : `Identical items removed${fromList(step.arrayRef, stepLabelById, 'from')}`;
}

export function aggregateSummary(step: Step, { stepLabelById }: Ctx = {}): Summary {
    if (!step.arrayRef) return { ...NO_LIST };
    if (!step.field) return { muted: 'pick which field to collect' };
    return `${humanizeFieldKey(step.field)} from every item${fromList(step.arrayRef, stepLabelById)}`;
}

const DATATABLE_VERB: Record<string, string> = {
    find_rows: 'Find rows in',
    add_row: 'Add a row to',
    save_row: 'Add or update a row in',
    update_rows: 'Update rows in',
    delete_rows: 'Delete rows from',
};

/** The table's NAME, never its id; muted until the catalog names it. */
export function datatableSummary(step: Step, { tableNameById }: Ctx = {}): Summary {
    if (!step.datatableId) return { muted: 'no table picked yet' };
    const name = tableNameById?.[s(step.datatableId)];
    const verb = DATATABLE_VERB[s(step.op)] || (DATATABLE_VERB.find_rows as string);
    const where = Array.isArray(step.where) && step.where.length
        ? ` where ${(step.where as { field?: string }[]).map((w) => w && w.field).filter(Boolean).map(humanizeFieldKey).join(' and ')}`
        : '';
    if (!name) {
        return tableNameById ? { muted: `${verb.toLowerCase()} a table you can no longer see` } : { muted: `${verb.toLowerCase()} a table` };
    }
    if (step.op === 'save_row' && !step.matchColumn) return { muted: 'pick the column that decides add or update' };
    if ((step.op === 'update_rows' || step.op === 'delete_rows') && !where) {
        return { muted: 'add a condition — without one this changes every row' };
    }
    return `${verb} ${name}${where}`;
}

export function knowledgeWriteSummary(step: Step, { kbNameById }: Ctx = {}): Summary {
    if (!step.knowledgeBaseId) return { muted: 'no knowledge base picked yet' };
    const where = kbNameById?.[s(step.knowledgeBaseId)] || 'a knowledge base';
    if (!String(step.content || '').trim()) return { muted: `nothing to write into ${where} yet` };
    return `Save into ${where}`;
}

const SUMMARIZE_VERB: Record<string, string> = { sum: 'Total', count: 'Count', avg: 'Average', min: 'Lowest', max: 'Highest' };

export function summarizeSummary(step: Step, { stepLabelById }: Ctx = {}): Summary {
    if (!step.arrayRef) return { ...NO_LIST };
    const op = s(step.op) || 'sum';
    if (op === 'count') return `How many items${fromList(step.arrayRef, stepLabelById, 'in')}`;
    if (!step.field) return { muted: 'pick which field to add up' };
    return `${SUMMARIZE_VERB[op] || op} of ${humanizeFieldKey(step.field)}${fromList(step.arrayRef, stepLabelById, '· from')}`;
}

const DATETIME_PHRASE: Record<string, (st: Step) => string> = {
    now: () => 'Today’s date and time',
    parse: () => 'Read a date from text',
    format: (st) => (st.format ? `Reformat as ${s(st.format)}` : 'Reformat a date'),
    diff: (st) => `Time between two dates${st.unit ? ` in ${s(st.unit)}` : ''}`,
    extract: (st) => (st.part ? `Take the ${humanizeFieldKey(st.part).toLowerCase()}` : 'Take part of a date'),
};

const DATETIME_ADD: Record<string, string> = { addDays: 'day', addHours: 'hour', addMinutes: 'minute' };

export function dateTimeSummary(step: Step): string {
    const op = s(step.op) || 'now';
    const unit = DATETIME_ADD[op];
    if (unit) {
        const n = Number(step.amount);
        if (!Number.isFinite(n) || n === 0) return `Add or subtract ${unit}s`;
        const abs = Math.abs(n);
        return `${n < 0 ? 'Subtract' : 'Add'} ${abs} ${unit}${abs === 1 ? '' : 's'}`;
    }
    const phrase = Object.prototype.hasOwnProperty.call(DATETIME_PHRASE, op) ? DATETIME_PHRASE[op] : undefined;
    return phrase ? phrase(step) : humanizeFieldKey(op);
}

/** " · preset, no logo" — the look a document or deck overrides, or nothing. */
function lookSuffix(step: Step): string {
    if (!step.preset && step.logo !== 'none') return '';
    const noLogo = step.logo === 'none';
    return ` · ${s(step.preset || '')}${step.preset && noLogo ? ', ' : ''}${noLogo ? 'no logo' : ''}`;
}

export function generateDocumentSummary(step: Step): Summary {
    const kind = step.format === 'docx' ? 'Word' : 'PDF';
    if (!step.content) return { muted: `${kind} — no text chosen yet` };
    const name = step.fileName || step.title;
    return `${name ? `${kind} · ${s(name)}` : kind}${lookSuffix(step)}`;
}

export function slideSummary(step: Step): Summary {
    const chart = step.chart && typeof step.chart === 'object' ? (step.chart as { type?: string }) : null;
    const has = s(step.title).trim() || s(step.content).trim() || s(step.image).trim() || chart || step.stats;
    if (!has) return { muted: 'no title or content yet' };
    const visual = chart ? ` · ${chart.type || 'column'} chart` : step.stats ? ' · KPI tiles' : step.layout === 'timeline' ? ' · timeline' : '';
    const per = step.forEach ? ' · one per item' : '';
    return `${s(step.title).trim() || 'untitled'}${visual}${per}`;
}

export function presentationSummary(step: Step): Summary {
    const kind = step.format === 'pdf' ? 'PDF deck' : 'PowerPoint';
    const sl = step.slides;
    const empty = sl === undefined || sl === null || (typeof sl === 'string' && !sl.trim()) || (Array.isArray(sl) && sl.length === 0);
    if (empty) return { muted: `${kind} — no slides chosen yet` };
    const name = step.fileName || step.title;
    return `${name ? `${kind} · ${s(name)}` : kind}${lookSuffix(step)}`;
}

export function fillDocumentSummary(step: Step): Summary {
    if (!step.documentId) return { muted: 'no document chosen yet' };
    const bound = Object.keys((step.values as object) || {}).length;
    const name = s(step.documentName || step.fileName || '');
    const values = bound ? `${bound} value${bound === 1 ? '' : 's'}` : 'nothing bound yet';
    return name ? `${name} · ${values}` : `PDF · ${values}`;
}

export function dataExtractionSummary(step: Step | null | undefined): Summary {
    const names = (Array.isArray(step?.fields) ? (step.fields as { name?: unknown }[]) : [])
        .map((f) => (f && typeof f.name === 'string' ? f.name.trim() : ''))
        .filter(Boolean);
    if (!names.length) return { muted: 'no fields yet' };
    const shown = names.slice(0, 6);
    const rest = names.length - shown.length;
    return rest > 0 ? `${shown.join(' · ')} · +${rest}` : shown.join(' · ');
}

export function waitSummary(step: Step): Summary {
    return formatWaitDuration(step.seconds) || { muted: 'no wait set' };
}

/** An approval's summary is the QUESTION (its first line), not the mechanism. */
export function approvalSummary(step: Step): Summary {
    const q = typeof step.prompt === 'string' ? (step.prompt.trim().split('\n')[0] as string).trim() : '';
    if (!q) return { muted: 'no question yet' };
    return q.length > 60 ? `${q.slice(0, 59)}…` : q;
}

/** The deadline chip: approval.expiresInHours → legacy top-level → 7 days; 0 is none. */
export function approvalDeadline(step: Step | null | undefined): string {
    const approval = step?.approval as { expiresInHours?: unknown } | undefined;
    const h = Number(approval?.expiresInHours ?? step?.expiresInHours ?? 168);
    if (!Number.isFinite(h) || h <= 0) return 'No deadline';
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
    const days = Math.round(h / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
}
