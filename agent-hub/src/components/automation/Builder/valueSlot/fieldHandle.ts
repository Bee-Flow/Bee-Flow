import { useLayoutEffect, useEffect, useMemo, useRef } from 'react';
import type { LabelPart, MappingSource, Source } from '@shared/mapping/index.mjs';
import type { DraggedSource } from './slotDnd';

/**
 * What a field hands the step drawer when it gets focus, so a value clicked
 * in "Comes in" lands in it: `insert` takes the legacy path (and what the
 * source panel knows about the value), `accept` a structured source.
 *
 * The drawer keeps the LAST handle it was given and calls it later, after
 * the field has re-rendered any number of times (typed into, switched to a
 * formula). So a handle must never close over the state of the render that
 * made it: useFieldHandle builds one stable object whose methods call the
 * field's latest functions. That is the fix for the old focus handle that
 * read the text and mode from focus time and wiped what was typed since.
 */

export interface InsertOpts {
    /** Alt held: insert the value as it is, ask nothing. */
    raw?: boolean;
    /** Where a drop landed, to insert there rather than at the caret. */
    at?: { x: number; y: number } | null;
    /** The value as a Source. A table column's has a WILD segment, which a pick drops (slotDnd.pickableSource). */
    source?: Source | MappingSource | null;
    labelParts?: LabelPart[];
    shape?: string;
    count?: number;
}

export interface FieldHandle {
    id: string;
    label: string;
    insert: (path: string, opts?: InsertOpts) => void;
    accept?: (value: DraggedSource) => void;
}

export interface FieldActions {
    insert: (path: string, opts?: InsertOpts) => void;
    accept?: (value: DraggedSource) => void;
}

// After every render, before the browser paints, so no click reaches an older one.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** One stable handle whose methods always run the field's latest `actions`. */
export function useFieldHandle(id: string, label: string, actions: FieldActions): FieldHandle {
    const latest = useRef(actions);
    useIsoLayoutEffect(() => { latest.current = actions; });
    return useMemo(() => ({
        id,
        label,
        insert: (path: string, opts?: InsertOpts) => latest.current.insert(path, opts),
        accept: (value: DraggedSource) => {
            const { accept } = latest.current;
            if (accept) accept(value);
        },
    }), [id, label]);
}
