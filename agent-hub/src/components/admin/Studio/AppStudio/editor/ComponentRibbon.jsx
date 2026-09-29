import { useDraggable } from '@dnd-kit/core';
import {
    ChartColumn, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, LayoutGrid, LayoutPanelTop, Search, Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PALETTE_PREFIX, buildNode } from './dnd';
import { useCatalogComponents } from '../inspector/panels/SpecPanel';
import { APP_COMPONENT_TYPES, PALETTE_CATEGORIES, PALETTE_STARTERS } from '../runtime/componentRegistry';
import { useAppEditor } from '../state/AppEditorContext';
import { findNode, findScreen, insertNode } from '../state/definitionOps';
import AnchoredMenu from '../../../../shared/AnchoredMenu';
import { kindColorVar } from '../../../../shared/kindColors';
import RibbonCluster from '../../../../shared/ribbon/RibbonCluster';
import CmdButton from '../../../../shared/ribbon/CmdButton';
import Tabs from '../../../../shared/Tabs';
import useTranslation from '../../../../../hooks/useTranslation';
import scopedStorage from '../../../../../utils/scopedStorage';

const RIBBON_TAB_KEY = 'appStudioRibbonTab';
const RIBBON_COLLAPSED_KEY = 'appStudioRibbonCollapsed';
const RIBBON_EXPANDED_KEY = 'appStudioRibbonExpanded';
const STARTER_TAB = 'Start here';
// One strip with every cluster in it. The tabs alone made findability worse
// than it looks on paper: 'Basics' and 'AI' hold ONE component each while
// 'Data' holds sixteen, so whichever tab you land on, most of the catalog is
// behind a tab you have no reason to click.
const ALL_TAB = 'All';

/**
 * The visible name of a palette group. The two tab ids above and the category
 * names in PALETTE_CATEGORIES are DATA as much as text — the active tab is
 * persisted under RIBBON_TAB_KEY and matched against `entry.category` — so
 * they stay English in the code and only the LABEL goes through t(). The
 * English fallback is the id itself, which is why a missing translation moves
 * nothing. `Layout` and `Data` reuse the keys the compact bar's category chips
 * already have rather than spelling the same word twice.
 */
function groupLabel(t, id) {
    switch (id) {
        case STARTER_TAB: return t('app_studio.palette.tab_start_here', 'Start here');
        case ALL_TAB: return t('app_studio.palette.tab_all', 'All');
        case 'Basics': return t('app_studio.palette.basics', 'Basics');
        case 'Content': return t('app_studio.palette.content', 'Content');
        case 'Layout': return t('app_studio.palette.layout', 'Layout');
        case 'Data': return t('app_studio.palette.data', 'Data');
        case 'Input': return t('app_studio.palette.input', 'Input');
        case 'AI': return t('app_studio.palette.ai', 'AI');
        default: return id;
    }
}

/**
 * The COMPACT bar's eight chips (Studio artboard 1b, row 2: "Knop ·
 * Invoerveld · Tabelweergave · Kop · Bestand · Indeling ▾ · Data ▾ ·
 * AI-blok"). Five are one component each; two open a category as a menu;
 * the last is the AI component, tinted in the AI step family's colour
 * (`color-mix(var(--type-ai) 14%)`, the artboard's exact recipe).
 *
 * A DEVIATION from the artboard, recorded in the plan (Track P): the catalog
 * holds ~50 types, which no eight chips can carry — so "All components"
 * unfolds the full ribbon below the row, and the search field searches the
 * whole catalog.
 */
export const COMPACT_CHIPS = Object.freeze([
    { type: 'button', labelKey: 'app_studio.palette.chip_button', label: 'Button', tint: 'app' },
    { type: 'input_text', labelKey: 'app_studio.palette.chip_input', label: 'Input field', tint: 'app' },
    { type: 'table', labelKey: 'app_studio.palette.chip_table', label: 'Table view', tint: 'datatable' },
    { type: 'heading', labelKey: 'app_studio.palette.chip_heading', label: 'Heading' },
    { type: 'input_file', labelKey: 'app_studio.palette.chip_file', label: 'File' },
]);

/**
 * App Studio editor — the component palette, in two shapes.
 *
 * FULL (the default, `<ComponentRibbon />`): a strip built from the SAME
 * shared ribbon primitives as the routines/automations "Add step" ribbon
 * (shared/ribbon/RibbonCluster + CmdButton). Categories are split across
 * CATEGORY TABS (shared/Tabs); a compact search box lives in the tab strip,
 * and while a query is active the tab filter is bypassed so matches surface
 * across every category.
 *
 * The strip is ONE cluster row tall, always. It used to flex-wrap: the "All"
 * tab (and 'Data' alone, nineteen components wide) stacked into three cluster
 * rows, ~350px of chrome, and since the active tab is persisted, one click on
 * "All" made that the permanent opening state — on a laptop the canvas was
 * a letterbox. Now the row scrolls HORIZONTALLY (chevrons + edge fades appear
 * only when there is more), so the ribbon's height no longer depends on which
 * tab is active. Height belongs to the canvas; width is scrollable.
 *
 * The ribbon also COLLAPSES to just its tab strip (chevron at the far right,
 * persisted) — the same affordance the routines ribbon has. Picking a tab or
 * typing a search while collapsed reopens it; drag-and-drop and search stay
 * one click away either way.
 *
 * The FIRST tab, "Start here", is a shortcut view of PALETTE_STARTERS — the
 * eight things most apps begin with, gathered from wherever they live. It is
 * the default tab because opening on a category that happens to hold one
 * component makes the palette look empty. Every category tab still lists its
 * own components, and search still spans the whole catalog.
 *
 * COMPACT (`<CompactComponentBar />`, Studio artboard 1b): the eight chips
 * above inline in the editor's second row, an "All components" toggle that
 * unfolds the FULL ribbon under the row, and the search field (which also
 * unfolds it, in search mode). The full ribbon then runs with `query`
 * controlled from the bar and its own search hidden.
 *
 * Every card and chip is BOTH:
 *   - a useDraggable the shell's DndContext resolves onto the canvas (drop
 *     position via computeDragEnd; `data.componentType` names the type), and
 *   - click-to-add: insert after the selected node (inside its parent), else
 *     append to the LAST section of the current screen; then select + pulse.
 *
 * Only the pointer listener is spread on cards — Enter/Space stay native button
 * clicks (keyboard users add by click; keyboard drag would swallow the key).
 */
export default function ComponentRibbon({
    onCommit,
    query: controlledQuery = null,
    onQueryChange = null,
    hideSearch = false,
    hideCollapse = false,
}) {
    const { t } = useTranslation();
    const { streamLock } = useAppEditor();
    const addByClick = useAddByClick(onCommit);
    // componentSpecs has carried a one-line description per component all
    // along, /catalog serves it, the inspector caches it for the session — and
    // the palette rendered a bare label. "Pane" tells a first-time author
    // nothing; the description is the only place that explains what it is for.
    const catalog = useCatalogComponents();
    const [ownQuery, setOwnQuery] = useState('');
    const query = controlledQuery ?? ownQuery;
    const [tab, setTab] = useState(() => scopedStorage.getItem(RIBBON_TAB_KEY) || STARTER_TAB);
    const [collapsed, setCollapsed] = useState(() => !hideCollapse && scopedStorage.getItem(RIBBON_COLLAPSED_KEY) === '1');

    const setCollapsedPersisted = useCallback((next) => {
        setCollapsed((prev) => {
            // Every tab click and search keystroke asks for "expanded" — only a
            // real flip is worth a localStorage write.
            if (prev !== next) scopedStorage.setItem(RIBBON_COLLAPSED_KEY, next ? '1' : '0');
            return next;
        });
    }, []);

    // Picking a category or searching IS asking to see components — a collapsed
    // strip that stayed collapsed would make both look broken.
    const handleTabChange = useCallback((next) => {
        setTab(next);
        setCollapsedPersisted(false);
    }, [setCollapsedPersisted]);
    const handleQueryChange = useCallback((value) => {
        if (onQueryChange) onQueryChange(value);
        else setOwnQuery(value);
        if (value.trim()) setCollapsedPersisted(false);
    }, [onQueryChange, setCollapsedPersisted]);

    // "Start here" first, then one tab per category that actually has
    // components (an empty category — e.g. 'AI' before its first component
    // ships — never shows a dead tab).
    const tabs = useMemo(() => {
        const present = new Set(Object.values(APP_COMPONENT_TYPES).map((e) => e.category));
        return [
            { id: STARTER_TAB, label: groupLabel(t, STARTER_TAB) },
            { id: ALL_TAB, label: groupLabel(t, ALL_TAB) },
            ...PALETTE_CATEGORIES.filter((c) => present.has(c)).map((c) => ({ id: c, label: groupLabel(t, c) })),
        ];
    }, [t]);
    const tabIds = tabs.map((x) => x.id);
    const activeTab = tabIds.includes(tab) ? tab : STARTER_TAB;

    const starterGroup = useMemo(() => ({
        category: STARTER_TAB,
        entries: PALETTE_STARTERS
            .filter((type) => APP_COMPONENT_TYPES[type])
            .map((type) => ({ type, entry: APP_COMPONENT_TYPES[type] })),
    }), []);

    useEffect(() => { scopedStorage.setItem(RIBBON_TAB_KEY, activeTab); }, [activeTab]);

    const searching = query.trim().length > 0;
    const groups = useMemo(() => filterGroups(query), [query]);

    // While searching, show every matching category (the starter view is left
    // out so a match never appears twice); otherwise just the active tab.
    let visibleGroups;
    if (searching) visibleGroups = groups;
    else if (activeTab === STARTER_TAB) visibleGroups = [starterGroup];
    else if (activeTab === ALL_TAB) visibleGroups = groups;
    else visibleGroups = groups.filter((group) => group.category === activeTab);

    // ---- horizontal overflow state -----------------------------------------
    // The chevrons (and their edge fades) render only when there really is
    // more strip in that direction — a scrollbar alone is too easy to miss,
    // and a chevron that is always there reads as decoration.
    const stripRef = useRef(null);
    const [overflow, setOverflow] = useState({ left: false, right: false });
    const syncOverflow = useCallback(() => {
        const el = stripRef.current;
        if (!el) return;
        const left = el.scrollLeft > 1;
        const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    }, []);
    useEffect(() => {
        const el = stripRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(syncOverflow);
        ro.observe(el);
        return () => ro.disconnect();
        // Subscribed once per mount of the strip (collapse unmounts it) — the
        // observer itself sees size changes; content changes are the effect
        // below, not a reason to resubscribe.
    }, [syncOverflow, collapsed]);
    // visibleGroups changes what the strip holds (tab switch, search) —
    // re-measure without touching the observer.
    useEffect(() => { syncOverflow(); }, [syncOverflow, visibleGroups, collapsed]);
    const scrollStrip = (direction) => {
        const el = stripRef.current;
        if (!el) return;
        el.scrollBy({ left: direction * Math.max(160, Math.round(el.clientWidth * 0.8)), behavior: 'smooth' });
    };

    return (
        <div
            role="toolbar"
            aria-label={t('app_studio.palette.toolbar_aria', 'Add a component')}
            className="flex shrink-0 flex-col border-b border-[var(--border-default)] bg-[var(--bg-secondary)]/40"
        >
            <div className="flex items-center gap-2 px-3 pt-1">
                <Tabs
                    size="sm"
                    ariaLabel={t('app_studio.palette.categories_aria', 'Component categories')}
                    value={activeTab}
                    onChange={handleTabChange}
                    items={tabs}
                    className="flex-1 min-w-0"
                />
                {hideSearch ? null : (
                    <PaletteSearch value={query} onChange={handleQueryChange} />
                )}
                {hideCollapse ? null : (
                    <button
                        type="button"
                        onClick={() => setCollapsedPersisted(!collapsed)}
                        aria-label={collapsed ? t('app_studio.palette.show_strip', 'Show the component strip') : t('app_studio.palette.hide_strip', 'Hide the component strip')}
                        title={collapsed ? t('app_studio.palette.show_strip', 'Show the component strip') : t('app_studio.palette.hide_strip', 'Hide the component strip')}
                        aria-expanded={!collapsed}
                        className="shrink-0 rounded-md p-1.5 hover:bg-[var(--bg-tertiary)]"
                        style={{ color: 'var(--text-tertiary)' }}
                    >
                        {collapsed
                            ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                            : <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                )}
            </div>

            {collapsed ? null : (
                <div className="relative min-w-0">
                    <div
                        ref={stripRef}
                        onScroll={syncOverflow}
                        className="flex flex-nowrap items-stretch gap-1.5 overflow-x-auto px-3 py-1.5 custom-scrollbar"
                    >
                        {visibleGroups.length === 0 ? (
                            <div className="flex items-center px-3 text-xs italic text-[var(--text-tertiary)]">
                                {t('app_studio.palette.no_match', 'No components match “{query}”', { query })}
                            </div>
                        ) : visibleGroups.map(({ category, entries }) => (
                            <RibbonCluster key={category} caption={groupLabel(t, category)}>
                                {entries.map(({ type, entry }) => (
                                    <PaletteCard
                                        key={type}
                                        type={type}
                                        entry={entry}
                                        description={catalog?.[type]?.description || null}
                                        disabled={streamLock}
                                        onAdd={addByClick}
                                    />
                                ))}
                            </RibbonCluster>
                        ))}
                    </div>
                    {/* Both chevrons mount whenever EITHER direction has more,
                        so reaching a scroll extreme never unmounts the control
                        under the pointer/focus — the exhausted side just goes
                        inert. The fade is pointer-events-none (a full-height
                        overlay stole clicks and drag-starts from the half-
                        visible card beneath it); only the small chevron button
                        takes the pointer. The fade blends to the strip's REAL
                        composited surface (bg-secondary at 40% over
                        bg-primary), not bare bg-primary — the two diverge in
                        every theme. */}
                    {overflow.left || overflow.right ? (
                        <>
                            <RibbonScrollEdge
                                side="left"
                                active={overflow.left}
                                onScroll={() => scrollStrip(-1)}
                            />
                            <RibbonScrollEdge
                                side="right"
                                active={overflow.right}
                                onScroll={() => scrollStrip(1)}
                            />
                        </>
                    ) : null}
                </div>
            )}
        </div>
    );
}

/**
 * The compact bar — the pieces of the editor's second row that belong to the
 * palette. Returns a FRAGMENT: the host row (EditorToolRow) is `flex
 * flex-wrap`, the chips and the search sit in the row, and the unfolded full
 * ribbon is a `basis-full` child that wraps onto its own line under it.
 */
export function CompactComponentBar({ onCommit }) {
    const { t } = useTranslation();
    const { streamLock } = useAppEditor();
    const addByClick = useAddByClick(onCommit);
    const catalog = useCatalogComponents();
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState(() => scopedStorage.getItem(RIBBON_EXPANDED_KEY) === '1');
    const toggleExpanded = () => {
        setExpanded((prev) => {
            scopedStorage.setItem(RIBBON_EXPANDED_KEY, prev ? '0' : '1');
            return !prev;
        });
    };
    const searching = query.trim().length > 0;
    const showFull = expanded || searching;

    const chips = COMPACT_CHIPS.filter((c) => APP_COMPONENT_TYPES[c.type]);
    const layoutEntries = useMemo(() => entriesOf('Layout'), []);
    const dataEntries = useMemo(() => entriesOf('Data'), []);
    // The AI chip is whatever the catalog files under 'AI' (one component
    // today) — derived, so a renamed key never leaves a dead chip.
    const aiType = useMemo(() => Object.entries(APP_COMPONENT_TYPES).find(([, e]) => e.category === 'AI')?.[0] || null, []);

    return (
        <>
            <span
                className="shrink-0 select-none text-[10px] font-semibold uppercase tracking-[.08em]"
                style={{ color: 'var(--text-tertiary)' }}
                data-testid="palette-kicker"
            >
                {t('app_studio.palette.kicker', 'Components')}
            </span>
            {chips.map((chip) => {
                const entry = APP_COMPONENT_TYPES[chip.type];
                return (
                    <PaletteChip
                        key={chip.type}
                        type={chip.type}
                        entry={entry}
                        label={t(chip.labelKey, chip.label)}
                        iconColor={chip.tint ? kindColorVar(chip.tint) : undefined}
                        description={catalog?.[chip.type]?.description || null}
                        disabled={streamLock}
                        onAdd={addByClick}
                    />
                );
            })}
            <CategoryChip
                icon={LayoutPanelTop}
                label={t('app_studio.palette.layout', 'Layout')}
                entries={layoutEntries}
                disabled={streamLock}
                onAdd={addByClick}
            />
            <CategoryChip
                icon={ChartColumn}
                label={t('app_studio.palette.data', 'Data')}
                entries={dataEntries}
                disabled={streamLock}
                onAdd={addByClick}
            />
            {aiType ? (
                <PaletteChip
                    type={aiType}
                    entry={APP_COMPONENT_TYPES[aiType]}
                    label={t('app_studio.palette.ai_block', 'AI block')}
                    icon={Sparkles}
                    accent
                    description={catalog?.[aiType]?.description || null}
                    disabled={streamLock}
                    onAdd={addByClick}
                />
            ) : null}
            <div className="min-w-2 flex-1" />
            <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={showFull}
                aria-controls="app-studio-full-ribbon"
                className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium hover:bg-[var(--bg-tertiary)]"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
            >
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
                {t('app_studio.palette.all', 'All components')}
                <ChevronDown className={`h-3 w-3 transition-transform ${showFull ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            <PaletteSearch value={query} onChange={setQuery} wide />
            {showFull ? (
                <div id="app-studio-full-ribbon" className="basis-full w-full min-w-0">
                    <ComponentRibbon onCommit={onCommit} query={query} onQueryChange={setQuery} hideSearch hideCollapse />
                </div>
            ) : null}
        </>
    );
}

/** The catalog's entries of one category, in registry order. */
function entriesOf(category) {
    return Object.entries(APP_COMPONENT_TYPES)
        .filter(([, entry]) => entry.category === category)
        .map(([type, entry]) => ({ type, entry }));
}

/** Every category with the entries that match `query` (all of them when empty). */
function filterGroups(query) {
    const q = query.trim().toLowerCase();
    return PALETTE_CATEGORIES.map((category) => ({
        category,
        entries: Object.entries(APP_COMPONENT_TYPES)
            .filter(([, entry]) => entry.category === category)
            .filter(([type, entry]) => !q
                || entry.label.toLowerCase().includes(q)
                || type.toLowerCase().includes(q))
            .map(([type, entry]) => ({ type, entry })),
    })).filter((group) => group.entries.length > 0);
}

/**
 * Click-to-add, shared by the full ribbon and the compact bar. After the
 * selected node inside ITS parent (section or container) — but only while
 * that node is on the screen being looked at, otherwise the component would
 * land out of sight on the previous screen. With nothing usable selected,
 * append to the current screen's last section.
 */
function useAddByClick(onCommit) {
    const { definition, screenId, selectedNodeId, streamLock, dispatch } = useAppEditor();
    return useCallback((type) => {
        if (streamLock) return;
        const node = buildNode(type);
        if (!node) return;

        let parentId = null;
        let index;
        const selected = selectedNodeId ? findNode(definition, selectedNodeId) : null;
        const found = selected && selected.screen.id === screenId ? selected : null;
        if (found) {
            parentId = found.parent.id;
            index = found.index + 1;
        } else {
            const screen = findScreen(definition, screenId) || definition?.screens?.[0];
            const sections = screen?.sections || [];
            parentId = sections[sections.length - 1]?.id || null;
        }
        if (!parentId) return;

        const { def, nodeId } = insertNode(definition, { parentId, index, node });
        if (!nodeId) return;
        onCommit?.(def);
        dispatch({ type: 'select_node', nodeId });
        dispatch({ type: 'set_recent_ids', ids: [nodeId] });
    }, [definition, screenId, selectedNodeId, streamLock, dispatch, onCommit]);
}

function PaletteSearch({ value, onChange, wide = false }) {
    const { t } = useTranslation();
    return (
        <div className="relative flex shrink-0 items-center self-center">
            <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]"
                aria-hidden="true"
            />
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('app_studio.palette.search_placeholder', 'Search a component…')}
                aria-label={t('app_studio.palette.search_aria', 'Search components')}
                className={`${wide ? 'w-48' : 'w-36'} rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] py-1.5 pl-7 pr-2 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]`}
            />
        </div>
    );
}

/**
 * One edge of the scrolling strip: a pointer-transparent fade plus a compact
 * chevron button. `active=false` keeps the button mounted but inert (aria-
 * disabled, dimmed, no fade) so scrolling to an extreme never yanks the
 * control out from under the pointer or keyboard focus.
 */
function RibbonScrollEdge({ side, active, onScroll }) {
    const { t } = useTranslation();
    const label = side === 'left'
        ? t('app_studio.palette.scroll_left', 'Scroll components left')
        : t('app_studio.palette.scroll_right', 'Scroll components right');
    const Chevron = side === 'left' ? ChevronLeft : ChevronRight;
    // The strip's visible surface is bg-secondary at 40% over the shell's
    // bg-primary; the fade must dissolve into THAT, not into bare bg-primary.
    const surface = 'color-mix(in srgb, var(--bg-secondary) 40%, var(--bg-primary))';
    return (
        <div
            className={`pointer-events-none absolute inset-y-0 z-10 flex w-8 items-center ${side === 'left' ? 'left-0 justify-start pl-0.5' : 'right-0 justify-end pr-0.5'}`}
            style={active ? { background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, ${surface} 30%, transparent)` } : undefined}
        >
            <button
                type="button"
                onClick={active ? onScroll : undefined}
                aria-label={label}
                title={label}
                aria-disabled={!active}
                className={`pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--bg-tertiary)] ${active ? '' : 'opacity-30'}`}
                style={{ color: 'var(--text-secondary)' }}
            >
                <Chevron className="h-4 w-4" aria-hidden="true" />
            </button>
        </div>
    );
}

/**
 * One draggable + click-to-add component card — a thin dnd-kit wrapper around
 * the shared CmdButton (presentation lives there). Only onPointerDown is
 * spread; Enter/Space stay native clicks.
 *
 * When the catalog has a description it goes through CmdButton's `desc` — the
 * styled screen tip (CmdTip) that shows on hover AND keyboard focus, works on
 * touch, and does not take a second to appear. The native `title` was the
 * previous carrier and it stays only as the fallback for a type the catalog
 * has nothing to say about (and for tests, which stub an empty catalog).
 */
function PaletteCard({ type, entry, description, disabled, onAdd }) {
    const { t } = useTranslation();
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `${PALETTE_PREFIX}${type}`,
        data: { type: 'palette', componentType: type },
        disabled,
    });

    return (
        <CmdButton
            icon={entry.icon}
            label={entry.label}
            title={t('app_studio.palette.card_title', '{label} — click to add, or drag onto the canvas', { label: entry.label })}
            desc={description}
            tipFooter={t('app_studio.palette.card_tip', 'Click to add — or drag it onto the canvas')}
            onClick={() => onAdd(type)}
            disabled={disabled}
            dragging={isDragging}
            grabbable
            buttonRef={setNodeRef}
            onPointerDown={listeners?.onPointerDown}
            aria-describedby={attributes['aria-describedby']}
        />
    );
}

/**
 * One compact chip (artboard 1b: `padding 5px 10px` r8, border-default,
 * bg-card, 13px icon; the AI chip tinted in --type-ai at 14%). Draggable under
 * its own id — the full ribbon's card for the same type may be mounted at the
 * same time, and dnd-kit keys draggables by id — while `data.componentType`
 * carries the type the shell and dnd.js read.
 */
function PaletteChip({ type, entry, label, icon = null, iconColor, accent = false, description, disabled, onAdd }) {
    const { t } = useTranslation();
    const { listeners, setNodeRef, isDragging } = useDraggable({
        id: `${PALETTE_PREFIX}chip:${type}`,
        data: { type: 'palette', componentType: type },
        disabled,
    });
    const Icon = icon || entry.icon;
    const ai = kindColorVar('agent');
    return (
        <button
            type="button"
            ref={setNodeRef}
            onClick={() => onAdd(type)}
            onPointerDown={listeners?.onPointerDown}
            disabled={disabled}
            title={description || t('app_studio.palette.card_title', '{label} — click to add, or drag onto the canvas', { label: entry.label })}
            data-palette-chip={type}
            className={`inline-flex h-7 shrink-0 cursor-grab items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs transition active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 ${accent ? 'font-semibold' : 'border font-medium hover:bg-[var(--bg-tertiary)]'} ${isDragging ? 'opacity-50' : ''}`}
            style={accent
                ? { background: `color-mix(in srgb, ${ai} 14%, transparent)`, color: ai }
                : { borderColor: 'var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
        >
            {Icon ? <Icon className="h-[13px] w-[13px] shrink-0" style={iconColor ? { color: iconColor } : undefined} aria-hidden="true" /> : null}
            {label}
        </button>
    );
}

/**
 * A category as a chip with a chevron ("Layout ▾", "Data ▾"): the whole
 * category as a portalled menu, one row per component, click to add.
 */
function CategoryChip({ icon, label, entries, disabled, onAdd }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef(null);
    const Icon = icon;
    return (
        <>
            <button
                type="button"
                ref={anchorRef}
                onClick={() => setOpen((v) => !v)}
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('app_studio.palette.category_aria', '{label} components', { label })}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
            >
                <Icon className="h-[13px] w-[13px] shrink-0" aria-hidden="true" />
                {label}
                <ChevronDown className="h-3 w-3" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="left"
                role="menu"
                minWidth={200}
                className="py-1"
                style={{ background: 'var(--bg-secondary)' }}
            >
                {entries.map(({ type, entry }) => {
                    const EntryIcon = entry.icon;
                    return (
                        <button
                            key={type}
                            type="button"
                            role="menuitem"
                            onClick={() => { setOpen(false); onAdd(type); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)]"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {EntryIcon ? <EntryIcon className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" /> : null}
                            {entry.label}
                        </button>
                    );
                })}
            </AnchoredMenu>
        </>
    );
}
