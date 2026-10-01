import type { DragEvent, MouseEvent } from 'react';
import { WILD, formatSegment, parseLegacyPath, type Source, type SourceSegment } from '@shared/mapping/index.mjs';

/** What a pick from an output view hands its caller beside the legacy path. */
export interface PickOpts {
    raw: boolean;
    /** The value as a Source (`{root, id?, path}`), when the base is one. */
    source?: Source | null;
}

/** The drag/click-to-map context an output view threads down its tree. */
export interface MapCtx {
    /** Absolute binding path of the value at this level. */
    path: string;
    /** The same value as a Source; derived from `path` when absent. */
    source?: Source | null;
    onPick?: ((path: string, opts: PickOpts) => void) | null;
}

/** The drag type a Source travels under, beside the legacy path. */
export const SOURCE_MIME = 'application/x-beeflow-source';

/**
 * A table column id (`output.content`, `attachments[*].name`: the dotted form
 * the table keys its columns by) as path segments. A key that itself holds a
 * dot cannot be told apart in that form; such a column maps as the nested
 * keys it reads as.
 */
export function colSegments(col: string): SourceSegment[] {
    const out: SourceSegment[] = [];
    for (const part of String(col).split('.')) {
        const m = /^(.*?)((?:\[\*\])*)$/.exec(part) as RegExpExecArray;
        if (m[1]) out.push(m[1]);
        for (let i = 0; i < m[2].length / 3; i++) out.push(WILD);
    }
    return out;
}

/**
 * The value `segs` below the map's own: its legacy path, written by the one
 * quoting rule (source.mjs formatSegment), and its Source. Null when a key
 * cannot be written: such a value is shown, never offered to map, because a
 * path that resolves to nothing is worse than no button.
 */
export function pickTarget(map: MapCtx | null, segs: SourceSegment[] = []): { path: string; source: Source | null } | null {
    if (!map) return null;
    let path = map.path;
    for (const seg of segs) {
        const written = formatSegment(seg);
        if (written === null) return null;
        path += written;
    }
    const base = map.source ?? parseLegacyPath(map.path);
    const source = base ? ({ ...base, path: [...base.path, ...segs] } as Source) : null;
    return { path, source };
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

// Build draggable/clickable attrs for an element. `segs` are the RELATIVE
// steps from the map's own value (`[WILD, 'content']`, `[2, 'subject']`, or
// none); the attrs carry the ABSOLUTE binding path and its Source. Returns {}
// when mapping is disabled or a key cannot be written.
export function mapAttrs(map: MapCtx | null, segs: SourceSegment[] = []): MapAttrs {
    const target = pickTarget(map, segs);
    if (!map || !target || !target.path) return {};
    const { path, source } = target;
    const onPick = map.onPick;
    return {
        draggable: true,
        onDragStart: (e) => {
            e.stopPropagation();
            e.dataTransfer.setData('text/plain', path);
            e.dataTransfer.setData('application/x-binding-path', path);
            if (source) e.dataTransfer.setData(SOURCE_MIME, JSON.stringify(source));
            e.dataTransfer.effectAllowed = 'copy';
        },
        // Alt rides along so a list can be inserted as-is, bypassing the
        // downstream chooser: same convention as the variable tree/picker.
        onClick: onPick ? (e) => { e.stopPropagation(); onPick(path, { raw: e.altKey, source }); } : undefined,
        title: `Drag or click to map ${path}`,
        className: 'cursor-grab active:cursor-grabbing hover:bg-[var(--accent)]/10 rounded',
    };
}

// Descend the map context to a child (object key / array index). Null below
// a key that cannot be written, so nothing under it is offered.
export function childMap(map: MapCtx | null, segs: SourceSegment[]): MapCtx | null {
    const target = pickTarget(map, segs);
    if (!map || !target) return null;
    return { ...map, path: target.path, source: target.source };
}
