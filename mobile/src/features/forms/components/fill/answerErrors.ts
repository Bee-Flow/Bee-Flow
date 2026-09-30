/**
 * What an answer's problem says: the client's own checks (model/contract.ts)
 * and the server's per-field refusals, which arrive as sentences already and
 * are shown as they came.
 */

import { ApiError } from '@/core/api/client';
import type { TranslateFn } from '@/core/i18n';
import { pickCap, type AnswerProblem } from '@/features/forms/model/contract';
import type { FillField } from '@/features/forms/model/fillTypes';

export function problemText(t: TranslateFn, problem: AnswerProblem, field: FillField): string {
    const label = field.label || field.name;
    switch (problem) {
        case 'required':
            return t('mobile.forms.fill.err_required', '{label} is required.', { label });
        case 'email':
            return t('mobile.forms.fill.err_email', 'That is not an email address.');
        case 'number':
            return t('mobile.forms.fill.err_number', 'Enter a number.');
        case 'date':
            return t('mobile.forms.fill.err_date', 'Enter a date like 2026-09-30.');
        case 'choice':
            return t('mobile.forms.fill.err_choice', 'Pick one of the choices.');
        default:
            return t('mobile.forms.fill.err_too_many', 'Choose at most {n}.', { n: pickCap(field) });
    }
}

/** Every client-side problem as its sentence, by field name. */
export function problemsText(t: TranslateFn, problems: Record<string, AnswerProblem>, fields: readonly FillField[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of fields) {
        const problem = problems[field.name];
        if (problem) out[field.name] = problemText(t, problem, field);
    }
    return out;
}

/** A 400's `fields: [{ field, message }]`, by field name — null when the refusal was about the page as a whole. */
export function serverFieldErrors(err: unknown): Record<string, string> | null {
    if (!(err instanceof ApiError)) return null;
    const list = (err.body as { fields?: unknown } | null | undefined)?.fields;
    if (!Array.isArray(list) || !list.length) return null;
    const out: Record<string, string> = {};
    for (const row of list as { field?: unknown; message?: unknown }[]) {
        if (typeof row?.field === 'string' && typeof row.message === 'string') out[row.field] = row.message;
    }
    return Object.keys(out).length ? out : null;
}
