import {
    flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel,
    getSortedRowModel, useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, Plus, Search, Table2, X } from 'lucide-react';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { tryEvaluate } from '@shared/expr/engine.mjs';
import CellValue, { ALIGN_CLASS, alignFor } from './cellValue';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill, ROLE_COLORS, roleTextColor } from '../styleResolver';
import GridFilterControl from './GridFilterControl';
import GridViewMenu from './GridViewMenu';
import { canFacet, describeFilter, facetValues, filterKindFor, isActiveFilter, makeFilterFn } from './gridColumnFilters';
import { clearViewPrefs, readViewPrefs, resolveView, writeViewPrefs } from './gridViewPrefs';
import { EM_DASH, EmptyText, ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';

/**
 * App Studio runtime — 'data_grid'. Spec: server/appStudio/componentSpecs.js.
 *
 * The cell switch moved to the shared `cellValue` module, which AppTable also
 * imports — the two used to keep private copies that had already drifted apart.
 */

const VIRTUALIZE_THRESHOLD = 50;
// Page sizes a viewer can pick in the footer. The author's pageSize seeds the
// grid; these are the sizes it can be resized to.
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const DENSITY = {
    compact: { cell: 'px-2 py-1', text: 'text-xs', rowH: 32 },
    comfortable: { cell: 'px-2.5 py-1.5', text: 'text-sm', rowH: 40 },
    spacious: { cell: 'px-3 py-2.5', text: 'text-sm', rowH: 48 },
};
// The 'minimal' look trades rules for whitespace: same density scale, airier
// rows (the dividers are gone, so spacing is what separates the rows).
const DENSITY_AIRY = {
    compact: 'px-2 py-2',
    comfortable: 'px-2.5 py-2.5',
    spacious: 'px-3 py-3',
};
// The ONLY height this file still decides for itself: the safety net for a
// page so long that rendering it inline would jank, when the author asked for
// no height at all.
//
// There used to be a full sm/md/lg/xl map here (160/280/420/620) alongside the
// one in styleResolver (120/200/320/620) — two maps, disagreeing, both applied
// to the same node. The outer (smaller) box won, so the inner scroller was
// capped BELOW its own container: two nested scrollbars, and the pagination
// footer pushed out of sight under the fold. Authors read that as "the grid
// eats my last rows" and worked around it by shrinking pageSize.
//
// Now a node with any explicit height renders like `fill` — the outer cell
// from styleResolver sets the box, the scroller flexes to what is left, and
// the footer keeps its place. One map, one source of truth.
const VIRTUALIZE_FALLBACK_PX = 280;

// Line clamping, per the viewer's "Long text" choice. -webkit-line-clamp is the
// only cross-browser way to cut at a line boundary rather than a character one,
// and it is supported everywhere this app runs. Height comes back to the row,
// which is what makes a table with one chatty column readable again.
const CLAMP_STYLE = {
    1: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 1 },
    2: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 },
    3: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3 },
};

/**
 * How a toned row is painted: a solid bar down its leading edge plus a wash.
 *
 * The bar carries the message. A tint alone is easy to miss on a striped table
 * and disappears entirely for anyone who cannot separate the two colours, so
 * the edge is deliberately a shape change as well as a colour one — you can
 * see which rows are marked from across the room, before reading a word.
 * Kept faint (8%) because the row still has to be READ; this is a flag, not a
 * highlighter.
 */
function rowToneStyle(tone) {
    const color = ROLE_COLORS[tone];
    if (!color) return undefined;
    return {
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        boxShadow: `inset 3px 0 0 0 ${color}`,
    };
}

/**
 * The panel that shows what a clamped cell is hiding.
 *
 * Fixed to the viewport rather than positioned inside the row: the cell lives
 * in a scroll container with `overflow: auto`, and an absolutely-positioned
 * panel would be clipped by exactly the box it needs to escape. It flips above
 * the cell near the bottom of the window, and scrolls internally rather than
 * growing past the fold — some of these notes run to a dozen sentences.
 *
 * aria-hidden, and deliberately so. The full text is already in the DOM (the
 * clamp hides it visually, it does not remove it), so a screen reader reads the
 * cell in full without this. Announcing it twice would be worse than not at all.
 */
function CellPeek({ peek }) {
    if (!peek) return null;
    const WIDTH = 420;
    const left = Math.max(8, Math.min(peek.left, window.innerWidth - WIDTH - 8));
    return (
        <div
            aria-hidden="true"
            data-app-cell-peek="true"
            className="fixed z-50 border p-2.5 text-xs shadow-lg"
            style={{
                left,
                ...(peek.above ? { bottom: window.innerHeight - peek.bottom + 6 } : { top: peek.top + 6 }),
                width: WIDTH,
                maxHeight: '40vh',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                background: 'var(--bg-card)',
                borderColor: 'var(--border-default)',
                borderRadius: 'var(--app-radius)',
                color: 'var(--text-primary)',
            }}
        >
            {peek.text}
        </div>
    );
}

/** Formats a column can edit as a native date control. */
const DATE_EDIT = { date: 'date', datetime: 'datetime-local' };

const EDIT_INPUT_CLASS = 'w-full bg-transparent border px-1.5 py-0.5 text-inherit outline-none focus:border-[var(--app-primary)]';
const EDIT_INPUT_STYLE = { borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' };

/**
 * The editor half of an editable cell — mounted only while the cell is open.
 *
 * `datetime-local` wants 'YYYY-MM-DDTHH:mm' and a stored ISO string carries
 * seconds and a zone, which the control silently rejects (it renders blank, so
 * the value looks deleted). Slice it to what the control accepts and hand back
 * what the column stores.
 */
function CellEditor({ initial, format, options, onCommit, onCancel }) {
    const [draft, setDraft] = useState(() => {
        if (initial == null) return '';
        if (format === 'datetime') return String(initial).slice(0, 16);
        if (format === 'date') return String(initial).slice(0, 10);
        return initial;
    });
    const ref = useRef(null);
    useEffect(() => { ref.current?.focus(); }, []);

    const commit = () => {
        const raw = draft;
        const next = format === 'number' && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
        onCommit(next);
    };
    // Escape must not also commit. It fires before blur, so the cancel has to
    // close the editor in a way the blur handler can see — hence onCancel
    // unmounting us rather than a flag we would have to read back.
    const onKeyDown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
        // Enter commits. Tab does NOT get intercepted: letting the browser move
        // focus is what makes tabbing along a row work, and blur commits on the
        // way out.
        if (e.key === 'Enter' && format !== 'textarea') { e.preventDefault(); commit(); }
    };

    if (options) {
        return (
            <select
                ref={ref}
                value={draft ?? ''}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={onKeyDown}
                className={EDIT_INPUT_CLASS}
                style={EDIT_INPUT_STYLE}
                aria-label="Edit cell"
            >
                {/* A blank option so a value can be cleared — without it a
                    required-looking dropdown can never go back to empty. */}
                <option value="">—</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
            </select>
        );
    }

    return (
        <input
            ref={ref}
            value={draft ?? ''}
            type={DATE_EDIT[format] || (format === 'number' ? 'number' : 'text')}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
            className={EDIT_INPUT_CLASS}
            style={EDIT_INPUT_STYLE}
            aria-label="Edit cell"
        />
    );
}

/**
 * An editable cell — the display value until you ask to change it.
 *
 * This used to render a live <input> for EVERY row of an editable column, from
 * the first paint. A backlog of forty items with four editable columns was a
 * wall of a hundred and sixty boxes: the data was there, but nothing in it
 * could be read at a glance, and the screen looked like a form rather than a
 * table. Now the cell shows its value and opens an editor on click, Enter or
 * F2 — the same gesture every spreadsheet has taught people to expect.
 *
 * Tab is deliberately NOT intercepted: the browser moves focus to the next
 * cell's trigger, and blur commits on the way past. Enter commits and closes
 * rather than stepping down a row — with the grid virtualized, the row below
 * may not exist in the DOM to receive focus, and a key that usually works is
 * worse than one that never claimed to.
 */
function EditableCell({ value, format, col, row, now, onCommit, clamp = 0 }) {
    const [editing, setEditing] = useState(false);
    const triggerRef = useRef(null);
    const close = (focusBack) => {
        setEditing(false);
        if (focusBack) triggerRef.current?.focus();
    };

    // A tick box has exactly two states and no text to type: clicking IS the
    // edit. Opening an editor to choose between two values would be ceremony.
    const isToggle = format === 'check' || format === 'boolean';
    // A column that names its values can only hold one of them — offer the list
    // rather than free text, which is how 'doing' used to become 'diong'.
    const options = Array.isArray(col?.toneMap) && col.toneMap.length
        ? col.toneMap.map((m) => ({ value: m.value, label: m.label ?? m.value }))
        : null;

    if (editing) {
        return (
            <CellEditor
                initial={value}
                format={format}
                options={options}
                onCommit={(next) => { close(true); if (next !== value) onCommit(next); }}
                onCancel={() => close(true)}
            />
        );
    }

    return (
        <button
            ref={triggerRef}
            type="button"
            onClick={() => (isToggle ? onCommit(!value) : setEditing(true))}
            onKeyDown={(e) => {
                if (e.key !== 'F2') return;
                e.preventDefault();
                if (isToggle) onCommit(!value); else setEditing(true);
            }}
            className="app-grid-editable w-full app-focusable"
            // A button centres its text in the UA stylesheet, which would undo
            // the column's alignment — the numbers would drift back off the
            // right edge they were just lined up on.
            //
            // The clamp has to land HERE, not only on the wrapper outside. A
            // button is an atomic box in its parent's inline flow, so a
            // -webkit-line-clamp above it counted the whole button as one line
            // and clipped nothing: every editable text column ignored the
            // reader's "Long text" setting entirely, and one chatty AI note
            // made a row forty lines tall.
            style={{ textAlign: 'inherit', ...(clamp ? CLAMP_STYLE[clamp] : null) }}
            data-app-clamped={clamp ? 'true' : undefined}
            aria-label={`Edit ${col?.label || col?.key || 'cell'}`}
        >
            <CellValue value={value} format={format} col={col} row={row} now={now} />
        </button>
    );
}

export default function AppDataGrid({ node }) {
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const props = node.props || {};
    const {
        columns: colDefs = [], pageSize: pageSizeProp = 25, selectable = 'none', searchable = false,
        rowActions = [], bulkActions = [], toolbarActions = [], addRowLabel = '', addRowActionId = '',
        density: densityProp = 'comfortable', emptyText = 'Nothing to show yet.',
        zebra = false, look: lookProp = 'default', clamp: clampProp = 'off', rowTone = [],
        groupBy = null, groupOrder = [], activeWhen = null,
    } = props;
    const isRun = mode === 'run';

    // Reader-side display overrides. The author's props stay the default; a
    // viewer can make the rows tighter, separate them differently, or stop one
    // long free-text column from making every row six lines tall. Stored per
    // grid in the browser, never in the definition — see gridViewPrefs.js.
    const [viewOverrides, setViewOverrides] = useState(() => readViewPrefs(node.id));
    const view = resolveView({ density: densityProp, look: lookProp, clamp: clampProp }, viewOverrides);
    const hasViewOverrides = Object.keys(viewOverrides).length > 0;
    const setViewKey = (key, value) => {
        setViewOverrides((prev) => {
            const next = { ...prev, [key]: value };
            writeViewPrefs(node.id, next);
            return next;
        });
    };
    const resetView = () => { clearViewPrefs(node.id); setViewOverrides({}); };
    const density = view.density;
    const clampLines = view.clamp === 'off' ? 0 : Number(view.clamp);

    // The full text of whatever clamped cell is under the pointer. One piece of
    // state for the whole grid rather than one per cell: a thousand cells that
    // each own a popover is a thousand subscriptions to re-render on hover.
    const [peek, setPeek] = useState(null);
    const showPeek = (e) => {
        // The clamp can sit on the wrapper OR — for an editable column — on the
        // button inside it, so take the innermost one: that is the box that
        // actually clips.
        const boxes = e.currentTarget.querySelectorAll('[data-app-clamped]');
        // A single-line `truncate` column clips on the CELL itself — there is no
        // inner wrapper to find — so the cell is the fallback box. Without it
        // the peek covered multi-line clamping and left plain truncation with
        // nothing at all: a part number cut to "MW2604-02-…" was simply gone.
        const box = boxes[boxes.length - 1] || e.currentTarget;
        // Nothing hidden, nothing to say. Measuring beats guessing from the
        // string length: what fits depends on the column width, and a panel
        // that repeats what is already on screen is pure noise. Both axes,
        // because a clamp hides height and a truncate hides width.
        const hidden = box.scrollHeight > box.clientHeight + 1
            || box.scrollWidth > box.clientWidth + 1;
        if (!hidden) return;
        const text = (box.innerText || '').trim();
        if (!text) return;
        const r = e.currentTarget.getBoundingClientRect();
        setPeek({ text, top: r.bottom, bottom: r.top, left: r.left, above: r.bottom > window.innerHeight - 200 });
    };
    const hidePeek = () => setPeek(null);

    // Anchored to viewport coordinates read once, so any scroll underneath it
    // would leave the panel pointing at a different row. Cheaper and more
    // honest to close it.
    useEffect(() => {
        if (!peek) return undefined;
        const off = () => setPeek(null);
        window.addEventListener('scroll', off, true);
        return () => window.removeEventListener('scroll', off, true);
    }, [peek]);

    // First rule that matches wins, so an author orders them loudest-first.
    // Compared as strings because a select stores '0'/'1' while a number column
    // yields 0/1, and a rule that silently never fired would be worse than one
    // that is merely blunt.
    const rowToneFor = (record) => {
        if (!Array.isArray(rowTone) || !rowTone.length || !record) return null;
        for (const rule of rowTone) {
            if (!rule || !rule.field) continue;
            const cell = record[rule.field];
            if (cell == null) continue;
            if (String(cell) === String(rule.value)) return rule.tone || 'neutral';
        }
        return null;
    };

    // Grouping (spec: groupBy / groupOrder). collapsed:true in groupOrder
    // seeds a group closed; the viewer's clicks override per group, held
    // locally for the life of the component (like the tanstack sort state).
    const grouping = typeof groupBy === 'string' && groupBy !== '';
    const collapsedSeed = useMemo(() => {
        const seed = {};
        for (const g of (Array.isArray(groupOrder) ? groupOrder : [])) {
            if (g && g.collapsed && g.value != null) seed[String(g.value)] = true;
        }
        return seed;
    }, [groupOrder]);
    const [collapsedOverrides, setCollapsedOverrides] = useState({});
    const isGroupCollapsed = (val) => (val in collapsedOverrides ? collapsedOverrides[val] : !!collapsedSeed[val]);
    const toggleGroup = (val) => setCollapsedOverrides((prev) => ({ ...prev, [val]: !isGroupCollapsed(val) }));

    // Look pass (spec: data_grid.look). IDENTITY FIRST: 'default' — and any
    // value this build does not know yet — takes the exact original code path:
    // no new class, no new style. The legacy `zebra` boolean keeps striping
    // stored grids, but only on the default look — `look` wins when both are
    // set (spec comment in componentSpecs.js).
    const look = view.look === 'striped' || view.look === 'minimal' || view.look === 'cards' ? view.look : 'default';
    const minimal = look === 'minimal';
    const cards = look === 'cards';
    const striped = look === 'striped' || (look === 'default' && zebra);

    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(props.source, { actionState, dataState, scope }),
    );

    // Local, optimistic inline-edit overlay keyed by a stable row id. It is a
    // bridge to the save, NOT a store: it is rolled back when the update action
    // fails and dropped as soon as fresher rows arrive.
    const [edits, setEdits] = useState({});
    // Commit pipeline. useActionRunner's re-entry guard silently drops a run of
    // an action that is still 'running' — so a second cell committed during the
    // first commit's round-trip used to never save, and its overlay value
    // visibly snapped back on the next refetch. One commit is in flight at a
    // time (`inFlight` — the rollback targets); the rest wait in `commitQueue`
    // and dispatch as the previous one settles.
    const inFlight = useRef([]);      // [{ rk, key }] of the dispatched, unsettled commit
    const commitQueue = useRef([]);   // [{ formValues, rk, key }] waiting to dispatch
    const busy = useRef(false);
    const [sorting, setSorting] = useState([]);
    const [globalFilter, setGlobalFilter] = useState('');
    const [columnFilters, setColumnFilters] = useState([]);
    const [rowSelection, setRowSelection] = useState({});
    const [pageIndex, setPageIndex] = useState(0);
    // The author's pageSize is the starting point, not a cage: a viewer can
    // resize the page from the footer (and lands back on page 1, because
    // "page 7 of 12" means nothing once the pages change size).
    const [pageSize, setPageSize] = useState(pageSizeProp);
    useEffect(() => { setPageSize(pageSizeProp); setPageIndex(0); }, [pageSizeProp]);
    // The spec lets an author pick any pageSize from 5 to 100, but the footer
    // only offered four. A grid authored at 20 rendered a <select> with no
    // matching <option> — blank, until the viewer picked something else and
    // lost the author's setting. Whatever is actually in force is always on
    // the list.
    const pageSizeChoices = useMemo(
        () => (PAGE_SIZE_OPTIONS.includes(pageSize) ? PAGE_SIZE_OPTIONS : [...PAGE_SIZE_OPTIONS, pageSize].sort((a, b) => a - b)),
        [pageSize],
    );

    const baseRows = useMemo(
        () => (Array.isArray(source) ? source : []).filter((r) => r && typeof r === 'object'),
        [source],
    );

    const rowKey = (row, index) => String(row?.id ?? row?._id ?? index);

    const data = useMemo(() => baseRows.map((row, index) => {
        const ov = edits[rowKey(row, index)];
        return ov ? { ...row, ...ov } : row;
    }), [baseRows, edits]);

    // Refetched rows are the server's answer and outrank any pending overlay —
    // otherwise a value the server rewrote (or never accepted) stays on screen.
    // The exception is values still QUEUED behind an in-flight commit: their
    // write has not happened yet, so the refetch cannot be their answer, and
    // dropping them would snap the cell back mid-queue only for the value to
    // reappear after its own commit's refresh.
    const seenRows = useRef(baseRows);
    useEffect(() => {
        if (seenRows.current === baseRows) return;
        seenRows.current = baseRows;
        inFlight.current = [];
        const queued = new Set(commitQueue.current.map((e) => `${e.rk}\u0000${e.key}`));
        setEdits((prev) => {
            if (!Object.keys(prev).length) return prev;
            if (!queued.size) return {};
            const next = {};
            for (const [rk, row] of Object.entries(prev)) {
                const kept = {};
                for (const [key, v] of Object.entries(row)) {
                    if (queued.has(`${rk}\u0000${key}`)) kept[key] = v;
                }
                if (Object.keys(kept).length) next[rk] = kept;
            }
            return next;
        });
    }, [baseRows]);

    // A failed update must not keep showing the user's value as if it saved:
    // runAction never rejects, it reports through actionState. On settle
    // (success OR error) the next queued commit — if any — is dispatched.
    const updateStatus = node.onRowSelect ? actionState?.[node.onRowSelect]?.status : undefined;
    const prevUpdateStatus = useRef(updateStatus);
    useEffect(() => {
        const prev = prevUpdateStatus.current;
        prevUpdateStatus.current = updateStatus;
        if (prev === updateStatus) return;
        if (updateStatus !== 'success' && updateStatus !== 'error') return;
        const rolled = inFlight.current;
        inFlight.current = [];
        if (updateStatus === 'error' && rolled.length) {
            setEdits((cur) => {
                const next = { ...cur };
                for (const { rk, key } of rolled) {
                    if (!next[rk]) continue;
                    const row = { ...next[rk] };
                    delete row[key];
                    if (Object.keys(row).length) next[rk] = row; else delete next[rk];
                }
                return next;
            });
        }
        const entry = commitQueue.current[0];
        if (entry && node.onRowSelect) {
            commitQueue.current = commitQueue.current.slice(1);
            inFlight.current = [{ rk: entry.rk, key: entry.key }];
            // A queued edit to the row we JUST wrote is carrying the updated_at
            // it was captured with — which our own successful write has already
            // superseded. An action using it for a compare-and-set would then
            // refuse the second edit as somebody else's conflict, and roll it
            // back: edit two cells quickly and the second silently reverts. The
            // guard is there to catch OTHER people, so drop the stale token
            // rather than pointing it at ourselves. (actionExecutor treats a
            // non-string expectedUpdatedAt as absent and skips the check.)
            const values = (updateStatus === 'success' && rolled.some((r) => r.rk === entry.rk))
                ? { ...entry.formValues, updated_at: null }
                : entry.formValues;
            runAction(node.onRowSelect, { formValues: values, item: values });
        } else {
            busy.current = false;
        }
    }, [updateStatus, runAction, node.onRowSelect]);

    // Columns: use the configured list, else derive from the first row (max 12).
    // `hidden` keeps a column in the definition — so a toneFrom or labelFrom can
    // still point at it — without giving it a place on screen.
    const cols = useMemo(() => {
        if (colDefs.length) return colDefs.filter((c) => c && !c.hidden);
        return Object.keys(baseRows[0] || {}).slice(0, 12).map((key) => ({ key, label: key, format: 'text' }));
    }, [colDefs, baseRows]);

    // One clock for every relative cell on the screen — see cellValue.
    const now = Date.parse(scope?.now) || null;
    const dens = DENSITY[density] || DENSITY.comfortable;
    // For the default look both of these resolve to today's exact strings.
    const cellPad = minimal ? (DENSITY_AIRY[density] || DENSITY_AIRY.comfortable) : dens.cell;
    const divider = minimal || cards ? '' : ' border-b';

    // Which control each filterable column gets, from its format (see
    // gridColumnFilters.js). A column that names its values — through a
    // toneMap, or simply by holding few enough distinct ones — offers them
    // as a pick list: a substring box over four known states is a worse
    // control than the four states.
    const filterMeta = useMemo(() => {
        const out = {};
        for (const col of cols) {
            if (!col.filterable) continue;
            const format = col.format || 'text';
            const options = Array.isArray(col.toneMap) && col.toneMap.length
                ? col.toneMap.map((m) => ({ value: m.value, label: m.label ?? m.value }))
                : canFacet(format) ? facetValues(baseRows, col.key) : null;
            out[col.key] = { kind: filterKindFor(format, { hasOptions: !!options }), options };
        }
        return out;
    }, [cols, baseRows]);

    const columns = useMemo(() => {
        const list = cols.map((col) => ({
            id: col.key,
            accessorKey: col.key,
            header: col.label || col.key,
            enableSorting: col.sortable !== false,
            enableColumnFilter: !!col.filterable,
            filterFn: makeFilterFn(filterMeta[col.key]?.kind),
            size: Number.isFinite(col.width) ? col.width : undefined,
            meta: {
                format: col.format || 'text', editable: !!col.editable,
                align: alignFor(col), truncate: !!col.truncate,
                filterKind: filterMeta[col.key]?.kind || null,
                filterOptions: filterMeta[col.key]?.options || null,
                toneMap: Array.isArray(col.toneMap) && col.toneMap.length ? col.toneMap : null,
                help: typeof col.help === 'string' && col.help ? col.help : null,
                // Set when the whole column is a button (spec: columns[].actionId).
                actionId: typeof col.actionId === 'string' && col.actionId ? col.actionId : null,
            },
            cell: (ctx) => {
                const value = ctx.getValue();
                if (col.editable && isRun) {
                    return (
                        <EditableCell
                            value={value}
                            format={col.format || 'text'}
                            col={col}
                            row={ctx.row.original}
                            now={now}
                            clamp={clampLines}
                            // UNCHANGED. The optimistic overlay, the
                            // single-flight queue and the rollback below are
                            // the subtle part of this component; only WHERE
                            // this is called from moved.
                            onCommit={(next) => {
                                const rk = rowKey(ctx.row.original, ctx.row.index);
                                setEdits((prev) => ({ ...prev, [rk]: { ...(prev[rk] || {}), [col.key]: next } }));
                                if (!node.onRowSelect) return;
                                const entry = {
                                    formValues: { ...ctx.row.original, [col.key]: next, __edited: col.key },
                                    rk, key: col.key,
                                };
                                // One commit at a time: fired while the previous
                                // one is live it would be swallowed by the
                                // runner's re-entry guard, not saved.
                                if (busy.current) {
                                    commitQueue.current = [...commitQueue.current, entry];
                                    return;
                                }
                                busy.current = true;
                                inFlight.current = [{ rk, key: col.key }];
                                runAction(node.onRowSelect, { formValues: entry.formValues, item: entry.formValues });
                            }}
                        />
                    );
                }
                return (
                    <CellValue
                        value={value}
                        format={col.format || 'text'}
                        col={col}
                        row={ctx.row.original}
                        now={now}
                    />
                );
            },
        }));
        return list;
    }, [cols, filterMeta, isRun, node.onRowSelect, runAction, now]);

    const table = useReactTable({
        data,
        columns,
        state: { sorting, globalFilter, columnFilters, rowSelection, pagination: { pageIndex, pageSize } },
        getRowId: rowKey,
        enableRowSelection: selectable !== 'none',
        enableMultiRowSelection: selectable === 'multi',
        onSortingChange: setSorting,
        onGlobalFilterChange: setGlobalFilter,
        onColumnFiltersChange: setColumnFilters,
        onRowSelectionChange: setRowSelection,
        onPaginationChange: (updater) => {
            const next = typeof updater === 'function' ? updater({ pageIndex, pageSize }) : updater;
            setPageIndex(next.pageIndex);
        },
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
    });

    // Notify onRowSelect when the selection changes (skip the initial empty state).
    const selectSig = JSON.stringify(rowSelection);
    const prevSelSig = useRef(selectSig);
    const notifyRowSelect = useEffectEvent(() => {
        if (!isRun || !node.onRowSelect) return;
        const rows = table.getSelectedRowModel().rows.map((r) => r.original);
        runAction(node.onRowSelect, { formValues: { selected: rows } });
    });
    useEffect(() => {
        if (prevSelSig.current === selectSig) return;
        prevSelSig.current = selectSig;
        notifyRowSelect();
    }, [selectSig]);

    const pageRows = table.getRowModel().rows;
    // Grouping turns virtualization OFF rather than teaching the virtualizer
    // about header rows: the page is capped at 100 rows anyway, and keeping
    // the virtual index and the header-interleaved row list in sync would buy
    // little for what it costs in bookkeeping.
    const virtualize = !grouping && pageRows.length > VIRTUALIZE_THRESHOLD;
    const scrollRef = useRef(null);
    const virtualizer = useVirtualizer({
        count: pageRows.length,
        getScrollElement: () => scrollRef.current,
        // minimal pads rows out; cards adds the inter-card spacing. Estimates
        // only — but close ones keep the virtual scrollbar honest.
        estimateSize: () => dens.rowH + (minimal || cards ? 8 : 0),
        overscan: 8,
        enabled: virtualize,
    });

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={5} />;
    if (baseRows.length === 0 || cols.length === 0) {
        return (
            <div className="w-full" data-app-datagrid="true">
                <EmptyText art="no-results" title="Nothing here yet" text={emptyText} />
                {isRun && addRowActionId ? (
                    <div className="flex justify-center pb-3" data-app-grid-addrow="true">
                        <button
                            type="button"
                            onClick={() => runAction(addRowActionId, {})}
                            className="inline-flex items-center gap-1.5 px-2 py-1 text-sm font-medium"
                            style={{ color: 'var(--app-primary)' }}
                        >
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            {addRowLabel || 'Regel toevoegen'}
                        </button>
                    </div>
                ) : null}
            </div>
        );
    }

    const hasFilters = cols.some((c) => c.filterable);
    // Both filter surfaces count: the per-column row and the search box. A grid
    // filtered to nothing by a forgotten search box looks exactly like a grid
    // filtered to nothing by a column, and the way out is the same.
    const activeColumnFilters = columnFilters.filter((f) => isActiveFilter(f.value));
    const activeFilterCount = activeColumnFilters.length + (globalFilter ? 1 : 0);
    const clearFilters = () => { setColumnFilters([]); setGlobalFilter(''); };
    const pageCount = table.getPageCount();
    const colSpan = columns.length + (selectable !== 'none' ? 1 : 0) + (rowActions.length ? 1 : 0);
    // Counts AFTER search/column filters — "1–25 of 340" must describe what the
    // viewer is actually looking through, not the unfiltered table.
    const filteredCount = table.getFilteredRowModel().rows.length;
    const rangeFrom = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
    const rangeTo = Math.min(filteredCount, (pageIndex + 1) * pageSize);
    const selectedCount = table.getSelectedRowModel().rows.length;

    const fireRowClick = (row) => {
        if (isRun && node.onRowClick) runAction(node.onRowClick, { formValues: row.original, item: row.original });
    };

    const headerRow = () => (
        <tr>
            {selectable !== 'none' ? (
                <th className={`${cellPad}${divider} w-9`} style={{ borderColor: 'var(--border-default)' }}>
                    {selectable === 'multi' ? (
                        <input
                            type="checkbox"
                            aria-label="Select all rows"
                            checked={table.getIsAllRowsSelected()}
                            ref={(el) => { if (el) el.indeterminate = table.getIsSomeRowsSelected(); }}
                            onChange={table.getToggleAllRowsSelectedHandler()}
                            className="accent-[var(--app-primary)]"
                        />
                    ) : null}
                </th>
            ) : null}
            {table.getHeaderGroups()[0].headers.map((header) => {
                const sortable = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                // A numeric column's heading belongs over its digits, not over
                // the whitespace to their left.
                const align = header.column.columnDef.meta?.align || 'left';
                // What is actually IN this column, on hover. A heading squeezed
                // to "Snijkw." names the column without saying anything about
                // its contents — and a column of bare 0s and 8s is unreadable
                // to everyone who did not choose those codes.
                const help = header.column.columnDef.meta?.help || undefined;
                return (
                    <th
                        key={header.id}
                        scope="col"
                        title={help}
                        className={`${ALIGN_CLASS[align]} font-medium ${cellPad}${divider} select-none${minimal ? ' text-xs uppercase tracking-wider' : ''}`}
                        style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)', width: header.column.columnDef.size }}
                    >
                        <button
                            type="button"
                            disabled={!sortable}
                            onClick={sortable ? header.column.getToggleSortingHandler() : undefined}
                            className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''} ${sortable ? 'cursor-pointer hover:text-[var(--text-primary)]' : 'cursor-default'}`}
                        >
                            <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                            {sortable ? (
                                dir === 'asc' ? <ArrowUp className="w-3 h-3" aria-hidden="true" />
                                    : dir === 'desc' ? <ArrowDown className="w-3 h-3" aria-hidden="true" />
                                        : <ChevronsUpDown className="w-3 h-3 opacity-40" aria-hidden="true" />
                            ) : null}
                        </button>
                    </th>
                );
            })}
            {rowActions.length ? (
                <th className={`${cellPad}${divider}`} style={{ borderColor: 'var(--border-default)' }} aria-label="Actions" />
            ) : null}
        </tr>
    );

    // The band under the headings: one typed control per filterable column,
    // drawn on a slightly recessed background so it reads as a control row
    // rather than as the first record.
    const filterRow = () => (
        <tr data-app-grid-filterrow="true" style={{ background: 'var(--bg-secondary)' }}>
            {selectable !== 'none' ? <th className={`${cellPad}${divider}`} style={{ borderColor: 'var(--border-default)' }} /> : null}
            {table.getHeaderGroups()[0].headers.map((header) => {
                const meta = header.column.columnDef.meta || {};
                // The header's own label, not the raw key — "Filter state" told
                // a screen reader the column's storage name, not its heading.
                const name = `Filter ${header.column.columnDef.header || header.column.id}`;
                const value = header.column.getFilterValue();
                return (
                    <th key={header.id} className={`${cellPad}${divider} font-normal`} style={{ borderColor: 'var(--border-default)' }}>
                        {!header.column.getCanFilter() ? null : (
                            <GridFilterControl
                                kind={meta.filterKind}
                                name={name}
                                value={value}
                                options={meta.filterOptions}
                                active={isActiveFilter(value)}
                                onChange={(next) => header.column.setFilterValue(next)}
                            />
                        )}
                    </th>
                );
            })}
            {rowActions.length ? <th className={`${cellPad}${divider}`} style={{ borderColor: 'var(--border-default)' }} /> : null}
        </tr>
    );

    const renderRow = (row) => {
        const selected = row.getIsSelected();
        const tone = rowToneFor(row.original);
        // The ACTIVE row (spec: activeWhen) — the same per-row formula contract
        // as list.selectedWhen: `item` and `index` in scope, truthiness wins.
        // This is what makes the vars-driven master/detail pattern visible:
        // onRowClick stores the row in a variable, and the formula marks it.
        const active = activeWhen
            ? !!tryEvaluate(String(activeWhen), { ...scope, item: row.original, index: row.index }).value
            : false;
        return (
            <tr
                key={row.id}
                data-selected={selected || undefined}
                data-app-row-active={active || undefined}
                data-app-row-tone={tone || (active && cards ? 'primary' : undefined)}
                onClick={node.onRowClick ? () => fireRowClick(row) : undefined}
                // A clickable row is a control, so it has to BE one: it was a
                // bare <tr onClick> with no tab stop and no key handler, which
                // made every record in a master/detail app unreachable without
                // a mouse.
                {...(node.onRowClick && isRun ? {
                    tabIndex: 0,
                    role: 'button',
                    onKeyDown: (e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        fireRowClick(row);
                    },
                } : {})}
                // A clickable row now LOOKS clickable: the cursor was the only
                // affordance, which reads as a static report rather than a list
                // you can open. The tint lives in app-tokens.css so it follows
                // the app's primary colour.
                className={node.onRowClick && isRun ? 'cursor-pointer app-grid-row-clickable app-focusable' : ''}
                // Under 'cards' the tds paint their own card surface, so the
                // selection wash moves to the tds too (app-tokens.css keys it
                // off data-selected) — an inline tr background would be hidden.
                // Selection still wins over a tone: it is the thing the person
                // just did, and it is temporary.
                //
                // Under 'cards' the tone is handed over as a CSS variable and
                // painted onto the tds instead (app-tokens.css): the cells own
                // the card surface, and an inline box-shadow here would replace
                // the card's elevation with the tone bar rather than add to it.
                // Precedence: selection (the person's own, temporary gesture)
                // over active (the app's state) over rowTone. Active takes the
                // wash AND the edge bar — a row cannot carry two edge bars, and
                // "this is the one you are looking at" outranks a status tint.
                style={selected && !cards
                    ? { background: 'var(--app-primary-soft)' }
                    : active
                        ? (cards
                            ? { '--app-row-tone': 'var(--app-primary)' }
                            : { background: 'var(--app-primary-soft)', boxShadow: 'inset 3px 0 0 0 var(--app-primary)' })
                        : (tone
                            ? (cards
                                ? { '--app-row-tone': ROLE_COLORS[tone] }
                                : { ...rowToneStyle(tone), '--app-row-tone': ROLE_COLORS[tone] })
                            : undefined)}
            >
                {selectable !== 'none' ? (
                    <td className={`${cellPad}${divider} align-middle`} style={{ borderColor: 'var(--border-default)' }} onClick={(e) => e.stopPropagation()}>
                        <input
                            type="checkbox"
                            aria-label="Select row"
                            checked={selected}
                            onChange={row.getToggleSelectedHandler()}
                            className="accent-[var(--app-primary)]"
                        />
                    </td>
                ) : null}
                {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta || {};
                    // Either kind of clipping earns the peek: a clamp hides
                    // lines, a truncate hides the end of one.
                    const clips = !!clampLines || !!meta.truncate;
                    return (
                        <td
                            key={cell.id}
                            // align-middle, not align-top: a row mixing a pill, a
                            // date and a number had each sitting on a different
                            // baseline, which is most of why the grid read as
                            // ragged rather than as a table.
                            className={`${cellPad}${divider} align-middle ${ALIGN_CLASS[meta.align || 'left']}${meta.truncate ? ' truncate max-w-0' : ''}`}
                            style={{ borderColor: 'var(--border-default)' }}
                            // The full value stays reachable when it is clamped —
                            // hiding text is only acceptable if nothing is lost.
                            // A native `title` was the first answer and the wrong
                            // one for this: these cells hold a paragraph of AI
                            // reasoning, and an OS tooltip renders that as an
                            // unreadable slab after a second's delay. Focus is
                            // wired alongside hover so the keyboard reaches it.
                            onMouseEnter={clips ? showPeek : undefined}
                            onMouseLeave={clips ? hidePeek : undefined}
                            onFocus={clips ? showPeek : undefined}
                            onBlur={clips ? hidePeek : undefined}
                        >
                            {(() => {
                                const body = clampLines ? (
                                    <span className="block overflow-hidden" data-app-clamped="true" style={CLAMP_STYLE[clampLines]}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </span>
                                ) : flexRender(cell.column.columnDef.cell, cell.getContext());
                                // A column carrying an actionId turns its cells
                                // into buttons. stopPropagation so it does not
                                // ALSO fire the row click — two different things
                                // happening from one press is never what anyone
                                // meant.
                                if (!isRun || !meta.actionId) return body;
                                return (
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); runAction(meta.actionId, { formValues: cell.row.original, item: cell.row.original }); }}
                                        className="w-full cursor-pointer bg-transparent p-0 text-left"
                                        title="Click to edit"
                                    >
                                        {body}
                                    </button>
                                );
                            })()}
                        </td>
                    );
                })}
                {rowActions.length ? (
                    <td className={`${cellPad}${divider} align-middle`} style={{ borderColor: 'var(--border-default)' }} onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                            {rowActions.map((a, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    // `item` as well as formValues, matching
                                    // onRowClick/onRowSelect above and every
                                    // other row-context surface (list, kanban).
                                    // Without it an action authored as
                                    // `item.id` — the obvious spelling, and the
                                    // one that works from every OTHER row
                                    // control — resolved to nothing here, so the
                                    // button ran, reported success and wrote
                                    // nothing. A row action that silently does
                                    // nothing is worse than one that errors.
                                    onClick={() => { if (isRun && a.actionId) runAction(a.actionId, { formValues: row.original, item: row.original }); }}
                                    className="px-2 py-0.5 text-xs font-medium border"
                                    style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-secondary)' }}
                                >
                                    {a.label}
                                </button>
                            ))}
                        </div>
                    </td>
                ) : null}
            </tr>
        );
    };

    // Grouping buckets the CURRENT page's rows (spec: groupBy). Deliberately
    // page-local: sorting and pagination keep exactly their meaning, and a
    // header counts what is on screen. Bucketing is stable, so the tanstack
    // sort order is preserved WITHIN each group untouched.
    const groupedPage = grouping ? (() => {
        const byVal = new Map();
        for (const row of pageRows) {
            const raw = row.original ? row.original[groupBy] : null;
            const val = raw == null || raw === '' ? '' : String(raw);
            if (!byVal.has(val)) byVal.set(val, []);
            byVal.get(val).push(row);
        }
        const out = [];
        const seen = new Set();
        for (const g of (Array.isArray(groupOrder) ? groupOrder : [])) {
            if (!g || g.value == null) continue;
            const val = String(g.value);
            if (seen.has(val) || !byVal.has(val)) continue;
            seen.add(val);
            out.push({ value: val, label: g.label || val, tone: g.tone || 'neutral', rows: byVal.get(val) });
        }
        // Values the author did not list follow the listed ones, in data order.
        for (const [val, rows] of byVal) {
            if (!seen.has(val)) out.push({ value: val, label: val === '' ? EM_DASH : val, tone: 'neutral', rows });
        }
        return out;
    })() : null;

    const groupHeaderRow = (g) => {
        const open = !isGroupCollapsed(g.value);
        return (
            <tr key={`__group__${g.value}`} data-app-grid-group={g.value} data-app-grid-group-open={open || undefined}>
                <td
                    colSpan={colSpan}
                    className="p-0"
                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}
                >
                    <button
                        type="button"
                        onClick={() => toggleGroup(g.value)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left font-semibold uppercase"
                        // roleTextColor, not the raw role hex: the header is
                        // TEXT on a quiet surface and has to read in dark mode.
                        style={{
                            fontSize: 11,
                            letterSpacing: '0.03em',
                            color: g.tone && g.tone !== 'neutral' && ROLE_COLORS[g.tone]
                                ? roleTextColor(g.tone)
                                : 'var(--text-secondary)',
                        }}
                    >
                        {open
                            ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                            : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
                        <span>{g.label} · {g.rows.length}</span>
                    </button>
                </td>
            </tr>
        );
    };

    const virtualItems = virtualize ? virtualizer.getVirtualItems() : null;
    const paddingTop = virtualItems && virtualItems.length ? virtualItems[0].start : 0;
    const paddingBottom = virtualItems && virtualItems.length
        ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;

    // Column widths, at last. `width` has been in the spec since the grid
    // shipped, but it only ever reached the <th> — and under tableLayout:'auto'
    // a browser treats a th width as a hint it may ignore, so a template that
    // carefully sized eight columns got whatever the content felt like. A
    // <colgroup> is the element table layout actually honours. Layout stays
    // 'auto' so unwidthed columns keep sizing to their content.
    const hasWidths = columns.some((c) => Number.isFinite(c.size));
    const colGroup = hasWidths ? (
        <colgroup>
            {selectable !== 'none' ? <col style={{ width: 36 }} /> : null}
            {columns.map((c) => (
                <col key={c.id} style={Number.isFinite(c.size) ? { width: c.size } : undefined} />
            ))}
            {rowActions.length ? <col /> : null}
        </colgroup>
    ) : null;

    const tableEl = (
        <table
            className={`w-full app-grid-base ${dens.text}${striped ? ' app-grid-zebra' : ''}${cards ? ' app-grid-cards' : ''}`}
            style={{ tableLayout: 'auto' }}
        >
            {colGroup}
            {/*
              * Sticky header: scrolling a virtualized grid used to carry the
              * column names away, leaving a wall of values with no labels.
              * The background is opaque so rows can't show through.
              */}
            <thead
                className="sticky top-0 z-[1]"
                style={{ background: 'var(--bg-card)' }}
            >
                {headerRow()}
                {hasFilters ? filterRow() : null}
            </thead>
            <tbody>
                {grouping ? (
                    // Header row per group; a collapsed group keeps its header
                    // and drops its rows. (`virtualize` is always false here.)
                    groupedPage.flatMap((g) => [
                        groupHeaderRow(g),
                        ...(isGroupCollapsed(g.value) ? [] : g.rows.map((row) => renderRow(row))),
                    ])
                ) : virtualize ? (
                    <>
                        {paddingTop > 0 ? <tr style={{ height: paddingTop }} aria-hidden="true"><td colSpan={colSpan} /></tr> : null}
                        {virtualItems.map((vi) => renderRow(pageRows[vi.index]))}
                        {paddingBottom > 0 ? <tr style={{ height: paddingBottom }} aria-hidden="true"><td colSpan={colSpan} /></tr> : null}
                    </>
                ) : (
                    pageRows.map((row) => renderRow(row))
                )}
                {/*
                  * The last line of the table is an invitation to add one. It
                  * lives INSIDE the tbody on purpose: the moment you notice a
                  * row is missing you are looking at the bottom of the list,
                  * not at the page header.
                  */}
                {isRun && addRowActionId ? (
                    <tr data-app-grid-addrow="true">
                        <td colSpan={colSpan} className="p-0">
                            <button
                                type="button"
                                onClick={() => runAction(addRowActionId, {})}
                                className={`flex w-full items-center gap-1.5 ${cellPad} text-left font-medium`}
                                style={{ color: 'var(--app-primary)' }}
                            >
                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                {addRowLabel || 'Regel toevoegen'}
                            </button>
                        </td>
                    </tr>
                ) : null}
                {pageRows.length === 0 ? (
                    // Filtered to nothing is a different state from having no
                    // data, and it has a way out — so it says which filters are
                    // holding the rows back and offers to drop them, instead of
                    // the four flat words it used to print.
                    <tr>
                        <td colSpan={colSpan} className="px-3 py-8 text-center">
                            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>No rows match</p>
                            {activeFilterCount > 0 ? (
                                <>
                                    <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                        {activeFilterCount === 1
                                            ? 'One filter is hiding the rest.'
                                            : `${activeFilterCount} filters are hiding the rest.`}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={clearFilters}
                                        className="mt-2 px-2.5 py-1 text-xs font-medium border"
                                        style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-secondary)' }}
                                    >
                                        Clear filters
                                    </button>
                                </>
                            ) : null}
                        </td>
                    </tr>
                ) : null}
            </tbody>
        </table>
    );

    // Any explicit height — 'fill' or one of the sm/md/lg/xl tokens — means the
    // outer cell already owns a definite box, so the grid lays itself out
    // inside it: scroller flexes, chrome and footer hold their ground. Only
    // 'auto'/absent leaves the grid free-standing, and then the sole reason to
    // box it is the virtualization safety net.
    const heightToken = node?.style?.height;
    // `fill` stays a distinct thing from `boxed`: app-fill is the marker class
    // the fill contract is asserted on (AppRenderer.fill.test.jsx), and it
    // means "ask the parent for room". A boxed grid already has its room.
    const fill = isFill(node);
    const boxed = fill || (Boolean(heightToken) && heightToken !== 'auto');
    const gridHeight = boxed ? null : (virtualize ? VIRTUALIZE_FALLBACK_PX : null);

    return (
        <div
            className={`w-full min-w-0 flex flex-col gap-2${boxed ? ' h-full min-h-0' : ''}${fill ? ' app-fill' : ''}`}
            data-app-datagrid="true"
        >
            {/*
              * Selection needs a place to SAY something. Without this, ticking
              * rows changed nothing visible above the fold — no count, no way
              * back out — so a multi-select grid felt broken even though the
              * selection was live.
              */}
            {selectable !== 'none' && selectedCount > 0 ? (
                <div
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-1.5 text-xs${boxed ? ' shrink-0' : ''}`}
                    style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)', borderRadius: 'var(--app-radius)' }}
                    data-app-grid-selection="true"
                >
                    <span className="font-medium">{selectedCount} selected</span>
                    {isRun && bulkActions.length ? bulkActions.map((a, i) => (
                        <button
                            key={i}
                            type="button"
                            onClick={() => {
                                if (!a.actionId) return;
                                const picked = table.getSelectedRowModel().rows.map((r) => r.original);
                                // Handed over as FORM VALUES, so the action reads
                                // them as form.selectedRows — the same shape every
                                // other control here uses, and no new scope root.
                                runAction(a.actionId, {
                                    formValues: {
                                        selectedRows: picked,
                                        selectedIds: picked.map((r) => r && r.id).filter(Boolean),
                                        selectedCount: picked.length,
                                    },
                                    item: picked[0],
                                });
                                // Dropping the selection immediately is deliberate:
                                // the rows are about to change or disappear, and a
                                // tick left behind on a deleted row is a lie.
                                setRowSelection({});
                            }}
                            className="px-2 py-0.5 font-medium border"
                            style={{
                                borderColor: a.tone && ROLE_COLORS[a.tone] ? ROLE_COLORS[a.tone] : 'currentColor',
                                color: a.tone && ROLE_COLORS[a.tone] ? ROLE_COLORS[a.tone] : 'inherit',
                                borderRadius: 'var(--app-radius)',
                                background: 'var(--bg-primary)',
                            }}
                        >
                            {a.label}
                        </button>
                    )) : null}
                    <button
                        type="button"
                        onClick={() => setRowSelection({})}
                        className="underline underline-offset-2"
                    >
                        Clear
                    </button>
                </div>
            ) : null}

            {/*
              * The chrome row now also carries the View menu, so it renders in
              * run mode even for a grid with no search box — a table nobody can
              * search is exactly the one whose rows are hardest to tell apart,
              * and the reader had no way to change anything about it.
              *
              * It WRAPS: search plus a couple of author buttons plus the view
              * menu is more than fits across a half-width cell, and the thing
              * that got pushed off the end was always the last button — the
              * one an author put there on purpose.
              */}
            {searchable || activeFilterCount > 0 || isRun ? (
                <div className={`flex flex-wrap items-center gap-x-3 gap-y-2${boxed ? ' shrink-0' : ''}`}>
                    {searchable ? (
                        <div className="relative min-w-[9rem] max-w-xs flex-1">
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
                            <input
                                value={globalFilter ?? ''}
                                onChange={(e) => setGlobalFilter(e.target.value)}
                                placeholder="Search…"
                                aria-label="Search rows"
                                className="w-full border pl-8 pr-2.5 py-1.5 text-sm outline-none focus:border-[var(--app-primary)]"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' }}
                            />
                        </div>
                    ) : null}
                    {/*
                      * Filters were invisible once set: a column filter is a
                      * small box in a header row that scrolls, and a search
                      * term left in the box looked like an empty table. The
                      * count says the view is narrowed and the button undoes
                      * it — from ANY scroll position.
                      */}
                    {/*
                      * One chip per column filter, in words: "Amount ≥ 500",
                      * "Status: Open". The controls themselves sit in a row
                      * that scrolls with the table, so this is where a reader
                      * sees WHAT narrowed the view — and drops one filter
                      * without losing the others.
                      */}
                    {activeColumnFilters.map((f) => {
                        const column = table.getColumn(f.id);
                        if (!column) return null;
                        const meta = column.columnDef.meta || {};
                        const label = column.columnDef.header || f.id;
                        const text = describeFilter(meta.filterKind, f.value, { options: meta.filterOptions });
                        return (
                            <span
                                key={f.id}
                                data-app-grid-chip={f.id}
                                className="inline-flex max-w-[16rem] items-center gap-1 border pl-2 pr-1 py-0.5 text-xs"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--app-primary)', color: 'var(--text-primary)', borderRadius: 'var(--app-radius)' }}
                            >
                                <span className="truncate">
                                    <span style={{ color: 'var(--text-secondary)' }}>{label} </span>
                                    <span className="font-medium">{text}</span>
                                </span>
                                <button
                                    type="button"
                                    onClick={() => column.setFilterValue(undefined)}
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full hover:bg-[var(--app-primary-soft)]"
                                    style={{ color: 'var(--text-muted)' }}
                                >
                                    <X className="h-3 w-3" aria-hidden="true" />
                                    <span className="sr-only">{`Remove filter on ${label}`}</span>
                                </button>
                            </span>
                        );
                    })}
                    {activeFilterCount > 0 ? (
                        <button
                            type="button"
                            onClick={clearFilters}
                            data-app-grid-filters={activeFilterCount}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium shrink-0"
                            style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)', borderRadius: 'var(--app-radius)' }}
                        >
                            {/* Beside chips that already say what is set, the
                                count would repeat them: the button becomes the
                                one thing the chips cannot do. */}
                            <span>{activeColumnFilters.length ? 'Clear all' : activeFilterCount === 1 ? '1 filter' : `${activeFilterCount} filters`}</span>
                            <X className="w-3 h-3" aria-hidden="true" />
                            <span className="sr-only">Clear all filters</span>
                        </button>
                    ) : null}
                    {/* Pushed right: these belong to the table as a whole, not
                        to the search term sitting next to it. */}
                    {isRun ? (
                        <div className="ml-auto flex items-center gap-2">
                            {toolbarActions.map((a, i) => {
                                const filled = a.tone === 'primary';
                                return (
                                    <button
                                        key={i}
                                        type="button"
                                        onClick={() => { if (a.actionId) runAction(a.actionId, {}); }}
                                        className="inline-flex shrink-0 items-center px-2.5 py-1.5 text-xs font-medium border whitespace-nowrap"
                                        style={{
                                            background: filled ? 'var(--app-primary)' : 'var(--bg-primary)',
                                            color: filled ? 'var(--app-primary-contrast)' : 'var(--text-secondary)',
                                            borderColor: filled ? 'var(--app-primary)' : 'var(--border-default)',
                                            borderRadius: 'var(--app-radius)',
                                        }}
                                    >
                                        {a.label}
                                    </button>
                                );
                            })}
                            <GridViewMenu
                                view={view}
                                onChange={setViewKey}
                                onReset={resetView}
                                hasOverrides={hasViewOverrides}
                            />
                        </div>
                    ) : null}
                </div>
            ) : null}

            {boxed || gridHeight ? (
                <div
                    ref={scrollRef}
                    className={`w-full overflow-auto app-scroll-edges${boxed ? ' flex-1 min-h-0' : ''}`}
                    style={boxed ? undefined : { maxHeight: gridHeight }}
                >
                    {tableEl}
                </div>
            ) : (
                <div className="w-full overflow-x-auto app-scroll-edges">{tableEl}</div>
            )}

            {pageCount > 1 ? (
                <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs${boxed ? ' shrink-0' : ''}`} style={{ color: 'var(--text-secondary)' }}>
                    {/*
                      * "Page 3 of 12" tells you where you are but not how much
                      * there IS — the number people actually want from a table.
                      */}
                    <div className="flex items-center gap-3">
                        <span>{rangeFrom}–{rangeTo} of {filteredCount}</span>
                        <label className="inline-flex items-center gap-1.5">
                            <span className="sr-only">Rows per page</span>
                            <select
                                value={pageSize}
                                onChange={(e) => { setPageSize(Number(e.target.value)); setPageIndex(0); }}
                                aria-label="Rows per page"
                                className="border px-1.5 py-0.5 text-xs outline-none focus:border-[var(--app-primary)]"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' }}
                            >
                                {pageSizeChoices.map((n) => <option key={n} value={n}>{n}</option>)}
                            </select>
                            <span aria-hidden="true">per page</span>
                        </label>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                            className="inline-flex items-center gap-1 px-2 py-1 border disabled:opacity-40"
                            style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)' }}
                            aria-label="Previous page"
                        >
                            <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> Prev
                        </button>
                        <button
                            type="button"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                            className="inline-flex items-center gap-1 px-2 py-1 border disabled:opacity-40"
                            style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)' }}
                            aria-label="Next page"
                        >
                            Next <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            ) : null}

            <CellPeek peek={peek} />
        </div>
    );
}
