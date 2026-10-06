import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import {
    PAGE_SIZE, crumbsOf, drill, jumpTo, levelPattern, openStack, pageView, patchTop, resolveLevels, returnOf, rootStack, up,
    type Level, type PageView, type Return,
} from './levels';
import type { OutputColumnsState } from './useOutputColumns';
import WideLevel, { NestedLevel, rowNameOf, type LevelNav } from './WideLevel';

interface WideOutputViewProps {
    rows: unknown[];
    cols: OutputColumnsState;
    /** "Continues on · <step label>". */
    stepLabel?: string | null;
    /** Open with this row's details showing (or, with initialOpen, the row a list is opened from). */
    initialRow?: number | null;
    /** Open straight on the list this column of `initialRow` holds. */
    initialOpen?: string | null;
    /** Where the step's column choice is remembered; a nested list adds `>` and its path. */
    columnsKey?: string | null;
    /** The step's own value, for the run sentence. */
    source?: unknown;
    onClose: () => void;
}

/** Where focus goes after the next commit: the current crumb, or back to the button a list was opened from. */
type FocusIntent = { to: 'crumb' } | ({ to: 'opener' } & Return);

type KeyAction = 'clear' | 'picker' | 'detail' | 'up' | 'close' | 'prev' | 'next';

interface KeyState {
    /** Focus is in this level's (non-empty) search box. */
    inSearch: boolean;
    typing: boolean;
    pickerOpen: boolean;
    /** The row whose details are on screen; null in JSON mode. */
    selected: number | null;
    depth: number;
}

/**
 * Esc steps back one thing at a time: clear the search, close the column
 * picker, close the row details, go up a level, close the view. ↑/↓ walk the
 * rows while details are open and nobody is typing.
 */
function keyAction(key: string, s: KeyState): KeyAction | null {
    if (key === 'Escape') {
        if (s.inSearch) return 'clear';
        if (s.pickerOpen) return 'picker';
        if (s.selected != null) return 'detail';
        return s.depth > 0 ? 'up' : 'close';
    }
    if (s.typing || s.selected == null) return null;
    if (key === 'ArrowDown') return 'next';
    if (key === 'ArrowUp') return 'prev';
    return null;
}

function initialStack(rows: unknown[], cols: OutputColumnsState, row: number | null, open: string | null, t: TranslateFn): Level[] {
    if (open == null || row == null) return rootStack(row);
    const byKey = new Map(cols.columns.map(c => [c.key, c]));
    const pinned = byKey.get(cols.wide[0]) || null;
    return openStack(row, open, byKey.get(open)?.label || open, rowNameOf(rows, row, pinned, t));
}

/**
 * The level stack, its rows resolved from the root, and two repairs: a new
 * run (new root rows) returns to the root, and a level whose list is gone is
 * cut off with everything below it.
 */
function useLevelStack(rows: unknown[], init: () => Level[]) {
    const [stack, setStack] = useState<Level[]>(init);
    const [seen, setSeen] = useState(rows);
    let current = stack;
    if (seen !== rows) {
        const root = stack[0];
        const keep = root.selected != null && root.selected < rows.length ? root.selected : null;
        current = [{ ...root, selected: keep }];
        setSeen(rows);
        setStack(current);
    }
    const levels = useMemo(() => resolveLevels(rows, current), [rows, current]);
    const view = levels.length < current.length ? current.slice(0, levels.length) : current;
    return { stack: view, levels, setStack };
}

const findBy = (el: HTMLElement, attr: string, value: string) =>
    Array.from(el.querySelectorAll<HTMLElement>(`[${attr}]`)).find(b => b.getAttribute(attr) === value) || null;

/** The details' "Show all" for that path, when the details show the row it was opened from. */
function detailOpener(el: HTMLElement, want: Return): HTMLElement | null {
    const button = findBy(el, 'data-open-path', want.path);
    return button?.closest('[data-detail-row]')?.getAttribute('data-detail-row') === String(want.row) ? button : null;
}

/**
 * Where focus may go, best first. After going up: the button the list was
 * opened from (the grid cell's "16 rows ›", or the details' "Show all"), then
 * the other one, then the current crumb.
 */
function focusTargets(el: HTMLElement, want: FocusIntent): HTMLElement[] {
    const crumb = el.querySelector<HTMLElement>('[data-crumb-current]');
    if (want.to === 'crumb') return crumb ? [crumb] : [];
    const cell = findBy(el, 'data-open-key', `${want.row}:${want.path}`);
    const detail = detailOpener(el, want);
    const order = want.from === 'detail' ? [detail, cell] : [cell, detail];
    return [...order, crumb].filter((b): b is HTMLElement => !!b);
}

/**
 * Focus a target; false when the browser declines, because it is not
 * rendered (below 900px the details hide the grid with display:none).
 */
function tryFocus(target: HTMLElement): boolean {
    target.focus();
    return document.activeElement === target;
}

/**
 * Focus, in the same commit as the change: the button that unmounted with a
 * level must never leave focus on <body>, where the step drawer's own
 * document-level Esc would close everything.
 */
function useDialogFocus(ref: RefObject<HTMLDivElement | null>, intent: RefObject<FocusIntent | null>) {
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const want = intent.current;
        intent.current = null;
        const placed = want ? focusTargets(el, want).some(target => tryFocus(target)) : false;
        if (!placed && !el.contains(document.activeElement)) el.focus();
    });
}

type KeyHandler = (key: string, target: HTMLElement) => boolean;

/**
 * The safety net under useDialogFocus: a key pressed while focus sits outside
 * the view (a focused button unmounted inside a level that re-rendered on its
 * own) is caught on the way down, before the step drawer's document-level
 * listener can see it, and handled as if the view had focus.
 */
function useStrayKeys(ref: RefObject<HTMLDivElement | null>, handler: RefObject<KeyHandler | null>) {
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            const el = ref.current;
            if (!el || el.contains(e.target as Node)) return;
            e.stopPropagation();
            el.focus();
            if (handler.current?.(e.key, el)) e.preventDefault();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [ref, handler]);
}

interface ViewKeys {
    top: Level;
    depth: number;
    view: PageView;
    json: boolean;
    pickerOpen: boolean;
    patch: (p: Partial<Level>) => void;
    goUp: () => void;
    closePicker: () => void;
    onClose: () => void;
    dialogRef: RefObject<HTMLDivElement | null>;
}

/** ↑/↓ through the current level's rows, and the Esc chain, on the view and as a safety net outside it. */
function useViewKeys({ top, depth, view, json, pickerOpen, patch, goUp, closePicker, onClose, dialogRef }: ViewKeys) {
    const move = (delta: number) => {
        const pos = view.filtered.findIndex(r => r.index === top.selected);
        const next = pos < 0 ? null : view.filtered[pos + delta];
        if (next) patch({ selected: next.index, page: Math.floor((pos + delta) / PAGE_SIZE) });
    };
    const actions: Record<KeyAction, () => void> = {
        clear: () => patch({ query: '', page: 0 }),
        picker: closePicker,
        detail: () => patch({ selected: null }),
        up: goUp,
        close: onClose,
        prev: () => move(-1),
        next: () => move(1),
    };
    const handleKey: KeyHandler = (key, target) => {
        const action = keyAction(key, {
            inSearch: target.hasAttribute('data-wide-search') && !!top.query,
            typing: target.tagName === 'INPUT',
            pickerOpen,
            selected: json ? null : top.selected,
            depth,
        });
        if (action) actions[action]();
        return !!action;
    };
    const keyHandler = useRef<KeyHandler | null>(null);
    useLayoutEffect(() => { keyHandler.current = handleKey; });
    useStrayKeys(dialogRef, keyHandler);
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') e.stopPropagation();
        if (handleKey(e.key, e.target as HTMLElement)) e.preventDefault();
    };
    return { move, onKeyDown };
}

/**
 * "Continues on", enlarged (artboard 4d): row search, the column picker,
 * Compact, a pinned first column, pagination and a row detail on the right,
 * and a list inside a row opens as a level of its own, with a breadcrumb and
 * Esc to go back. Up to 2000 × 1100: on a large screen the view is really larger.
 */
export default function WideOutputView({
    rows, cols, stepLabel = null, initialRow = null, initialOpen = null, columnsKey = null, source, onClose,
}: WideOutputViewProps) {
    const { t } = useTranslation();
    const { stack, levels, setStack } = useLevelStack(rows, () => initialStack(rows, cols, initialRow, initialOpen, t));
    const [json, setJson] = useState(false);
    const [compact, setCompact] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    // The list the last move up came from: its path opens again in the row details.
    const [returned, setReturned] = useState<Return | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const focusNext = useRef<FocusIntent | null>(null);
    useDialogFocus(dialogRef, focusNext);

    const depth = stack.length - 1;
    const top = stack[depth];
    const levelRows = levels[depth];
    const view = useMemo(() => pageView(levelRows, top.query, top.page), [levelRows, top.query, top.page]);
    const title = t('automations.output.wide_title', 'Continues on · {step}', { step: stepLabel || '' });
    const crumbs = crumbsOf(stack, stepLabel ? title : t('automations.ndv.continues', 'Continues on'));

    const go = (next: Level[], to: FocusIntent['to']) => {
        const back = returnOf(stack, next);
        focusNext.current = to === 'opener' && back ? { to, ...back } : { to: 'crumb' };
        setReturned(back);
        setPickerOpen(false);
        setStack(next);
    };
    const goUp = () => go(up(stack), 'opener');
    const patch = (p: Partial<Level>) => setStack(patchTop(stack, p));
    const { move, onKeyDown } = useViewKeys({
        top, depth, view, json, pickerOpen, patch, goUp, closePicker: () => setPickerOpen(false), onClose, dialogRef,
    });

    const nav: LevelNav = {
        crumbs,
        onCrumb: (target) => go(jumpTo(stack, target, levels), 'crumb'),
        onBack: depth > 0 ? goUp : null,
        onDrill: (d) => go(drill(stack, d), 'crumb'),
        reveal: returned?.depth === depth ? returned : null,
        onPatch: patch,
        onMove: move,
        json,
        onJson: (on) => { setJson(on); setPickerOpen(false); },
        compact,
        onToggleCompact: () => setCompact(c => !c),
        pickerOpen,
        onTogglePicker: () => setPickerOpen(o => !o),
        onClose,
        keepFocus: () => {
            const el = dialogRef.current;
            if (el && !el.contains(document.activeElement)) el.focus();
        },
    };
    const pattern = levelPattern(stack);
    const storageKey = columnsKey ? `${columnsKey}>${pattern}` : null;

    const body = (
        <div className="fixed inset-0 z-[1000] bg-black/30 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div
                ref={dialogRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onKeyDown={onKeyDown}
                className="@container/wideout w-full max-w-[2000px] h-[calc(100vh-64px)] max-h-[1100px] rounded-xl overflow-hidden shadow-2xl bg-[var(--bg-card)] text-[var(--text-primary)] flex flex-col text-xs outline-none"
                data-testid="output-wide-view"
            >
                {depth === 0
                    ? <WideLevel rows={levelRows} cols={cols} level={top} view={view} depth={0} source={source} nav={nav} />
                    : <NestedLevel key={storageKey ?? `${depth}:${pattern}`} storageKey={storageKey} rows={levelRows} level={top} view={view} depth={depth} nav={nav} />}
            </div>
        </div>
    );
    return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
}
