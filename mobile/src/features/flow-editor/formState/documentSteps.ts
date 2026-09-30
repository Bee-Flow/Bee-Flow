/**
 * Drafts and patches for the steps that make a file: a document, a slide, a
 * presentation, a filled-in document. The expiry clamp (1..90 days) must match
 * validate.js and the AI builder. From agent-hub
 * `Builder/flow/settings/formState.js`; pinned by formState.lockstep.test.ts.
 */

import { finiteOr, or, plainCopy, roundedClamp } from './read';
import type { Extractor, FormDraft, Patcher, StepPatch } from './types';

export { extractSlide, patchSlide } from './slideStep';

export const extractGenerateDocument: Extractor = (step, base) => ({
    ...base,
    content: or(step.content, ''),
    contentFormat: step.contentFormat === 'html' ? 'html' : 'markdown',
    format: step.format === 'docx' ? 'docx' : 'pdf',
    title: or(step.title, ''),
    fileName: or(step.fileName, ''),
    expiresInDays: finiteOr(step.expiresInDays, 7),
});

export const patchGenerateDocument: Patcher = (patch, _step, draft) => {
    patch.content = or(draft.content, '');
    patch.contentFormat = draft.contentFormat === 'html' ? 'html' : 'markdown';
    patch.format = draft.format === 'docx' ? 'docx' : 'pdf';
    patch.title = or(draft.title, '');
    patch.fileName = or(draft.fileName, '');
    patch.expiresInDays = roundedClamp(draft.expiresInDays, 7, 1, 90);
};

// The look: '' means "the house style decides".
const LOOK_KEYS = ['preset', 'accent', 'background', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logo', 'logoPlacement', 'footerText'];

function lookDraft(step: Record<string, unknown>): FormDraft {
    return Object.fromEntries(LOOK_KEYS.map((k) => [k, or(step[k], '')]));
}

/** `slides` is ONE source (a template) or a LIST of references; the mode follows the shape. */
export const extractPresentation: Extractor = (step, base) => ({
    ...base,
    slidesMode: Array.isArray(step.slides) ? 'list' : 'source',
    slides: typeof step.slides === 'string' ? step.slides : '',
    slideRows: Array.isArray(step.slides) ? step.slides.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))) : [],
    title: or(step.title, ''),
    subtitle: or(step.subtitle, ''),
    fileName: or(step.fileName, ''),
    format: step.format === 'pdf' ? 'pdf' : 'pptx',
    houseStyle: step.houseStyle !== false,
    ...lookDraft(step),
    // Three states: '' follows the house style, true/false overrides it.
    slideNumbers: typeof step.slideNumbers === 'boolean' ? String(step.slideNumbers) : '',
    template: step.template === 'none' ? 'none' : '',
    saveCopy: step.saveCopy === true,
    copyName: or(step.copyName, ''),
    expiresInDays: finiteOr(step.expiresInDays, 7),
});

/** Blank rows drop; a row that reads as JSON is kept as that inline slide object. */
function slideRowsPatch(rows: unknown): unknown[] {
    return ((rows as unknown[]) || [])
        .map((r) => (typeof r === 'string' ? r.trim() : r))
        .filter((r) => r !== '' && r !== null && r !== undefined)
        .map((r) => {
            if (typeof r !== 'string' || !/^\s*\{/.test(r)) return r;
            try {
                return JSON.parse(r) as unknown;
            } catch {
                return r;
            }
        });
}

function lookPatch(patch: StepPatch, draft: FormDraft): void {
    // Look fields travel as a value or ABSENT — never ''.
    for (const k of LOOK_KEYS) {
        const v = typeof draft[k] === 'string' ? (draft[k] as string).trim() : '';
        patch[k] = v || undefined;
    }
}

function slideNumbersPatch(v: unknown): boolean | undefined {
    if (v === 'true') return true;
    return v === 'false' ? false : undefined;
}

export const patchPresentation: Patcher = (patch, _step, draft) => {
    patch.slides = draft.slidesMode === 'list' ? slideRowsPatch(draft.slideRows) : or(draft.slides, '');
    patch.title = or(draft.title, '');
    patch.subtitle = or(draft.subtitle, '');
    patch.fileName = or(draft.fileName, '');
    patch.format = draft.format === 'pdf' ? 'pdf' : 'pptx';
    patch.houseStyle = draft.houseStyle !== false;
    lookPatch(patch, draft);
    patch.slideNumbers = slideNumbersPatch(draft.slideNumbers);
    patch.template = draft.template === 'none' ? 'none' : undefined;
    patch.saveCopy = draft.saveCopy === true ? true : undefined;
    patch.copyName = draft.saveCopy === true && draft.copyName ? draft.copyName : undefined;
    patch.expiresInDays = roundedClamp(draft.expiresInDays, 7, 1, 90);
};

function fillFormat(v: unknown): string {
    if (v === 'pdf') return 'pdf';
    return v === 'pptx' ? 'pptx' : '';
}

export const extractFillDocument: Extractor = (step, base) => ({
    ...base,
    documentId: or(step.documentId, ''),
    documentVersionId: or(step.documentVersionId, ''),
    sectionOverrides: { ...((step.sectionOverrides as object) || {}) },
    // A cache of the picked document's name, never a second source of truth.
    documentName: or(step.documentName, ''),
    values: plainCopy(step.values),
    fileName: or(step.fileName, ''),
    format: fillFormat(step.format),
    saveCopy: step.saveCopy === true,
    copyName: or(step.copyName, ''),
    expiresInDays: finiteOr(step.expiresInDays, 7),
});

/** Blank values are dropped, so "which placeholders are unbound" stays answerable. */
function filledValues(values: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((values as object) || {})) {
        const val = typeof v === 'string' ? v.trim() : v;
        if (val !== '' && val !== undefined && val !== null) out[k] = val;
    }
    return out;
}

export const patchFillDocument: Patcher = (patch, _step, draft) => {
    patch.documentId = or(draft.documentId, '');
    if (draft.documentVersionId) patch.documentVersionId = draft.documentVersionId;
    patch.sectionOverrides = { ...((draft.sectionOverrides as object) || {}) };
    patch.documentName = or(draft.documentName, '');
    patch.values = filledValues(draft.values);
    patch.fileName = or(draft.fileName, '');
    patch.format = draft.format === 'pdf' || draft.format === 'pptx' ? draft.format : undefined;
    patch.saveCopy = draft.saveCopy === true;
    patch.copyName = draft.saveCopy === true ? or(draft.copyName, '') : '';
    patch.expiresInDays = roundedClamp(draft.expiresInDays, 7, 1, 90);
};

