/**
 * extractFormState for the spreadsheet steps: Read table and Edit table.
 * The defaults are the server's (core/automationModel/tableOps).
 */
import type { FormRecord, TypeExtractor } from '../types';

const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const days = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 7);

export const tableExtractors: Record<string, TypeExtractor> = {
    read_table: (step, base) => ({
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
    }),
    table: (step, base): FormRecord => ({
        ...base,
        forEach: step.forEach || null,
        source: clone(step.source ?? null),
        // Cloned: the editor edits the draft, and must not reach into the saved step.
        ops: Array.isArray(step.ops) ? clone(step.ops) : [],
        name: typeof step.name === 'string' ? step.name : '',
        expiresInDays: days(step.expiresInDays),
    }),
};
