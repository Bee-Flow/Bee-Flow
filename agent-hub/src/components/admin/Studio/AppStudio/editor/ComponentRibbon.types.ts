import type { AppDefinition } from '../inspector/appDefinition';
import type { Dispatch, SetStateAction } from 'react';
import type { RegistryEntry } from '../runtime/componentRegistry.types';
import type { LucideIcon } from 'lucide-react';

/**
 * App Studio editor — the component palette, in two shapes.
 *
 * FULL (the default, `<ComponentRibbon />`): a strip built from the SAME
 * shared ribbon primitives as the automations "Add step" ribbon
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
 * persisted) — the same affordance the automations ribbon has. Picking a tab or
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
export interface ComponentRibbonProps {
    onCommit?: (def: AppDefinition) => void;
    query?: string | null;
    onQueryChange?: Dispatch<SetStateAction<string>> | null;
    hideSearch?: boolean;
    hideCollapse?: boolean;
}

/**
 * The compact bar — the pieces of the editor's second row that belong to the
 * palette. Returns a FRAGMENT: the host row (EditorToolRow) is `flex
 * flex-wrap`, the chips and the search sit in the row, and the unfolded full
 * ribbon is a `basis-full` child that wraps onto its own line under it.
 */
export interface CompactComponentBarProps {
    onCommit: ((def: AppDefinition) => void) | undefined;
}

export interface PaletteSearchProps {
    value: string;
    onChange: (value: string) => void;
    wide?: boolean;
}

/**
 * One edge of the scrolling strip: a pointer-transparent fade plus a compact
 * chevron button. `active=false` keeps the button mounted but inert (aria-
 * disabled, dimmed, no fade) so scrolling to an extreme never yanks the
 * control out from under the pointer or keyboard focus.
 */
export interface RibbonScrollEdgeProps {
    side: string;
    active: boolean;
    onScroll: () => void;
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
export interface PaletteCardProps {
    type: string;
    entry: RegistryEntry | undefined;
    description: string | null;
    disabled: boolean;
    onAdd: (type: string) => void;
}

/**
 * One compact chip (artboard 1b: `padding 5px 10px` r8, border-default,
 * bg-card, 13px icon; the AI chip tinted in --type-ai at 14%). Draggable under
 * its own id — the full ribbon's card for the same type may be mounted at the
 * same time, and dnd-kit keys draggables by id — while `data.componentType`
 * carries the type the shell and dnd.js read.
 */
export interface PaletteChipProps {
    type: string;
    entry: RegistryEntry | undefined;
    label: string;
    icon?: LucideIcon | null;
    iconColor?: string | undefined;
    accent?: boolean;
    description: string | null;
    disabled: boolean;
    onAdd: (type: string) => void;
}

/**
 * A category as a chip with a chevron ("Layout ▾", "Data ▾"): the whole
 * category as a portalled menu, one row per component, click to add.
 */
export interface CategoryChipProps {
    icon: LucideIcon;
    label: string;
    entries: { type: string; entry: RegistryEntry | undefined; }[];
    disabled: boolean;
    onAdd: (type: string) => void;
}
