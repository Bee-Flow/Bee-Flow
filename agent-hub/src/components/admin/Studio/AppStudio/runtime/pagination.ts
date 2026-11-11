/**
 * App Studio runtime — server paging of a record list, the pure part.
 *
 * `table`, `list` and `data_grid` may carry `props.pagination` (schema 3,
 * server/appStudio/componentSpecs: recordListSpecs.js, analyticsSpecs.js) over
 * a `records` source. Such a component reads its pages itself (pagedSource.tsx):
 * page one with the source's own filter, sort and limit, every next page with
 * the keyset cursor the server handed back. A component without the prop, or
 * over any other kind of source, reads its source exactly as before.
 *
 * Kept free of React so the screen scan (AppDataScope) can ask the same
 * question without importing the hook.
 */

import type { BindingInput, DataBinding } from './resolveBinding.types';

export type PaginationMode = 'loadMore' | 'prevNext';

/** The modes each type offers: the spec's enum values, in lockstep (pagination.test.ts). */
export const PAGINATION_MODES: Readonly<Record<string, readonly PaginationMode[]>> = Object.freeze({
    table: ['loadMore', 'prevNext'],
    list: ['loadMore', 'prevNext'],
    data_grid: ['loadMore'],
});

/** A node as far as paging reads it. */
interface PagedNodeLike {
    type?: unknown;
    props?: { pagination?: unknown; source?: unknown } | null;
}

/** The paging mode `value` names for a component of `type`, or null (no paging). */
export function paginationModeOf(type: unknown, value: unknown): PaginationMode | null {
    const modes = typeof type === 'string' && Object.prototype.hasOwnProperty.call(PAGINATION_MODES, type)
        ? PAGINATION_MODES[type]
        : null;
    return modes && modes.includes(value as PaginationMode) ? value as PaginationMode : null;
}

/** Whether a binding is one paging can serve: a `records` read of one table. */
export function isPageableSource(source: BindingInput | unknown): source is DataBinding {
    return !!source && typeof source === 'object' && (source as DataBinding).kind === 'records'
        && typeof (source as DataBinding).tableId === 'string' && !!(source as DataBinding).tableId;
}

/**
 * Whether `node` reads its own `props.source` page by page. The screen scan
 * then leaves that source alone, so the first page is not read twice.
 */
export function readsOwnPages(value: unknown): boolean {
    const node = value as PagedNodeLike | null | undefined;
    if (!node || typeof node !== 'object' || !node.props || typeof node.props !== 'object') return false;
    return paginationModeOf(node.type, node.props.pagination) !== null && isPageableSource(node.props.source);
}

/** The data-state key of one page: the source's cache key, then the cursor that opens the page. */
export function pageKeyOf(sourceKey: string, cursor: string | null): string {
    return `${sourceKey}#page:${cursor ?? ''}`;
}

/** One page as the server answered it. */
export interface PageBody {
    rows: unknown[];
    nextCursor: string | null;
    total: number | null;
}

export const EMPTY_PAGE: PageBody = Object.freeze({ rows: [], nextCursor: null, total: null }) as PageBody;

/** A records answer (`{ records, nextCursor, total? }`) as a page. */
export function pageOf(body: unknown): PageBody {
    const b = body && typeof body === 'object' ? body as { records?: unknown; nextCursor?: unknown; total?: unknown } : {};
    return {
        rows: Array.isArray(b.records) ? b.records.filter((r) => r && typeof r === 'object') : [],
        nextCursor: typeof b.nextCursor === 'string' && b.nextCursor ? b.nextCursor : null,
        total: typeof b.total === 'number' && Number.isFinite(b.total) && b.total >= 0 ? b.total : null,
    };
}

/**
 * Which pages a component holds. `cursors[i]` opens page i (page 0: null);
 * `offsets[i]` is how many rows come before it. loadMore shows pages 0..last,
 * prevNext shows page `index`.
 */
export interface PageWalk {
    cursors: (string | null)[];
    offsets: number[];
    index: number;
}

export const FIRST_PAGE: PageWalk = Object.freeze({ cursors: [null], offsets: [0], index: 0 }) as PageWalk;

/** The walk one page further, after a page of `rows` rows that handed back `nextCursor`. */
export function stepForward(walk: PageWalk, nextCursor: string, rows: number): PageWalk {
    const at = walk.index;
    if (walk.cursors[at + 1] === nextCursor) return { ...walk, index: at + 1 };
    return {
        cursors: [...walk.cursors.slice(0, at + 1), nextCursor],
        offsets: [...walk.offsets.slice(0, at + 1), walk.offsets[at] + rows],
        index: at + 1,
    };
}

/** The walk one page back (prevNext); page 0 stays page 0. */
export function stepBack(walk: PageWalk): PageWalk {
    return walk.index > 0 ? { ...walk, index: walk.index - 1 } : walk;
}
