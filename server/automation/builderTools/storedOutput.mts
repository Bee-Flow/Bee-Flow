/**
 * What a step really returned, given the row's output. An output over the row
 * cap is stored as a sentinel with a shape-preserving preview and, when kept,
 * a full copy: the full copy is read, else the preview (`partial`), else
 * nothing. Shared by the dry-run hint (builderTools.js) and
 * builder_inspect_run.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type ReadFullOutput = (runId: string, stepId: string, attempts?: number) => Promise<unknown>;

export interface StoredOutput {
    // The step's output: any JSON value, read by shape at every caller.
    out: any;
    note: string | null;
    partial: boolean;
    truncated: boolean;
}

export async function resolveStoredOutput(
    output: unknown,
    { readFullOutput = null }: { readFullOutput?: ReadFullOutput | null } = {},
): Promise<StoredOutput> {
    const { isTruncatedOutput, fullOutputRefOf } = nodeRequire('../payloadTruncation');
    if (!isTruncatedOutput(output)) return { out: output, note: null, partial: false, truncated: false };
    const ref = fullOutputRefOf(output);
    let full: unknown = null;
    if (ref) {
        const read: ReadFullOutput = readFullOutput || nodeRequire('../../stores/automationStore/runFullOutputs').getRunFullOutput;
        try { full = await read(ref.runId, ref.stepId, ref.attempts); }
        catch { full = null; }
    }
    if (full !== null && full !== undefined) {
        return { out: full, note: 'output over 256 KB: the shape is read from the full copy', partial: false, truncated: true };
    }
    const preview = (output as { preview?: unknown }).preview;
    const out = preview !== undefined ? preview : undefined;
    const note = out === undefined
        ? 'output over 256 KB and not kept: its shape is unknown here — inspect the step\'s tool instead'
        : 'output over 256 KB: the shape is read from a shortened preview (lists cut, keys kept)';
    return { out, note, partial: true, truncated: true };
}
