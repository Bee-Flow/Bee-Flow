/**
 * `images` of an ai_step / data_extraction in the form: the stored list of
 * bindings as rows, and back. A row still blank (a fresh "Add an image") is
 * draft-only: the patch drops it, and an empty list is not written at all, so
 * a step nobody gave images keeps no `images` key. The cap matches the
 * server's (automation/validate/stepRules/imageRules.mts MAX_IMAGE_BINDINGS).
 */
import type { JsonValue } from './types';
import { isEmptyExtractionSource } from './extractionFields';

export const MAX_IMAGE_BINDINGS = 20;

/** A fresh row: an empty reference, so a dragged-in path lands as `{kind:'ref', path}`. */
export function emptyImageBinding(): { kind: 'ref'; path: string } {
    return { kind: 'ref', path: '' };
}

/** The stored list as the editor's rows (always an array). */
export function readImageBindings(raw: unknown): JsonValue[] {
    return Array.isArray(raw) ? (raw as JsonValue[]).slice(0, MAX_IMAGE_BINDINGS) : [];
}

/** The rows as the step stores them: blank rows dropped; none left = undefined (no key). */
export function sanitizeImageBindings(rows: unknown): JsonValue[] | undefined {
    const kept = readImageBindings(rows).filter((b) => !isEmptyExtractionSource(b));
    return kept.length ? kept : undefined;
}
