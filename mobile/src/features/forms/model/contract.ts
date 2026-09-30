/**
 * The form contract, as far as the phone needs it — a port of
 * server/automation/formTriggerContract.js (and the two limits it borrows
 * from appTriggerContract.js and formPickSources.js), pinned by
 * contract.lockstep.test.ts: the constants are read out of the server source,
 * and the validation below is run beside the server's own coerceSubmission on
 * the same answers.
 *
 * Client-side checks are a courtesy, not a gate: the server re-checks every
 * answer against the DECLARED fields and answers 400 with per-field messages,
 * which the filling screen shows in the same place. What this buys is that a
 * person hears "that is not an email address" before a round trip, not after.
 *
 * One addition to the server's rules: a number typed with one decimal comma
 * ("1,5", as Dutch is written) is read as a decimal and sent with a dot. The
 * server's Number() refuses the comma, so the answer is normalised before it
 * is checked here and before it is sent.
 */

import { normaliseDecimal } from '@/shared/lib/decimal';

import type { Answer, Answers, FillField, FileAnswer, PickAnswer } from './fillTypes';

export const FIELD_TYPES = Object.freeze([
    'text', 'textarea', 'email', 'number', 'date', 'select', 'checkbox', 'file', 'app_pick', 'download', 'notebook',
] as const);
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types that DISPLAY something instead of collecting it: never submitted, never required. */
export const DISPLAY_FIELD_TYPES: readonly string[] = Object.freeze(['download', 'notebook']);
/** Display fields that point at a generated file by id. */
export const FILE_FIELD_TYPES: readonly string[] = Object.freeze(['download', 'notebook']);

export const MAX_FIELDS = 40;
export const MAX_LABEL_LEN = 120;
export const MAX_TEXT_LEN = 2000;
export const MAX_OPTIONS = 50;
export const MAX_OPTION_LEN = 120;
export const MAX_UPLOAD_MB = 25;
export const DEFAULT_UPLOAD_MB = 10;
export const MAX_TEXTAREA_LEN = 20000;
/** appTriggerContract.js MAX_STRING_VALUE: a short text answer's ceiling. */
export const MAX_STRING_VALUE = 5000;
/** formPickSources.js MAX_PICKS: the most records one question may take. */
export const MAX_PICKS = 10;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDisplayField = (f: { type?: unknown } | null | undefined): boolean => DISPLAY_FIELD_TYPES.includes(String(f?.type));
export const isFileField = (f: { type?: unknown } | null | undefined): boolean => FILE_FIELD_TYPES.includes(String(f?.type));

/** What an unanswered field carries (the server's emptyValue). */
export function emptyValue(field: Pick<FillField, 'type' | 'multiple'>): Answer {
    if (field.type === 'checkbox') return false;
    if (field.type === 'file') return null;
    if (field.type === 'app_pick') return field.multiple ? [] : null;
    return '';
}

/** The form's key set with every answer empty; display fields have no key at all. */
export function initialValues(fields: readonly FillField[]): Answers {
    const out: Answers = {};
    for (const f of fields) {
        if (!isDisplayField(f)) out[f.name] = emptyValue(f);
    }
    return out;
}

const picksOf = (value: Answer): PickAnswer[] => {
    if (Array.isArray(value)) return value;
    return value && typeof value === 'object' && value.kind === 'app_pick' ? [value] : [];
};

/** The server's isBlank, over the answer as this screen holds it. */
export function isBlank(field: Pick<FillField, 'type'>, value: Answer | undefined): boolean {
    if (field.type === 'checkbox') return value !== true;
    if (field.type === 'file') return !value;
    if (field.type === 'app_pick') return picksOf(value ?? null).length === 0;
    return typeof value !== 'string' || value.trim() === '';
}

/** Why an answer would be refused; each has its sentence in the filling screen. */
export type AnswerProblem = 'required' | 'email' | 'number' | 'date' | 'choice' | 'too_many';

/** How many records a pick question takes: one, or its own cap (never below one). */
export const pickCap = (field: Pick<FillField, 'multiple' | 'maxItems'>): number => (field.multiple ? Math.max(1, field.maxItems) : 1);

type Check = (field: FillField, text: string, value: Answer) => AnswerProblem | null;

/** coerceFieldValue's refusals, per type, for what a person can type or pick. */
const CHECKS: Readonly<Record<string, Check>> = {
    email: (_field, text) => (EMAIL_RE.test(text) ? null : 'email'),
    number: (_field, text) => (Number.isFinite(Number(normaliseDecimal(text))) ? null : 'number'),
    date: (_field, text) => (DATE_RE.test(text) ? null : 'date'),
    select: (field, text) => (field.options.some((o) => o.value === text) ? null : 'choice'),
    app_pick: (field, _text, value) => (picksOf(value).length > pickCap(field) ? 'too_many' : null),
};

/** One answer against its field. */
export function answerProblem(field: FillField, value: Answer | undefined): AnswerProblem | null {
    if (isDisplayField(field)) return null;
    const answer = value ?? null;
    if (isBlank(field, answer)) return field.required ? 'required' : null;
    const check = CHECKS[field.type];
    return check ? check(field, typeof answer === 'string' ? answer.trim() : '', answer) : null;
}

/** Every refused answer, by field name — empty when the page may be sent. */
export function validateAnswers(fields: readonly FillField[], values: Answers): Record<string, AnswerProblem> {
    const out: Record<string, AnswerProblem> = {};
    for (const field of fields) {
        const problem = answerProblem(field, values[field.name]);
        if (problem) out[field.name] = problem;
    }
    return out;
}

/**
 * The answer as it goes over the wire: an unanswered number or pick travels as
 * null (the server's "left out"), and a number's decimal comma as a dot.
 */
function wireValue(field: FillField, value: Answer | undefined): unknown {
    if (value === undefined) return null;
    if (field.type === 'number') return typeof value === 'string' && value.trim() !== '' ? normaliseDecimal(value.trim()) : null;
    if (field.type === 'app_pick') {
        const picks = picksOf(value);
        if (!picks.length) return null;
        return field.multiple ? picks : picks[0];
    }
    if (field.type === 'file') {
        const file = value as FileAnswer | null;
        return file ? { kind: 'form_upload', fileId: file.fileId } : null;
    }
    return value;
}

/** The answers of one page, keyed by the DECLARED fields only (display fields send nothing). */
export function answersBody(fields: readonly FillField[], values: Answers): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
        if (!isDisplayField(field)) out[field.name] = wireValue(field, values[field.name]);
    }
    return out;
}
