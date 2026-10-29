import type React from 'react';
import AppIcon from '@/components/icons/AppIcon';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { PeekGroupLabel, PeekRow } from '../listPeek';
import { walkPath } from '../resolveBinding';
import { displayValue } from '../uiBits';
import { PEEK_WIDTH, badgeStyle } from './AppList.helpers';

// One row of the App Studio list (its body and its badge) and the pure layout
// decisions around it: the list and row looks, where the peek opens, and grouping.

/**
 * Look pass (spec: list.look = rows | cards | tiles). 'rows' — and any value
 * this build does not know — is the identity path: the exact class strings and
 * style objects from before the look existed, so stored definitions render
 * byte-identically.
 */
export function listLook(look: string, fillCls: string) {
    let listCls = `flex flex-col gap-2${fillCls}`;
    let listStyle: React.CSSProperties | undefined;
    if (look === 'cards') {
        // Elevated cards want more air between them than flat rows do.
        listCls = `flex flex-col gap-3${fillCls}`;
    } else if (look === 'tiles') {
        // The tiles arrange INSIDE the component: the outer 12-col grid is
        // untouched, the <ul> becomes its own responsive tile grid.
        listCls = `grid gap-2.5${fillCls}`;
        listStyle = { gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' };
    }
    return { listCls, listStyle };
}

/** One row's classes and style for the list's look, with the selected state. */
export function rowLook(look: string, size: string, selected: boolean) {
    let cls = `flex items-center gap-2.5 border w-full text-left ${size === 'sm' ? 'px-2.5 py-1.5' : 'px-3 py-2'}`;
    let style: React.CSSProperties = {
        background: selected ? 'var(--app-primary-soft)' : 'var(--bg-card)',
        borderColor: selected ? 'var(--app-primary)' : 'var(--border-default)',
        borderRadius: 'var(--app-radius)',
    };
    if (look === 'cards') {
        // Each item on its own elevated card: the hairline border gives way
        // to semantic elevation (--app-shadow-1 becomes a ring in high
        // contrast), with roomier padding. Selection keeps its primary
        // border so it never relies on tint alone.
        cls = `flex items-center gap-2.5 border w-full text-left ${size === 'sm' ? 'px-3 py-2' : 'px-3.5 py-3'}`;
        style = {
            background: selected ? 'var(--app-primary-soft)' : 'var(--bg-card)',
            borderColor: selected ? 'var(--app-primary)' : 'transparent',
            borderRadius: 'var(--app-radius)',
            boxShadow: 'var(--app-shadow-1)',
        };
    } else if (look === 'tiles') {
        // A tile stacks its content vertically and fills its grid cell, so a
        // row of tiles reads as equal-height cards.
        cls = `flex flex-col gap-2 border w-full h-full text-left ${size === 'sm' ? 'px-2.5 py-2' : 'px-3 py-2.5'}`;
        style = {
            background: selected ? 'var(--app-primary-soft)' : 'var(--bg-card)',
            borderColor: selected ? 'var(--app-primary)' : 'var(--border-default)',
            borderRadius: 'var(--app-radius)',
            boxShadow: 'var(--app-shadow-1)',
        };
    }
    return { cls, style };
}

/**
 * Where the peek panel opens, in viewport coordinates: to the right of the row
 * where there is room, flipped to its left where there is not — a rail on the
 * right edge of a narrow window would otherwise push the panel off the screen
 * it is meant to explain.
 */
export function peekPosition(rect: { top: number; left: number; right: number }, vw: number, vh: number) {
    const left = vw - rect.right >= PEEK_WIDTH + 16
        ? rect.right + 8
        : Math.max(8, rect.left - PEEK_WIDTH - 8);
    const top = Math.max(8, Math.min(rect.top, vh - 120));
    return { top, left, maxHeight: Math.max(120, vh - top - 16) };
}

/**
 * Grouping (spec: list.groupKey/groupOrder/groupLabelMap): empty values stay
 * ungrouped and first (the file_gallery precedent), groupOrder fixes the order
 * and any value not in it follows in first-seen order. Each entry keeps the
 * row's index in the source array.
 */
export function groupRows(items: PeekRow[], groupKey: string, groupOrder: unknown[], groupLabelMap: PeekGroupLabel[]) {
    const labelMap = new Map(
        (Array.isArray(groupLabelMap) ? groupLabelMap : [])
            .filter((m) => m && m.value != null)
            .map((m) => [String(m.value), m.label]),
    );
    const order = (Array.isArray(groupOrder) ? groupOrder : []).map((v) => String(v));
    const loose: [PeekRow, number][] = [];
    const groups = new Map<string, [PeekRow, number][]>();
    items.forEach((item, i) => {
        const raw = walkPath(item, groupKey);
        const name = typeof raw === 'string' ? raw.trim() : (raw == null ? '' : String(raw));
        if (!name) { loose.push([item, i]); return; }
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)?.push([item, i]);
    });
    const ordered = [
        ...order.filter((n) => groups.has(n)),
        ...[...groups.keys()].filter((n) => !order.includes(n)),
    ];
    const sections: { name: string; label: string; entries: [PeekRow, number][] }[] = [];
    ordered.forEach((name) => {
        const entries = groups.get(name);
        if (!entries) return;
        const mapped = labelMap.get(name);
        sections.push({ name, label: mapped != null && mapped !== '' ? mapped : name, entries });
    });
    return { loose, sections };
}

interface ListBadgeProps {
    label: unknown;
    tone: string | null | undefined;
    hasPeek: boolean;
    onShow: (e: React.MouseEvent<HTMLSpanElement>) => void;
    onHide: () => void;
}

/** A row's status pill; with a peek behind it, hovering it opens the panel. */
export function ListBadge({ label, tone, hasPeek, onShow, onHide }: ListBadgeProps) {
    return (
        <span
            className="inline-flex items-center px-1.5 py-0.5 text-[11px] rounded"
            style={{ ...badgeStyle(tone), borderRadius: 'var(--app-radius)' }}
            data-app-list-badge={tone || 'neutral'}
            data-app-list-peek={hasPeek ? 'true' : undefined}
            // Hover lands on the BADGE rather than the whole row: the panel
            // explains the number, and a popup that opens every time the
            // pointer crosses a row on its way somewhere else is a flicker,
            // not an aid. Keyboard users get it from the row's own focus.
            onMouseEnter={hasPeek ? onShow : undefined}
            onMouseLeave={hasPeek ? onHide : undefined}
        >
            {displayValue(label)}
        </span>
    );
}

interface ListRowBodyProps {
    t: TranslateFn;
    icon: string | null;
    unread: boolean;
    size: string;
    title: unknown;
    stamp: string | null;
    badgeInMeta: boolean;
    subtitle: unknown;
    meta: unknown;
    badge: unknown;
    badgeEl: React.ReactNode;
    detail: unknown;
}

/** A row's content: icon, unread dot, title and time, subtitle (with the badge when it sits there), meta line, open-row detail. */
export function ListRowBody({ t, icon, unread, size, title, stamp, badgeInMeta, subtitle, meta, badge, badgeEl, detail }: ListRowBodyProps) {
    return (
        <>
            {icon ? (
                <span
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0 [background:var(--app-primary-soft)] [color:var(--app-primary)]"
                >
                    <AppIcon name={icon} className="w-3.5 h-3.5" />
                </span>
            ) : null}
            {unread ? (
                <span
                    className="h-1.5 w-1.5 rounded-full shrink-0 [background:var(--app-primary)]"
                    aria-label={t('studio_apps_runtime.list.unread', 'Unread')}
                    data-app-list-unread="true"
                />
            ) : null}
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                    <span
                        className={`${size === 'sm' ? 'text-xs' : 'text-sm'} truncate ${unread ? 'font-semibold' : 'font-medium'}`}
                    >
                        {displayValue(title)}
                    </span>
                    {stamp ? (
                        <span className="ml-auto shrink-0 text-[11px] text-[var(--text-muted)]">
                            {stamp}
                        </span>
                    ) : null}
                </div>
                <RowSubtitle badgeInMeta={badgeInMeta} subtitle={subtitle} badgeEl={badgeEl} />
                <RowMeta badgeInMeta={badgeInMeta} meta={meta} badge={badge} badgeEl={badgeEl} />
                {detail != null && detail !== '' ? (
                    <div className="mt-1 text-xs truncate [color:var(--app-primary)]!" data-app-list-detail="true">
                        {displayValue(detail)}
                    </div>
                ) : null}
            </div>
        </>
    );
}

/** The subtitle line; with the badge on the right of it when the badge sits there. */
function RowSubtitle({ badgeInMeta, subtitle, badgeEl }: { badgeInMeta: boolean; subtitle: unknown; badgeEl: React.ReactNode }) {
    return badgeInMeta ? (
        subtitle != null && subtitle !== '' ? (
            <div className="text-xs truncate text-[var(--text-secondary)]">
                {displayValue(subtitle)}
            </div>
        ) : null
    ) : (subtitle != null && subtitle !== '') || badgeEl ? (
        <div className="flex items-baseline gap-2">
            {subtitle != null && subtitle !== '' ? (
                <span className="text-xs truncate text-[var(--text-secondary)]">
                    {displayValue(subtitle)}
                </span>
            ) : null}
            {badgeEl ? <span className="ml-auto shrink-0">{badgeEl}</span> : null}
        </div>
    ) : null;
}

/** The meta line; it carries the badge when the badge sits on the third line. */
function RowMeta({ badgeInMeta, meta, badge, badgeEl }: { badgeInMeta: boolean; meta: unknown; badge: unknown; badgeEl: React.ReactNode }) {
    return badgeInMeta ? (
        (meta != null && meta !== '') || badge != null ? (
            <div className="mt-1 flex items-center gap-1.5">
                {badgeEl}
                {meta != null && meta !== '' ? (
                    <span className="text-[11px] truncate text-[var(--text-muted)]">
                        {displayValue(meta)}
                    </span>
                ) : null}
            </div>
        ) : null
    ) : meta != null && meta !== '' ? (
        <div className="mt-1 flex items-center gap-1.5">
            <span className="text-[11px] truncate text-[var(--text-muted)]">
                {displayValue(meta)}
            </span>
        </div>
    ) : null;
}
