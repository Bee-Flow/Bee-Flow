/**
 * What a field announces to the Input panel when it takes focus: the panel
 * parks `insert` so a click or drag on an upstream field lands in THIS field.
 */
interface FocusFieldHandle {
    id?: string;
    label?: string;
    insert: (path: string) => void;
}

/** The broadcast callback the settings forms hand down to every field. */
export type OnFocusField = (handle: FocusFieldHandle | null) => void;
