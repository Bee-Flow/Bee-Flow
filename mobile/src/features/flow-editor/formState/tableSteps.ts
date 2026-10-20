/**
 * Drafts and patches for the spreadsheet steps: Read table and Edit table. The
 * defaults are the server's (core/automationModel/tableOps). From agent-hub
 * `Builder/flow/settings/formState/{extract,patch}/tables.ts`; pinned by
 * formState.lockstep.test.ts.
 */

import { applyForEachPatch } from './common';
import { clamp } from './read';
import type { Extractor, FormDraft, Patcher } from './types';

const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const days = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 7);
const wholeDays = (v: unknown) => clamp(Math.round(Number(v)) || 7, 1, 90);

export const extractReadTable: Extractor = (step, base): FormDraft => ({
    ...base,
    forEach: step.forEach || null,
    source: clone(step.source ?? null),
    sheets: Array.isArray(step.sheets) ? step.sheets.map(String) : (step.sheets === 'first' ? 'first' : 'all'),
    headerRow: typeof step.headerRow === 'number' ? step.headerRow : 1,
    provenanceSheet: typeof step.provenanceSheet === 'string' && step.provenanceSheet ? step.provenanceSheet : 'auto',
    format: typeof step.format === 'string' && step.format ? step.format : 'auto',
    delimiter: typeof step.delimiter === 'string' && step.delimiter ? step.delimiter : 'auto',
    skipHiddenSheets: step.skipHiddenSheets !== false,
    expiresInDays: days(step.expiresInDays),
});

export const patchReadTable: Patcher = (patch, step, draft) => {
    patch.source = draft.source ?? undefined;
    patch.sheets = Array.isArray(draft.sheets) ? draft.sheets.map(String).filter(Boolean) : (draft.sheets === 'first' ? 'first' : 'all');
    patch.headerRow = clamp(Math.round(Number(draft.headerRow)) || 1, 1, 50);
    patch.provenanceSheet = typeof draft.provenanceSheet === 'string' && draft.provenanceSheet.trim() ? draft.provenanceSheet.trim() : 'auto';
    patch.format = draft.format || 'auto';
    patch.delimiter = draft.delimiter || 'auto';
    patch.skipHiddenSheets = draft.skipHiddenSheets !== false;
    patch.expiresInDays = wholeDays(draft.expiresInDays);
    applyForEachPatch(patch, step, draft);
};

export const extractTable: Extractor = (step, base): FormDraft => ({
    ...base,
    forEach: step.forEach || null,
    source: clone(step.source ?? null),
    // Cloned: the editor edits the draft, and must not reach into the saved step.
    ops: Array.isArray(step.ops) ? clone(step.ops) : [],
    name: typeof step.name === 'string' ? step.name : '',
    expiresInDays: days(step.expiresInDays),
});

export const patchTable: Patcher = (patch, step, draft) => {
    patch.source = draft.source ?? undefined;
    patch.ops = (Array.isArray(draft.ops) ? draft.ops : []).filter((op) => op && typeof op === 'object');
    patch.name = typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : undefined;
    patch.expiresInDays = wholeDays(draft.expiresInDays);
    applyForEachPatch(patch, step, draft);
};
