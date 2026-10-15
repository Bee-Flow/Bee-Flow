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

/** A pill reads as a word for spacing purposes. */
export interface InsertOptions {
    win?: Window;
    doc?: Document;
    range?: Range | null;
    spaced?: boolean;
}
