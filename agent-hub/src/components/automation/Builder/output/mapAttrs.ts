import type { DragEvent, MouseEvent } from 'react';
import { appendKey } from '@shared/expr/path.mjs';

/** The drag/click-to-map context an output view threads down its tree. */
export interface MapCtx {
    /** Absolute binding path of the value at this level. */
    path: string;
    onPick?: ((path: string, opts: { raw: boolean }) => void) | null;
}

interface MapAttrs {
    draggable?: boolean;
    onDragStart?: (e: DragEvent<HTMLElement>) => void;
    onClick?: (e: MouseEvent<HTMLElement>) => void;
    title?: string;
    className?: string;
}

/**
 * May a column be drilled open?
 *
 * Expansion used to ride along with `enableDrag`, so in the Run tab and the run
 * history a `tasks` column was an inert "3 records" badge (BFSF-402). Drilling
 * in is READING, not mapping: callers that want the chevron pass
 * `allowExpand`, and leaving the prop off keeps expansion exactly where
 * dragging is.
 */
export function expandEnabled(allowExpand: boolean | null | undefined, map: MapCtx | null): boolean {
    return allowExpand == null ? !!map : !!allowExpand;
}

/**
 * An absolute path plus a RELATIVE one (`[2].subject`, `[*]["content-type"]`,
 * `subject`, `''`), the relative part written by the runtime grammar's
 * writers (appendKey / appendWildcard with an empty prefix).
 */
export function joinPath(base: string, rel: string): string {
    if (!rel) return base;
    if (!base) return rel;
    return rel.startsWith('[') ? `${base}${rel}` : `${base}.${rel}`;
}

// Build draggable/clickable attrs for an element. `rel` is the RELATIVE path
// from where the caller is (`[*].content`, `[2]["Story Points"]`, or `''`),
// joined onto the map's absolute base, so callers always hand out an ABSOLUTE
// binding path the runtime reads. Returns {} when mapping is disabled.
export function mapAttrs(map: MapCtx | null, rel = ''): MapAttrs {
    if (!map) return {};
    const path = joinPath(map.path, rel);
    if (!path) return {};
    const onPick = map.onPick;
    return {
        draggable: true,
        onDragStart: (e) => {
            e.stopPropagation();
            e.dataTransfer.setData('text/plain', path);
            e.dataTransfer.setData('application/x-binding-path', path);
            e.dataTransfer.effectAllowed = 'copy';
        },
        // Alt rides along so a list can be inserted as-is, bypassing the
        // downstream chooser: same convention as the variable tree/picker.
        onClick: onPick ? (e) => { e.stopPropagation(); onPick(path, { raw: e.altKey }); } : undefined,
        title: `Drag or click to map ${path}`,
        className: 'cursor-grab active:cursor-grabbing hover:bg-[var(--accent)]/10 rounded',
    };
}

// Descend the map context to a child (an object key or an array index),
// quoted the way the runtime reads it: `headers["content-type"]`, never
// `headers.content-type`.
export function childMap(map: MapCtx | null, key: string | number): MapCtx | null {
    if (!map) return null;
    return { ...map, path: appendKey(map.path, key) };
}
