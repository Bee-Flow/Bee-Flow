import { isWild, sourceProblems } from '@shared/mapping/index.mjs';
import type { LabelPart, MappingSource, Shape } from '@shared/mapping/index.mjs';

/**
 * Dragging a value from the source panel onto a field.
 *
 * The drag carries a STRUCTURED source (a v2 Source plus how to name it),
 * under one media type of our own. A drop reads that type and nothing else:
 * text dragged from anywhere (a selection moved inside a prompt, words from
 * another window) arrives as text/plain, and taking that for a path is the
 * bug where a moved sentence became a broken `{{some words}}` binding. Such
 * a drop is left alone, so the browser's own text move still happens.
 */

export const SOURCE_MIME = 'application/x-beeflow-source';

/** What a dragged value carries. */
export interface DraggedSource {
    source: MappingSource;
    /** How the source panel names it (label.mjs labelParts). */
    labelParts?: LabelPart[];
    /** The display name of the step or trigger it comes from. */
    groupLabel?: string;
    /** The shape the sample shows, so the drop target can pick its defaults. */
    shape?: Shape;
    /** Elements in the sample, for a list or a table. */
    count?: number;
    /** A value of the step's current item (source panel): the pick takes `each`. */
    take?: 'each';
}

type DragEventLike = { dataTransfer: DataTransfer | null; preventDefault: () => void };

/** Start dragging a value: sets our media type only (never text/plain). */
export function startSourceDrag(e: DragEventLike, payload: DraggedSource): void {
    const dt = e.dataTransfer;
    if (!dt) return;
    dt.setData(SOURCE_MIME, JSON.stringify(payload));
    dt.effectAllowed = 'copy';
}

/** Is a value from the source panel being dragged? (Readable during dragover.) */
export function isSourceDrag(e: { dataTransfer: DataTransfer | null }): boolean {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes(SOURCE_MIME);
}

/** dragover: accept a source drag, leave every other drag to the browser. */
export function onSourceDragOver(e: DragEventLike): void {
    if (!isSourceDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

/**
 * A Source as a pick can store it, or null when it cannot be one. A column of
 * a table comes from the source panel with a WILD segment (`rows[*].email`
 * is `['rows', WILD, 'email']`), which a stored pick refuses: a pick maps a
 * key over a list by itself, so the WILD is dropped (`['rows', 'email']`),
 * as sourceFromPath does for a legacy path.
 */
export function pickableSource(source: unknown): MappingSource | null {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const { path } = source as { path?: unknown };
    const clean = Array.isArray(path) && path.some(isWild)
        ? { ...(source as object), path: path.filter(seg => !isWild(seg)) }
        : source;
    return sourceProblems(clean).length ? null : (clean as MappingSource);
}

/**
 * A dragged payload as a DraggedSource, or null when it is not a valid one.
 * A bare Source (`{ root, id?, path }`) is accepted as well: what an older
 * drag source wrote under this type. A column's WILD is dropped (pickableSource).
 */
export function parseDraggedSource(raw: string | null | undefined): DraggedSource | null {
    if (!raw) return null;
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if ('root' in data) data = { source: data };
    const { source: given, labelParts, groupLabel, shape, count, take } = data as Record<string, unknown>;
    const source = pickableSource(given);
    if (!source) return null;
    const out: DraggedSource = { source };
    if (Array.isArray(labelParts)) out.labelParts = labelParts as LabelPart[];
    if (typeof groupLabel === 'string') out.groupLabel = groupLabel;
    if (typeof shape === 'string') out.shape = shape as Shape;
    if (typeof count === 'number' && Number.isFinite(count)) out.count = count;
    if (take === 'each') out.take = 'each';
    return out;
}

/**
 * drop: the dragged source, or null. Only a valid source drop is claimed
 * (preventDefault); anything else, text/plain included, is not ours.
 */
export function readSourceDrop(e: DragEventLike): DraggedSource | null {
    const dragged = parseDraggedSource(e.dataTransfer?.getData(SOURCE_MIME));
    if (dragged) e.preventDefault();
    return dragged;
}
