/**
 * Contract readers for filling a form in (server/routes/automation/formPublic.js).
 * The field shapes are formTriggerContract.js normalizeFields' — the server has
 * already cleaned them, so these read rather than repair; a field with no name
 * is dropped, because it could never be answered.
 */

import { field, pick, shapeOf } from '@/core/api/contract';

import type { FillAck, FillField, FillForm, FillOption, FillSession, FillStart, PickResults, UploadedFile } from '../model/fillTypes';

const readOption: (raw: unknown) => FillOption = shapeOf({ value: field.str(''), label: field.str('') });

const readFieldShape = shapeOf({
    name: field.str(''),
    type: field.str('text'),
    label: field.str(''),
    required: field.bool(false),
    placeholder: field.str(''),
    help: field.str(''),
    options: field.list(readOption),
    accept: field.str(''),
    maxSizeMb: field.num(10),
    source: field.str(''),
    app: field.str(''),
    sourceLabel: field.str(''),
    searchHint: field.str(''),
    multiple: field.bool(false),
    maxItems: field.num(1),
    fileId: field.str(''),
    filename: field.str(''),
    mimeType: field.str(''),
    size: field.numOrNull,
});

export function readFillField(raw: unknown): FillField {
    const f = readFieldShape(raw);
    return { ...f, label: f.label || f.name, options: f.options.filter((o) => o.value !== '').map((o) => ({ ...o, label: o.label || o.value })) };
}

export const readFillFields = (raw: unknown): FillField[] => field.list(readFillField)(raw).filter((f) => f.name !== '');

export function readFillForm(raw: unknown): FillForm {
    return {
        title: field.str('')(pick(raw, 'title')),
        description: field.str('')(pick(raw, 'description')),
        submitLabel: field.str('')(pick(raw, 'submitLabel')),
        successMessage: field.str('')(pick(raw, 'successMessage')),
        theme: field.recordOrNull(pick(raw, 'theme')),
        fields: readFillFields(pick(raw, 'fields')),
        multiPage: field.bool(false)(pick(raw, 'multiPage')),
    };
}

/** GET /form/:token → `{ form, csrf, issuedAt }`. */
export function readFillStart(raw: unknown): FillStart {
    return {
        form: readFillForm(pick(raw, 'form')),
        csrf: field.str('')(pick(raw, 'csrf')),
        issuedAt: field.num(0)(pick(raw, 'issuedAt')),
    };
}

/** POST /form/:token (and /s/:sid) → 202 `{ accepted, sessionId? }`, or 200 `{ accepted, duplicate }`. */
export function readFillAck(raw: unknown): FillAck {
    return {
        accepted: field.bool(false)(pick(raw, 'accepted')),
        sessionId: field.strOrNull(pick(raw, 'sessionId')),
        duplicate: field.bool(false)(pick(raw, 'duplicate')),
    };
}

/**
 * GET /form/:token/s/:sid. An answer this build does not know reads as
 * `error` — never as `working`, which would keep a person waiting on a state
 * nothing will ever leave.
 */
export function readFillSession(raw: unknown): FillSession {
    switch (pick(raw, 'state')) {
        case 'working':
            return { state: 'working', progress: field.strArray(pick(raw, 'progress')), progressNote: field.strOrNull(pick(raw, 'progressNote')) };
        case 'form':
            return {
                state: 'form',
                stepId: field.str('')(pick(raw, 'stepId')),
                form: readFillForm(pick(raw, 'form')),
                csrf: field.str('')(pick(raw, 'csrf')),
                issuedAt: field.num(0)(pick(raw, 'issuedAt')),
            };
        case 'done': {
            const ending = pick(raw, 'ending');
            return { state: 'done', ending: ending && typeof ending === 'object' ? readFillForm(ending) : null };
        }
        case 'expired':
            return { state: 'expired' };
        default:
            return { state: 'error' };
    }
}

export const readUploadedFile: (raw: unknown) => UploadedFile = shapeOf({
    fileId: field.str(''),
    filename: field.str('file'),
    size: field.numOrNull,
    mimeType: field.str(''),
});

const readPickRow = shapeOf({ id: field.str(''), title: field.str(''), subtitle: field.str('') });

/** POST /form/:token/pick → `{ results, error? }`: a refusal is a reason on a 200, not a failure. */
export function readPickResults(raw: unknown): PickResults {
    return {
        results: field.list(readPickRow)(pick(raw, 'results')).filter((r) => r.id !== ''),
        error: field.strOrNull(pick(raw, 'error')),
    };
}

/** The two "into Notebooks" routes answer `{ notebookId }`. */
export const readNotebookId = (raw: unknown): string | null => field.strOrNull(pick(raw, 'notebookId'));
