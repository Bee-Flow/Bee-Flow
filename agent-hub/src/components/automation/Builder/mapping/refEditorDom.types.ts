import type { LabelLookup } from './refTokens';

/** id → step type, as the pill tint reads it. */
export type TypeLookup = { get?(id: string | undefined): string | undefined };

export interface PillOptions {
    stepLabelById?: LabelLookup | null;
    stepTypeById?: TypeLookup | null;
    doc?: Document;
}

export interface FragmentOptions extends PillOptions {
    mode?: string;
}

/** Where `insertAtCaret` puts the nodes: an explicit range, the window and document to read the caret from, and whether to pad with spaces. */
export interface InsertOptions {
    win?: Window;
    doc?: Document;
    range?: Range | null;
    spaced?: boolean;
}
