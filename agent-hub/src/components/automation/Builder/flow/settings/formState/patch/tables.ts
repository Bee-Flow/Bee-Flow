/**
 * buildPatch for the spreadsheet steps. The operations of an Edit table are
 * written as a whole: one list, in order, as the editor shows it.
 */
import { clamp } from '../primitives';
import { applyForEachPatch } from '../stepOptions';
import type { TypePatcher } from '../types';

const wholeDays = (v: unknown) => clamp(Math.round(Number(v)) || 7, 1, 90);

export const tablePatchers: Record<string, TypePatcher> = {
    read_table: (patch, step, draft) => {
        patch.source = draft.source ?? undefined;
        patch.sheets = Array.isArray(draft.sheets) ? draft.sheets.map(String).filter(Boolean) : (draft.sheets === 'first' ? 'first' : 'all');
        patch.headerRow = clamp(Math.round(Number(draft.headerRow)) || 1, 1, 50);
        patch.provenanceSheet = typeof draft.provenanceSheet === 'string' && draft.provenanceSheet.trim() ? draft.provenanceSheet.trim() : 'auto';
        patch.format = draft.format || 'auto';
        patch.delimiter = draft.delimiter || 'auto';
        patch.skipHiddenSheets = draft.skipHiddenSheets !== false;
        patch.expiresInDays = wholeDays(draft.expiresInDays);
        applyForEachPatch(patch, step, draft);
    },
    table: (patch, step, draft) => {
        patch.source = draft.source ?? undefined;
        patch.ops = (Array.isArray(draft.ops) ? draft.ops : []).filter(op => op && typeof op === 'object');
        patch.name = typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : undefined;
        patch.expiresInDays = wholeDays(draft.expiresInDays);
        applyForEachPatch(patch, step, draft);
    },
};
