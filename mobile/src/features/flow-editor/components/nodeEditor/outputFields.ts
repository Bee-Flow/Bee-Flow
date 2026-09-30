/**
 * The edits the output field list makes to its draft — the inline handlers of
 * the web's OutputFieldsEditor (agent-hub `Builder/OutputFieldsEditor.tsx`),
 * lifted out of the JSX so they are pure and tested. The draft itself, and
 * the JSON both faces write, are formState/outputDrafts.ts.
 */

import {
    coerceToKind,
    draftRecords,
    isMultilineText,
    nextRowId,
    rowDraft,
    rowText,
    typedValue,
    type OutFieldKind,
    type OutputRecord,
    type OutputRow,
    type RowEditorKind,
} from '@/features/flow-editor/formState/outputDrafts';

export type RowPatch = Partial<OutputRow>;

/** The JSON text, parsed — undefined when it is not JSON (the raw face then shows it as typed). */
export function parseOutputText(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * What a typed-in field is worth: the web's typedValue, plus the phone's
 * decimal comma. A Dutch number keyboard types `1,5`, and NumberField reads
 * that as 1.5 everywhere else in the editor. What is still not a number stays
 * the text that was typed, as on the web.
 */
export function rowValue(kind: RowEditorKind, text: string): string | number | null {
    if (kind !== 'number') return typedValue(kind, text);
    const value = typedValue(kind, text.trim().replace(',', '.'));
    return typeof value === 'string' ? text : value;
}

/** Typed text into a row: the typing buffer, its value, and the sticky multi-line flag. */
export function textPatch(row: OutputRow, text: string): RowPatch {
    return { text, value: rowValue(row.kind, text), multiline: row.multiline || isMultilineText(text) };
}

/** A row set to another kind converts what is already in it — explicitly, on ask. */
export function kindPatch(row: OutputRow, kind: OutFieldKind): RowPatch {
    const value = coerceToKind(kind, row.value);
    return { kind, value, text: rowText(value) };
}

export function yesNoPatch(on: boolean): RowPatch {
    return { value: on, text: String(on) };
}

export function patchRow(rows: readonly OutputRow[], id: string, patch: RowPatch): OutputRow[] {
    return rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

/** A field added but not named yet: it joins the JSON once it has a name. */
export function blankField(): OutputRow {
    return { id: nextRowId(), key: '', kind: 'text', value: '', text: '' };
}

/** A new record for a list: the first record's field names, each empty. */
export function blankRecord(records: readonly OutputRecord[]): OutputRecord {
    return { id: nextRowId(), rows: (records[0]?.rows || []).map((r) => rowDraft(r.key, '')) };
}

/**
 * The draft beside the text it was built from. The text is re-read into a
 * draft only when somebody ELSE wrote it (the raw face, reopening the sheet),
 * never on the echo of the list's own write: `1.` serialises to `1`, and a
 * draft rebuilt from that would delete the dot on the next keystroke.
 */
export interface DraftSync {
    seed: string;
    records: OutputRecord[];
}

export function syncDraft(sync: DraftSync, text: string): DraftSync {
    return text === sync.seed ? sync : { seed: text, records: draftRecords(text) };
}
