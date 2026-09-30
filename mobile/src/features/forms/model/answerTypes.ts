/**
 * The answers dashboard's one answer — GET /api/datatables/:id/answers/summary
 * (server/automation/formAnswers/summary.js answersSummary, plus the `form`
 * the route adds) — and a response row read from the answers table
 * (routes/datatables/rows.js).
 */

export type Breakdown =
    | { kind: 'choice'; values: { value: string; n: number; pct: number }[] }
    | { kind: 'yesno'; yes: number; no: number }
    | { kind: 'number'; avg: number | null; min: number | null; max: number | null; p50: number | null }
    | { kind: 'date'; buckets: { bucket: string; n: number }[] }
    | { kind: 'file'; count: number }
    | { kind: 'text'; recent: { rowId: string; value: string; at: string | null }[] };

/** One question of the form, in form order (retired ones last), with the breakdown its type earns. */
export interface AnswerQuestion {
    fieldId: string;
    /** The column key in the answers table — what a row is read by. */
    key: string;
    label: string;
    formType: string;
    columnType: string;
    pageStepId: string | null;
    /** Removed from the form; its answers are still in the table. */
    retired: boolean;
    answered: number;
    skipped: number;
    breakdown: Breakdown | null;
}

export interface AnswerTotals {
    all: number;
    inRange: number;
    last7d: number;
    today: number;
    /** Journeys that reached the end of every page. */
    completed: number;
    open: number;
    lastAt: string | null;
}

/** One of the most recent responses: who, when, and the first three answers. */
export interface RecentResponse {
    rowId: string;
    submittedAt: string | null;
    completedAt: string | null;
    runId: string | null;
    by: { id: string; name: string | null } | null;
    preview: Record<string, string | null>;
}

export interface AnswersSummary {
    table: { id: string; name: string; rowCount: number | null; retentionDays: number | null };
    range: { from: string; to: string; bucket: 'day' | 'week' | 'month' };
    totals: AnswerTotals;
    timeline: { bucket: string; n: number }[];
    questions: AnswerQuestion[];
    recent: RecentResponse[];
}

/** A row of the answers table: system columns plus one per question key. */
export type AnswerRow = Record<string, unknown> & { id: string };

/** One page of rows, newest first, with the cursor of the next. */
export interface AnswerRowsPage {
    rows: AnswerRow[];
    hasMore: boolean;
    nextCursor: string | null;
    total: number | null;
}
