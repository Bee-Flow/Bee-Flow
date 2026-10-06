import { appendWildcard } from '@shared/expr/path.mjs';
import { readableValue } from '../mapping/upstream/fieldTree';
import { rowMatches } from './cellSummary';
import { getByDotted, isPlainObject } from './valueHelpers';

/**
 * Where the enlarged "Continues on" view is: a stack of levels, the step's own
 * rows at the bottom and one entry per list opened from a row above it
 * (a mail › its attachments › …). Each entry keeps its own search, page and
 * selected row, so going up shows the level exactly as it was left.
 *
 * A level never holds its rows: they are resolved from the root on every
 * render (resolveLevels), so a stale copy can never sit under new crumbs.
 * Pure and React-free.
 */

export const PAGE_SIZE = 25;

export interface Level {
    /** Path of the list inside the parent row (a column key or a detail field path); null at the root. */
    key: string | null;
    /** Index of the parent row in the level above; null at the root. */
    fromRow: number | null;
    /** The list's label, "Attachments". */
    label: string;
    /** The parent row's name, as its crumb shows it. */
    rowName: string;
    query: string;
    page: number;
    /** The row whose details are open, by index into this level's rows. */
    selected: number | null;
    /** What opened this list in the parent: a grid cell or the row details' "Show all". */
    from?: Opener;
}

/** Where a list was opened from; focus goes back there after going up. */
export type Opener = 'cell' | 'detail';

export interface Drill {
    fromRow: number;
    key: string;
    label: string;
    rowName: string;
    from?: Opener;
}

export interface Crumb {
    text: string;
    current: boolean;
    /** The crumb index to hand to jumpTo. */
    target: number;
}

const pageOf = (position: number) => Math.max(0, Math.floor(position / PAGE_SIZE));

/** The step's own rows, optionally with one row's details open on its page. */
export function rootStack(initialRow: number | null): Level[] {
    return [{
        key: null, fromRow: null, label: '', rowName: '', query: '',
        page: initialRow != null ? pageOf(initialRow) : 0,
        selected: initialRow,
    }];
}

/** One level deeper; the parent entry is left exactly as it is. */
export function drill(stack: Level[], { fromRow, key, label, rowName, from }: Drill): Level[] {
    return [...stack, { key, fromRow, label, rowName, query: '', page: 0, selected: null, from }];
}

/**
 * Opened from the drawer straight onto a list: the root on the page that
 * holds the row (no details open), and the list above it.
 */
export function openStack(row: number, key: string, label: string, rowName: string): Level[] {
    const root = { ...rootStack(null)[0], page: pageOf(row) };
    return drill([root], { fromRow: row, key, label, rowName, from: 'cell' });
}

/** The list a move up left, seen from the level back on screen: the row and path it was opened from. */
export interface Return {
    /** Depth of the level back on screen. */
    depth: number;
    row: number;
    path: string;
    from: Opener;
}

/**
 * What a move from `prev` to the shorter `next` went up from: the list just
 * above the new top. Null for a move down or sideways. The level back on
 * screen reopens that path in its row details and focuses its opener.
 */
export function returnOf(prev: Level[], next: Level[]): Return | null {
    const child = next.length < prev.length ? prev[next.length] : null;
    if (!child || child.key == null || child.fromRow == null) return null;
    return { depth: next.length - 1, row: child.fromRow, path: child.key, from: child.from ?? 'cell' };
}

/** One level up. At the root the same array comes back: the shell closes instead. */
export function up(stack: Level[]): Level[] {
    return stack.length > 1 ? stack.slice(0, -1) : stack;
}

/** The top entry, patched (its search, page or selected row). */
export function patchTop(stack: Level[], patch: Partial<Level>): Level[] {
    if (!stack.length) return stack;
    return [...stack.slice(0, -1), { ...stack[stack.length - 1], ...patch }];
}

/**
 * Go to a crumb (see crumbsOf for the numbering):
 *   0       the root, nothing selected;
 *   2i + 1  the row a list was opened from: level i with that row's details
 *           open, on the page that holds it;
 *   2i      an earlier list (i > 0): level i, nothing selected.
 * `levels` (resolveLevels' answer) finds the row's page under the level's
 * search; without it the level keeps its page, which held the row when the
 * list was opened.
 */
export function jumpTo(stack: Level[], crumbIndex: number, levels?: readonly unknown[][]): Level[] {
    const depth = Math.max(0, Math.min(Math.floor(crumbIndex / 2), stack.length - 1));
    const kept = stack.slice(0, depth + 1);
    const child = stack[depth + 1];
    if (crumbIndex % 2 === 0 || !child || child.fromRow == null) return patchTop(kept, { selected: null });
    const row = child.fromRow;
    const level = kept[depth];
    const rows = levels?.[depth];
    const position = rows ? pageView(rows, level.query, 0).filtered.findIndex(r => r.index === row) : -1;
    return patchTop(kept, { selected: row, page: position >= 0 ? pageOf(position) : level.page });
}

/** Can this value open as a level of its own: a list with at least one record (JSON text included)? */
export function canOpen(value: unknown): boolean {
    const list = readableValue(value);
    return Array.isArray(list) && list.some(isPlainObject);
}

/**
 * The rows of every level, root first, each resolved from the one above it
 * and handed out by reference. Stops at the first level whose row is gone or
 * whose value is no longer a list of records: the caller cuts the stack there.
 */
export function resolveLevels(rootRows: unknown[], stack: Level[]): unknown[][] {
    const out: unknown[][] = [rootRows];
    for (const level of stack.slice(1)) {
        const parent = out[out.length - 1];
        if (level.key == null || level.fromRow == null || level.fromRow < 0 || level.fromRow >= parent.length) break;
        const value = readableValue(getByDotted(parent[level.fromRow], level.key));
        if (!canOpen(value)) break;
        out.push(value as unknown[]);
    }
    return out;
}

/**
 * The path of a level's rows with every row number replaced by `[*]`:
 * `output.attachments`, then `output.attachments[*].lines`. The attachments of
 * mail 1 and mail 2 share it, and with it their remembered columns.
 */
export function childPattern(parent: string | null, key: string): string {
    if (parent == null) return key;
    const base = appendWildcard(parent);
    return key.startsWith('[') ? `${base}${key}` : `${base}.${key}`;
}

/** childPattern folded over the stack; '' at the root. */
export function levelPattern(stack: Level[]): string {
    let pattern: string | null = null;
    for (const level of stack.slice(1)) if (level.key != null) pattern = childPattern(pattern, level.key);
    return pattern ?? '';
}

/** The trail: the root, then per level the row it was opened from and the list's label. */
export function crumbsOf(stack: Level[], rootText: string): Crumb[] {
    const crumbs: Crumb[] = [{ text: rootText, current: false, target: 0 }];
    stack.slice(1).forEach((level, i) => {
        crumbs.push({ text: level.rowName, current: false, target: 2 * i + 1 });
        crumbs.push({ text: level.label, current: false, target: 2 * i + 2 });
    });
    crumbs[crumbs.length - 1].current = true;
    return crumbs;
}

export interface Indexed {
    row: unknown;
    index: number;
}

export interface PageView {
    pageRows: Indexed[];
    filtered: Indexed[];
    /** 1-based, 0 when nothing matches. */
    from: number;
    to: number;
    pages: number;
    safePage: number;
}

/** The rows that match the search, and the page of them on screen (clamped). */
export function pageView(rows: unknown[], query: string, page: number): PageView {
    const filtered = rows.map((row, index) => ({ row, index })).filter(r => rowMatches(r.row, query));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const from = filtered.length ? safePage * PAGE_SIZE + 1 : 0;
    const to = safePage * PAGE_SIZE + pageRows.length;
    return { pageRows, filtered, from, to, pages, safePage };
}
