import type { OnFocusField } from '../../../mapping/focusField.types';

/** A question as the editor holds it: only the keys the editors read are named, the rest passes through. */
export interface EditorField {
    name?: string;
    type?: string;
    label?: string;
    help?: string;
    required?: boolean;
    placeholder?: string;
    options?: unknown;
    optionsFrom?: SourceSpec | null;
    fieldsFrom?: SourceSpec | null;
    content?: string;
    showIf?: string;
    min?: number | string;
    max?: number | string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    patternMessage?: string;
    minSelected?: number;
    maxSelected?: number;
    [key: string]: unknown;
}

/** Where a choice list or a per-item question list comes from (mirrors the server's source spec). */
export interface SourceSpec {
    ref: string;
    value?: string;
    label?: string;
    hint?: string;
    limit?: number;
}

/** What every question-level editor receives from its card. */
export interface FieldEditorProps {
    field: EditorField;
    /** Zero-based position in the page's list. */
    index: number;
    onChange: (changes: Partial<EditorField>) => void;
    /** True on a later page, where run data exists; false on the trigger's first page. */
    allowVariables?: boolean;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
}
