/**
 * How a step's output is drawn in the Output tab and on a test-run card.
 *
 * Readable first, as the Automations screens draw the same run: a table, a
 * record's fields, a list or the text itself (ValuePreview); and a value too
 * nested for any of those as a tree that reads as words ("3 items", "Yes",
 * "From email"). The exact JSON tree — `{3}`, `[5]`, quoted strings, `null` —
 * is one tap away ("Show raw") whenever it says something the readable form
 * does not.
 */

import { describeValue, isProse } from '@/features/automations';

/** Nothing, the readable preview (ValuePreview), or the tree. */
export type OutputBody = 'none' | 'preview' | 'tree';

export interface OutputView {
    body: OutputBody;
    /** The tree reads as words rather than as JSON. */
    readableTree: boolean;
    /** There is a raw form worth switching to. */
    canToggle: boolean;
}

export function outputView(value: unknown, raw: boolean): OutputView {
    if (value === null || value === undefined) return { body: 'none', readableTree: false, canToggle: false };
    const kind = describeValue(value).kind;
    // A single literal reads the same either way, so it gets no control.
    const canToggle = kind === 'rows' || kind === 'record' || kind === 'list' || kind === 'raw' || (kind === 'scalar' && isProse(value));
    if (raw && canToggle) return { body: 'tree', readableTree: false, canToggle };
    if (kind === 'empty') return { body: 'none', readableTree: false, canToggle: false };
    if (kind === 'raw') return { body: 'tree', readableTree: true, canToggle };
    return { body: 'preview', readableTree: false, canToggle };
}
