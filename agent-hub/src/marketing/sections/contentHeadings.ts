/**
 * The heading outline of a Content block (Content.tsx): which element holds
 * the block's h2, and the size class each heading keeps.
 */
import type { ContentData } from './contentMigration';
import type { RenderElement } from './Content.types';

/**
 * Where the block's first heading is: the first text element, in column then
 * element order, that has one. In the editor an empty text element counts too
 * (it renders a placeholder heading). [-1, -1] when there is none.
 */
export function firstHeadingAt(columns: ContentData['columns'], editable: boolean): [number, number] {
    const cols = Array.isArray(columns) ? columns : [];
    for (let colIdx = 0; colIdx < cols.length; colIdx++) {
        const els = cols[colIdx]?.elements || [];
        for (let elIdx = 0; elIdx < els.length; elIdx++) {
            const el = els[elIdx] as RenderElement | undefined;
            if (el?.kind === 'text' && (el.heading || editable)) return [colIdx, elIdx];
        }
    }
    return [-1, -1];
}

/** The heading's size class: large for the first element of the first column, else the smaller one. */
export function headingSizeClass(lead: boolean): string {
    return lead ? 'content-el-heading--lead' : 'content-el-heading--sub';
}
