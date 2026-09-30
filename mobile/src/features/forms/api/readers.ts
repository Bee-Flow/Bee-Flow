/**
 * Contract readers for the forms directory and one form
 * (server/routes/automation/crud.js GET /forms and GET /forms/:automationId,
 * PUT /forms/:id/audience, POST /forms/ai/draft).
 *
 * `mine` reads fail-closed: anything but `true` keeps the owner's calls off.
 * A missing `canOpen` reads as true, as the web reads it: a row from before
 * the flag is one the visitor gate lets through, and that gate still decides.
 * An audience the server did not describe reads as 'org' — the rule a page
 * row from before audiences was made under.
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import { readFillFields } from './fillReaders';
import type { AiFormDraft, FormAnswersInfo, FormAudience, FormDetail, FormPageSummary, FormQuestions, FormSummary } from '../model/types';

export function readAudience(raw: unknown): FormAudience {
    return {
        mode: field.oneOf(['org', 'restricted'] as const, 'org')(pick(raw, 'mode')),
        groups: field.strArray(pick(raw, 'groups')),
        users: field.strArray(pick(raw, 'users')),
    };
}

const readWriteError = shapeOf({ code: field.strOrNull, message: field.strOrNull });

const readAnswersShape = shapeOf({
    collecting: field.bool(false),
    datatableId: field.strOrNull,
    grade: field.strOrNull,
    rowCount: field.numOrNull,
    linked: field.bool(false),
    lastWriteError: nullable(readWriteError),
});

export const readAnswersInfo = (raw: unknown): FormAnswersInfo | null => nullable(readAnswersShape)(raw);

const SUMMARY_SPEC = {
    id: field.str(''),
    url: field.str(''),
    automationId: field.str(''),
    triggerStepId: field.strOrNull,
    title: field.str(''),
    description: field.strOrNull,
    live: field.bool(false),
    submissions: field.num(0),
    lastSeenAt: field.strOrNull,
    createdAt: field.strOrNull,
    mine: field.bool(false),
    // A row from before the flag is one the visitor gate lets through (the web's reading); the gate itself still decides.
    canOpen: field.bool(true),
    audience: readAudience,
    answers: readAnswersInfo,
};

const readFormRows: (raw: unknown) => FormSummary[] = shapeListOf(SUMMARY_SPEC);

export function readForms(raw: unknown): FormSummary[] {
    return readFormRows(pick(raw, 'forms'));
}

function readQuestions(raw: unknown): FormQuestions {
    return {
        title: field.str('')(pick(raw, 'title')),
        description: field.str('')(pick(raw, 'description')),
        submitLabel: field.str('')(pick(raw, 'submitLabel')),
        successMessage: field.str('')(pick(raw, 'successMessage')),
        collect: field.bool(false)(pick(raw, 'collect')),
        fields: readFillFields(pick(raw, 'fields')),
        theme: field.recordOrNull(pick(raw, 'theme')),
    };
}

const readPage = (raw: unknown): FormPageSummary => ({
    stepId: field.str('')(pick(raw, 'stepId')),
    label: field.str('')(pick(raw, 'label')),
    fields: readFillFields(pick(raw, 'fields')),
});

const readDetailExtras = shapeOf({
    isActive: field.bool(false),
    isDraft: field.bool(true),
    questions: readQuestions,
    pages: field.list(readPage),
    definition: (raw: unknown) => field.recordOrNull<Record<string, unknown>>(raw),
    routineTitle: field.str(''),
});

const readSummary = shapeOf(SUMMARY_SPEC);

/** GET /forms/:automationId → `{ form }`; null when the answer carries no form. */
export function readFormDetail(raw: unknown): FormDetail | null {
    const form = pick(raw, 'form');
    if (!form || typeof form !== 'object') return null;
    const summary = readSummary(form);
    if (!summary.automationId) return null;
    return { ...summary, ...readDetailExtras(form) };
}

/** PUT /forms/:id/audience → `{ audience }`, the owner's view of what was saved. */
export const readAudienceResponse = (raw: unknown): FormAudience => readAudience(pick(raw, 'audience'));

/** POST /forms/ai/draft → `{ draft: { form, notes } }`; null when no usable form came back. */
export function readAiDraft(raw: unknown): AiFormDraft | null {
    const draft = pick(raw, 'draft');
    const form = field.recordOrNull(pick(draft, 'form'));
    if (!form || !Array.isArray(form.fields)) return null;
    return { form: form as AiFormDraft['form'], notes: field.strOrNull(pick(draft, 'notes')) };
}
