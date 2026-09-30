/**
 * Contract readers for a form's answers: the dashboard summary
 * (server/automation/formAnswers/summary.js via routes/datatables/answers.js)
 * and the answers table's rows (routes/datatables/rows.js).
 *
 * A breakdown whose kind this build does not know reads as null — the card
 * then says "no answers in this period" rather than guessing at a chart.
 */

import { field, pick, shapeOf } from '@/core/api/contract';

import type { AnswerQuestion, AnswerRow, AnswerRowsPage, AnswersSummary, Breakdown, RecentResponse } from '../model/answerTypes';

const num = field.num(0);
const readCount = shapeOf({ bucket: field.str(''), n: num });
const readChoice = shapeOf({ value: field.str(''), n: num, pct: num });
const readTextAnswer = shapeOf({ rowId: field.str(''), value: field.str(''), at: field.strOrNull });

function readBreakdown(raw: unknown): Breakdown | null {
    switch (pick(raw, 'kind')) {
        case 'choice':
            return { kind: 'choice', values: field.list(readChoice)(pick(raw, 'values')) };
        case 'yesno':
            return { kind: 'yesno', yes: num(pick(raw, 'yes')), no: num(pick(raw, 'no')) };
        case 'number':
            return {
                kind: 'number',
                avg: field.numOrNull(pick(raw, 'avg')),
                min: field.numOrNull(pick(raw, 'min')),
                max: field.numOrNull(pick(raw, 'max')),
                p50: field.numOrNull(pick(raw, 'p50')),
            };
        case 'date':
            return { kind: 'date', buckets: field.list(readCount)(pick(raw, 'buckets')) };
        case 'file':
            return { kind: 'file', count: num(pick(raw, 'count')) };
        case 'text':
            return { kind: 'text', recent: field.list(readTextAnswer)(pick(raw, 'recent')) };
        default:
            return null;
    }
}

const readQuestion: (raw: unknown) => AnswerQuestion = shapeOf({
    fieldId: field.str(''),
    key: field.str(''),
    label: field.str(''),
    formType: field.str(''),
    columnType: field.str(''),
    pageStepId: field.strOrNull,
    retired: field.bool(false),
    answered: num,
    skipped: num,
    breakdown: readBreakdown,
});

function readPreview(raw: unknown): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    const source = field.record<Record<string, unknown>>({})(raw);
    for (const [key, value] of Object.entries(source)) out[key] = typeof value === 'string' ? value : null;
    return out;
}

const readBy = (raw: unknown) => (raw && typeof raw === 'object' ? { id: field.str('')(pick(raw, 'id')), name: field.strOrNull(pick(raw, 'name')) } : null);

const readRecent: (raw: unknown) => RecentResponse = shapeOf({
    rowId: field.str(''),
    submittedAt: field.strOrNull,
    completedAt: field.strOrNull,
    runId: field.strOrNull,
    by: readBy,
    preview: readPreview,
});

const readTotals = shapeOf({
    all: num,
    inRange: num,
    last7d: num,
    today: num,
    completed: num,
    open: num,
    lastAt: field.strOrNull,
});

export function readAnswersSummary(raw: unknown): AnswersSummary {
    return {
        table: shapeOf({ id: field.str(''), name: field.str(''), rowCount: field.numOrNull, retentionDays: field.numOrNull })(pick(raw, 'table')),
        range: shapeOf({ from: field.str(''), to: field.str(''), bucket: field.oneOf(['day', 'week', 'month'] as const, 'day') })(pick(raw, 'range')),
        totals: readTotals(pick(raw, 'totals')),
        timeline: field.list(readCount)(pick(raw, 'timeline')),
        questions: field.list(readQuestion)(pick(raw, 'questions')).filter((q) => q.key !== ''),
        recent: field.list(readRecent)(pick(raw, 'recent')).filter((r) => r.rowId !== ''),
    };
}

/** A row is the table's own record; only its id is required to open it. */
export function readAnswerRow(raw: unknown): AnswerRow | null {
    const row = field.recordOrNull(raw);
    if (!row) return null;
    const id = row.id;
    return typeof id === 'string' || typeof id === 'number' ? { ...row, id: String(id) } : null;
}

/** GET /:id/rows/:rowId → `{ row }`. */
export const readAnswerRowResponse = (raw: unknown): AnswerRow | null => readAnswerRow(pick(raw, 'row'));

/** GET /:id/rows → `{ rows, hasMore, nextCursor, total }`. */
export function readAnswerRows(raw: unknown): AnswerRowsPage {
    const rows = Array.isArray(pick(raw, 'rows')) ? (pick(raw, 'rows') as unknown[]) : [];
    return {
        rows: rows.map(readAnswerRow).filter((r): r is AnswerRow => r !== null),
        hasMore: field.bool(false)(pick(raw, 'hasMore')),
        nextCursor: field.strOrNull(pick(raw, 'nextCursor')),
        total: field.numOrNull(pick(raw, 'total')),
    };
}
