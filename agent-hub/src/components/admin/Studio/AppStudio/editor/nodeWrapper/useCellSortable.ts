import { useSortable } from '@dnd-kit/sortable';
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AppNode } from '../../inspector/appDefinition';
import { useDropHint } from '../dropHint';

/**
 * The cell's place in drag & drop, and whether it is the PRIMARY instance of
 * its node.
 *
 * A node under a repeating container is rendered ONCE PER ROW, all copies
 * carrying the same node.id. Exactly one of them — the first in document
 * order, i.e. the first row — owns the editor affordances; the others are
 * read-only echoes. Without this the canvas grows a toolbar and a grip per
 * row and dnd-kit sees one sortable id registered N times (its registry is
 * keyed by id, so the copies would also unregister each other).
 * Ownership can only be read off the mounted DOM, so every instance starts
 * as an echo and the layout effect below promotes the first one — never the
 * other way round, which would flash a duplicated real id.
 */
export function useCellSortable(node: AppNode) {
    const instanceId = useId();
    const [primary, setPrimary] = useState(false);
    // Where a live drag would land relative to THIS node ('before' | 'after' |
    // 'inside'), or null. Only the PRIMARY instance draws it: a node under a
    // repeater is mounted once per row and every copy shares node.id, so an
    // ungated hint painted N parallel lines for one drop.
    const dropEdgeHint = useDropHint(node.id);
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
        id: primary ? node.id : `${node.id}::${instanceId}`,
        data: { type: 'node', node },
        disabled: !primary,
    });
    const dropEdge = primary ? dropEdgeHint : null;

    // Own DOM ref (to measure the parent grid) that also feeds dnd-kit.
    const cellRef = useRef<HTMLDivElement | null>(null);
    const setCellRef = useCallback((el: HTMLDivElement | null) => {
        cellRef.current = el;
        setNodeRef(el);
    }, [setNodeRef]);

    // Re-checked after every commit: rows appear, disappear and reorder as the
    // repeater's data changes, so "am I the first copy?" is never cached.
    useLayoutEffect(() => {
        const el = cellRef.current;
        if (!el) return;
        const first = el.ownerDocument?.querySelector(`[data-node-id="${node.id}"]`);
        setPrimary(!first || first === el);
    });

    return { primary, dropEdge, attributes, listeners, setActivatorNodeRef, isDragging, cellRef, setCellRef };
}
