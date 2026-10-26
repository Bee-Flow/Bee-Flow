import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

interface RepeatableListProps<T> {
    items?: T[];
    onChange: (items: T[]) => void;
    /** Renders one row's fields; `update` replaces that row. */
    renderItem: (item: T, update: (next: T) => void, idx: number) => ReactNode;
    makeNew?: () => T;
    label?: ReactNode;
    addLabel?: string;
    /** A per-row label (the link's own label, the column's heading) instead of only "#n". */
    itemLabel?: (item: T, idx: number) => unknown;
    collapsible?: boolean;
    /** Opt-in "Duplicate": returns the clone, inserted directly after the source. */
    duplicateItem?: (item: T) => T;
    /** Opt-in cap: at this many rows the "Add" button is not rendered. */
    maxItems?: number;
}

/**
 * Collapse key per row: item.id when the caller's items carry stable ids
 * (so reordering / removing keeps the right rows collapsed), else the index.
 */
const keyFor = (item: unknown, idx: number) => {
    const id = (item as { id?: unknown } | null)?.id;
    return id ? `id:${id}` : `idx:${idx}`;
};

/** The collapse map for these rows: a new row starts collapsed, a gone row is dropped (the same map when nothing changed). */
function syncCollapsed(prev: Record<string, boolean>, items: unknown[]): Record<string, boolean> {
    const next = { ...prev };
    let changed = false;
    const seenKeys = new Set<string>();
    items.forEach((item, idx) => {
        const k = keyFor(item, idx);
        seenKeys.add(k);
        if (!(k in next)) { next[k] = true; changed = true; }
    });
    for (const k of Object.keys(next)) {
        if (!seenKeys.has(k)) { delete next[k]; changed = true; }
    }
    return changed ? next : prev;
}

/**
 * Collapse state — UI-only, NOT persisted. Rows default to collapsed; a key
 * is added the first time it is seen (during render, through a state update
 * React applies before painting, never by mutating state) and dropped once
 * its row is gone, so the map never grows forever.
 */
function useCollapsedRows(items: unknown[], collapsible: boolean) {
    const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(() => (collapsible ? syncCollapsed({}, items) : {}));
    useAdjustOnChange([items, collapsible], () => {
        if (collapsible) setCollapsedMap(prev => syncCollapsed(prev, items));
    });
    const toggleCollapsed = (key: string) => setCollapsedMap(prev => ({ ...prev, [key]: !prev[key] }));
    const expand = (key: string) => setCollapsedMap(prev => ({ ...prev, [key]: false }));
    return { collapsedMap, toggleCollapsed, expand };
}

interface RowHeaderProps {
    idx: number;
    count: number;
    customLabel: string;
    collapsible: boolean;
    isCollapsed: boolean;
    onToggle: () => void;
    onMove: (dir: -1 | 1) => void;
    onDuplicate: (() => void) | null;
    onRemove: () => void;
}

function RowHeader({ idx, count, customLabel, collapsible, isCollapsed, onToggle, onMove, onDuplicate, onRemove }: RowHeaderProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-between mb-2 gap-2 min-w-0">
            <span
                className={`text-xs text-[var(--text-muted)] truncate min-w-0 flex items-center gap-1.5 ${collapsible ? 'cursor-pointer select-none' : ''}`}
                onClick={collapsible ? onToggle : undefined}
                role={collapsible ? 'button' : undefined}
                aria-expanded={collapsible ? !isCollapsed : undefined}
            >
                {collapsible ? (
                    <span
                        className="shrink-0 inline-block transition-transform"
                        style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                        aria-hidden="true"
                    >▾</span>
                ) : null}
                <span className="shrink-0">#{idx + 1}</span>
                {customLabel ? (
                    <span className="text-[var(--text-secondary)] font-medium truncate">{customLabel}</span>
                ) : null}
            </span>
            <div className="flex items-center gap-1 shrink-0">
                {/* Bare arrow glyphs have no useful accessible
                    name — a screen reader announced "button, up
                    arrow" with no idea what moves. */}
                <button type="button" onClick={() => onMove(-1)} disabled={idx === 0}
                        aria-label={t('cms_site.site.fields.move_item_up', 'Move item {n} up', { n: idx + 1 })} title={t('cms_site.site.fields.move_up', 'Move up')}
                        className="px-2 py-0.5 text-xs rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-30">↑</button>
                <button type="button" onClick={() => onMove(1)} disabled={idx === count - 1}
                        aria-label={t('cms_site.site.fields.move_item_down', 'Move item {n} down', { n: idx + 1 })} title={t('cms_site.site.fields.move_down', 'Move down')}
                        className="px-2 py-0.5 text-xs rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-30">↓</button>
                {onDuplicate ? (
                    <button type="button" onClick={onDuplicate}
                            className="px-2 py-0.5 text-xs rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">{t('cms_site.site.fields.duplicate', 'Duplicate')}</button>
                ) : null}
                <button type="button" onClick={onRemove}
                        className="px-2 py-0.5 text-xs rounded text-red-400 hover:bg-red-500/10">{t('cms_site.site.fields.remove', 'Remove')}</button>
            </div>
        </div>
    );
}

/**
 * RepeatableList — generic add/remove/reorder for an array field.
 * `renderItem(item, update)` is responsible for rendering one row's fields.
 *
 * `duplicateItem` is opt-in: when provided, the row header shows a
 * "Duplicate" button between ↓ and Remove. When omitted, the button isn't
 * rendered — no other repeater sees any change.
 */
export function RepeatableList<T>({ items = [], onChange, renderItem, makeNew, label, addLabel, itemLabel, collapsible = false, duplicateItem, maxItems }: RepeatableListProps<T>) {
    const { t } = useTranslation();
    const { collapsedMap, toggleCollapsed, expand } = useCollapsedRows(items, collapsible);
    const update = (idx: number, next: T) => {
        const copy = [...items];
        copy[idx] = next;
        onChange(copy);
    };
    const remove = (idx: number) => onChange(items.filter((_, i) => i !== idx));
    const move = (idx: number, dir: -1 | 1) => {
        const j = idx + dir;
        if (j < 0 || j >= items.length) return;
        const copy = [...items];
        [copy[idx], copy[j]] = [copy[j], copy[idx]];
        onChange(copy);
    };
    const duplicate = (idx: number) => {
        if (typeof duplicateItem !== 'function') return;
        const clone = duplicateItem(items[idx]);
        const next = [...items];
        next.splice(idx + 1, 0, clone);
        onChange(next);
    };
    // A row added via "+ Add …" starts expanded, so the user can type into it at once.
    const handleAdd = () => {
        const newItem = makeNew ? makeNew() : ({} as T);
        if (collapsible) expand(keyFor(newItem, items.length));
        onChange([...items, newItem]);
    };

    return (
        <div className="mb-3">
            {label ? (
                <div className="text-xs font-medium text-[var(--text-secondary)] mb-2">{label}</div>
            ) : null}
            <div className="flex flex-col gap-3">
                {items.map((item, idx) => {
                    const customLabel = typeof itemLabel === 'function'
                        ? String(itemLabel(item, idx) || '').trim()
                        : '';
                    const rowKey = keyFor(item, idx);
                    // Unseen keys count as collapsed too, so the very first render
                    // (before the effect runs) shows rows collapsed instead of flashing them open.
                    const isCollapsed = collapsible && (collapsedMap[rowKey] ?? true);
                    return (
                    <div
                        key={idx}
                        className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3"
                    >
                        <RowHeader
                            idx={idx}
                            count={items.length}
                            customLabel={customLabel}
                            collapsible={collapsible}
                            isCollapsed={isCollapsed}
                            onToggle={() => toggleCollapsed(rowKey)}
                            onMove={(dir) => move(idx, dir)}
                            onDuplicate={typeof duplicateItem === 'function' ? () => duplicate(idx) : null}
                            onRemove={() => remove(idx)}
                        />
                        {!isCollapsed && renderItem(item, (next) => update(idx, next), idx)}
                    </div>
                    );
                })}
            </div>
            {maxItems === undefined || items.length < maxItems ? (
                <button
                    type="button"
                    onClick={handleAdd}
                    className="mt-2 px-3 py-1.5 text-xs rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] transition-colors"
                >
                    + {addLabel || t('cms_site.site.fields.add_item', 'Add item')}
                </button>
            ) : null}
        </div>
    );
}
