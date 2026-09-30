/**
 * Turning the answers summary into what the dashboard draws — the pure half
 * of the web's AnswersDashboard.jsx, QuestionBreakdowns.jsx and
 * ResponseDrawer.jsx.
 */

import type { AnswerQuestion, AnswersSummary, RecentResponse } from './answerTypes';

type Bucket = 'day' | 'week' | 'month';

function monthOf(bucket: string): Date | null {
    // The server's month bucket is 'YYYY-MM' (to_char); a day is 'YYYY-MM-DD'.
    const m = /^(\d{4})-(\d{2})/.exec(bucket);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : null;
}

/** A timeline bucket as an axis label: "12 Mar", "wk 10 Mar", "Mar 26". */
export function bucketLabel(bucket: string, kind: Bucket | string | null | undefined): string {
    const s = String(bucket || '');
    if (kind === 'month') {
        const month = monthOf(s);
        return month ? month.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : s;
    }
    const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
    if (Number.isNaN(d.getTime())) return s;
    const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return kind === 'week' ? `wk ${day}` : day;
}

/** A date question's month bucket: "Mar 2026". */
export function monthLabel(bucket: string): string {
    const month = monthOf(String(bucket || ''));
    return month ? month.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : String(bucket);
}

/** Questions still on the form, and the retired ones (their answers are still in the table). */
export function splitQuestions(questions: readonly AnswerQuestion[]): { live: AnswerQuestion[]; retired: AnswerQuestion[] } {
    return { live: questions.filter((q) => !q.retired), retired: questions.filter((q) => q.retired) };
}

/** A form with later pages shows "Completed all pages" instead of "Last response". */
export function isMultiPage(summary: Pick<AnswersSummary, 'totals' | 'questions'>): boolean {
    return summary.totals.open > 0 || summary.questions.some((q) => q.pageStepId);
}

/** "73%", or null when nothing came in this period. */
export function completionPercent(totals: { completed: number; inRange: number }): string | null {
    return totals.inRange ? `${Math.round((totals.completed / totals.inRange) * 100)}%` : null;
}

/** The first three non-empty answers of a recent response, as one line. */
export function previewLine(response: Pick<RecentResponse, 'preview'>): string {
    return Object.values(response.preview || {})
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map(String)
        .slice(0, 3)
        .join(' · ');
}

/** A number as a dashboard cell shows it, "—" for none. */
export function numberCell(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return new Intl.NumberFormat().format(value);
}

/** Whether an answer counts as given. */
export const isAnswered = (value: unknown): boolean => value !== null && value !== undefined && value !== '';

/**
 * One cell of a response, as text: the web's cellText, except that a file
 * answer reads as its filename rather than as a JSON blob.
 */
export function answerText(value: unknown, columnType: string, words: { yes: string; no: string }): string {
    if (!isAnswered(value)) return '—';
    if (columnType === 'bool') return value ? words.yes : words.no;
    if (Array.isArray(value)) return value.map((v) => answerText(v, '', words)).join(', ');
    if (typeof value === 'object') {
        const named = (value as { filename?: unknown; title?: unknown }).filename ?? (value as { title?: unknown }).title;
        return typeof named === 'string' && named ? named : JSON.stringify(value);
    }
    return String(value);
}

/** The largest count in a choice breakdown: the scale the bars are drawn against. */
export function choiceScale(values: readonly { n: number }[]): number {
    return values.reduce((max, v) => Math.max(max, v.n), 0) || 1;
}
