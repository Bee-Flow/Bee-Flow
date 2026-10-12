/**
 * A step's output in the node editor: what a test run produced, what is
 * pinned, and the hand-written output — the pure half of the web's
 * NodeDetailView pin / "Edit output" logic (agent-hub `Builder/
 * NodeDetailView.jsx`, BFSF-408), in its own words (`automations.ndv.*`).
 *
 * A pinned output is replayed instead of running the step, so it is checked
 * before it is saved: it must be JSON, not null (that is Remove), not the
 * server's "output too large" placeholder (that is not data), and small
 * enough — the whole definition is saved on every edit, so one oversized pin
 * would make every later edit to the automation fail.
 */

import { translate as t } from '@/core/i18n';
import { isTruncatedOutput } from '@/features/flow-editor/bindings';
import type { StepPatch } from '@/features/flow-editor/formState';
import { jsonByteLength, MAX_PINNED_BYTES, safeJsonText } from '@/features/flow-editor/formState/outputDrafts';

export type OutputCheck = { ok: true; value: unknown } | { ok: false; error: string };

/** Typed output text → the value to pin, or why it cannot be. */
export function checkOutputText(text: string): OutputCheck {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { ok: false, error: t('automations.ndv.err_invalid_json', 'Invalid JSON: {message}', { message: e instanceof Error ? e.message : String(e) }) };
    }
    if (parsed === null) {
        return {
            ok: false,
            error: t('automations.ndv.err_nothing_to_save', 'Nothing to save — use {remove} to clear the saved output.', { remove: t('common.remove', 'Remove') }),
        };
    }
    if (isTruncatedOutput(parsed)) {
        return {
            ok: false,
            error: t(
                'automations.ndv.err_truncated_placeholder',
                'That is the server\'s "output too large" placeholder, not data. Replace it with the shape the next steps should see.',
            ),
        };
    }
    const bytes = jsonByteLength(parsed);
    if (bytes == null) return { ok: false, error: t('automations.ndv.err_not_json', 'That value cannot be stored as JSON.') };
    if (bytes > MAX_PINNED_BYTES) {
        return {
            ok: false,
            error: t(
                'automations.ndv.err_too_big',
                'Too big to save: {size} KB, and the limit is {limit} KB. Keep a representative record or two — what the steps downstream map against is the shape, not the volume.',
                { size: Math.ceil(bytes / 1024), limit: MAX_PINNED_BYTES / 1024 },
            ),
        };
    }
    return { ok: true, value: parsed };
}

/**
 * `pinnedSource: undefined` on the captured paths: the key drops out of the
 * JSON, so "absent" keeps meaning "captured from a run".
 */
export function pinPatch(output: unknown, now: Date = new Date()): StepPatch {
    return { pinnedOutput: output, pinnedAt: now.toISOString(), pinnedSource: undefined };
}

export function editedOutputPatch(value: unknown, now: Date = new Date()): StepPatch {
    return { pinnedOutput: value, pinnedAt: now.toISOString(), pinnedSource: 'edited' };
}

export function unpinPatch(): StepPatch {
    return { pinnedOutput: null, pinnedAt: null, pinnedSource: undefined };
}

export interface OutputState {
    pinned: boolean;
    /** Typed by the author, not captured — a fabricated value must never read like a capture. */
    edited: boolean;
    /** A run produced real output that could be pinned. */
    canPin: boolean;
}

export function outputState(step: { pinnedOutput?: unknown; pinnedSource?: unknown }, runOutput: unknown): OutputState {
    const pinned = step.pinnedOutput !== undefined && step.pinnedOutput !== null;
    return {
        pinned,
        edited: pinned && step.pinnedSource === 'edited',
        canPin: runOutput !== undefined && runOutput !== null && !isTruncatedOutput(runOutput),
    };
}

/**
 * What the Output tab shows, and what Edit opens on: a pinned or hand-written
 * output over the last test run's. It is what the steps after this one see —
 * a pinned step replays it instead of running — and the last thing the
 * author saved; showing the older run instead read as if Save had not taken.
 */
export function shownOutput(step: { pinnedOutput?: unknown }, runOutput: unknown): unknown {
    return step.pinnedOutput !== undefined && step.pinnedOutput !== null ? step.pinnedOutput : runOutput;
}

/** What the output editor opens on: the run's output, else the pin, else the described sample. */
export function outputSeed(runOutput: unknown, pinned: unknown, sample: unknown): string {
    return safeJsonText(runOutput ?? pinned ?? sample ?? {});
}
