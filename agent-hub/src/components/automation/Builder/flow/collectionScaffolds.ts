import type { BuiltStep } from '../applyAddNode.types';
import { ROUTE_STEP_NAME } from './stepDisplayName';

/**
 * What a freshly dropped list or table step starts with, by step type.
 *
 * Collection ops seed an EMPTY arrayRef (C20): auto-map fills it from the
 * nearest upstream array on connect, and an unfilled one shows a visible amber
 * `arrayRef_missing` chip (draft warning, blocks activation) instead of the old
 * 'trigger.output.items' literal that silently resolved to nothing and ran the
 * op as a green no-op on most triggers.
 *
 * Their `field` seeds are empty for the SAME reason (A18): 'id' and 'amount'
 * were placeholder guesses that looked configured, and a field that is on no
 * item makes Aggregate emit a list of undefineds and Summarize total nothing
 * and call it 0. There is no honest default for "which field": the panel asks,
 * and offers the real fields of the source list as one-click picks.
 * `aggregate.field_missing` / `summarize.field_missing` are both in
 * COMPLETENESS_CODES, so blank autosaves fine and warns amber until it is
 * answered.
 *
 * The two table steps carry the server's defaults
 * (core/automationModel/tableOps/readTableSpec.js).
 */
interface Scaffold { label: string; fields: () => Record<string, unknown> }

const SCAFFOLDS: Record<string, Scaffold> = {
    filter: { label: ROUTE_STEP_NAME, fields: () => ({ arrayRef: '', expr: 'true' }) },
    limit: { label: 'Limit', fields: () => ({ arrayRef: '', count: 10, mode: 'first' }) },
    dedupe: { label: 'Remove duplicates', fields: () => ({ arrayRef: '' }) },
    flatten: { label: 'Flatten a list', fields: () => ({ arrayRef: '', keepEmpty: false }) },
    read_table: {
        label: 'Read table',
        fields: () => ({
            source: null, sheets: 'all', headerRow: 1, provenanceSheet: 'auto', format: 'auto', delimiter: 'auto',
            skipHiddenSheets: true, expiresInDays: 7,
        }),
    },
    table: { label: 'Edit table', fields: () => ({ source: null, ops: [], expiresInDays: 7 }) },
    aggregate: { label: 'Aggregate', fields: () => ({ arrayRef: '', field: '' }) },
    summarize: { label: 'Summarize', fields: () => ({ arrayRef: '', field: '', op: 'sum' }) },
};

/** Seed `step` for a list or table step type. False when `kind` is not one of them. */
export function applyCollectionScaffold(step: BuiltStep, payload: { kind: string; label?: string }): boolean {
    const scaffold = SCAFFOLDS[payload.kind];
    if (!scaffold) return false;
    Object.assign(step, scaffold.fields());
    step.label = payload.label || scaffold.label;
    return true;
}
