import { tryEvaluate } from '@shared/expr/engine.mjs';
import { useCallback, useMemo, useState } from 'react';
import AppIcon from '../../../../../icons/AppIcon';
import { buildPeekIndex, peekBadgeLabel, peekBadgeTone, peekKey, peekSections } from '../listPeek';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill, ROLE_COLORS, roleTextColor } from '../styleResolver';
import { Inbox } from 'lucide-react';
import { EmptyText, ErrorText, SkeletonLines, displayValue, useStickyBinding } from '../uiBits';

/**
 * App Studio runtime — 'list'. Spec: server/appStudio/componentSpecs.js.
 *
 * Rich enough to be a real sidebar picker: a title, a subtitle, a meta line, a
 * right-aligned relative timestamp, a status pill (badgeToneMap, the same shape
 * message_thread uses for sideMap) and an unread marker. Rows are clickable
 * when the node carries onRowClick — same contract as table/data_grid/timeline:
 * the clicked row is handed to the action as its form values.
 *
 * The PEEK (peekSource and friends, see ./listPeek.js) joins a second query to
 * the rows: the count of a row's related records goes into its badge, and the
 * records themselves float in a panel on hover or keyboard focus.
 */

/** Panel width; also the space the row needs on its right to open there. */
const PEEK_WIDTH = 320;

/** "3 min", "2 u", "5 d" — short enough for a narrow sidebar. */
function relativeTime(value) {
    if (value == null || value === '') return null;
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) return displayValue(value);
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'nu';
    if (mins < 60) return `${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} u`;
    return `${Math.round(hours / 24)} d`;
}

function badgeStyle(tone) {
    if (!tone || tone === 'neutral') {
        return { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' };
    }
    const color = ROLE_COLORS[tone] || ROLE_COLORS.primary;
    // The wash keeps the role's hue; the TEXT has to be readable on it, which
    // the raw hex is not in the light themes.
    return { background: `color-mix(in srgb, ${color} 16%, transparent)`, color: roleTextColor(tone) };
}

/**
 * The floating panel: the row's related records, in group order, capped.
 *
 * Deliberately not interactive — pointer-events are off in the stylesheet, so
 * a panel hanging over the pane next to the list can never swallow a click
 * meant for what is underneath it.
 */
function renderPeekPanel(entry, at, opts) {
    const { sections, more } = peekSections(entry, opts.peekLimit);
    if (!sections.length) return null;
    const moreText = more
        ? (typeof opts.peekMoreText === 'string' && opts.peekMoreText
            ? opts.peekMoreText.split('{count}').join(String(more))
            : `+ ${more} more`)
        : null;
    return (
        <div
            className="app-list-peek"
            role="tooltip"
            data-app-list-peek-panel="true"
            style={{ position: 'fixed', top: at.top, left: at.left, width: PEEK_WIDTH, maxHeight: at.maxHeight }}
        >
            {opts.peekTitle ? <div className="app-list-peek__title">{opts.peekTitle}</div> : null}
            {sections.map((section) => (
                <div key={section.value} className="app-list-peek__section">
                    {opts.showGroups ? (
                        <div className="app-list-peek__group">
                            <span className="truncate">{section.label || '—'}</span>
                            <span className="tabular-nums">{section.count}</span>
                        </div>
                    ) : null}
                    {section.rows.map((row, ri) => {
                        const text = opts.peekTextKey ? walkPath(row, opts.peekTextKey) : null;
                        return (
                            <div key={ri} className="app-list-peek__row">
                                {opts.peekTitleKey ? (
                                    <span className="app-list-peek__row-title truncate">
                                        {displayValue(walkPath(row, opts.peekTitleKey))}
                                    </span>
                                ) : null}
                                {text != null && text !== '' ? (
                                    <span className="app-list-peek__row-text truncate">{displayValue(text)}</span>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ))}
            {moreText ? <div className="app-list-peek__more">{moreText}</div> : null}
        </div>
    );
}

export default function AppList({ node }) {
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const {
        titleKey = 'title', subtitleKey = null, metaKey = null,
        timestampKey = null, badgeKey = null, badgeToneMap = [], unreadKey = null,
        badgePlacement = 'meta', selectedWhen = null, selectedDetailKey = null,
        groupKey = null, groupOrder = [], groupLabelMap = [],
        icon = null, emptyText = 'Nothing to show yet.',
    } = node.props || {};
    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(node.props?.source, { actionState, dataState, scope }),
    );

    // ── Peek ────────────────────────────────────────────────────────────────
    // Read before the early returns below, because hooks must be. A list with
    // no peekSource resolves to undefined here and every branch below is inert.
    const {
        peekMatchKey = null, peekRowKey = null, peekTitleKey = null, peekTextKey = null,
        peekGroupKey = null, peekGroupLabelMap = [], peekCountKey = null,
        peekLimit = 6, peekTitle = null, peekMoreText = null, peekBadge = false,
    } = node.props || {};
    const { value: peekRows } = resolveBinding(node.props?.peekSource, { actionState, dataState, scope });
    const peekIndex = useMemo(
        () => buildPeekIndex(peekRows, {
            matchKey: peekMatchKey,
            countKey: peekCountKey,
            groupKey: peekGroupKey,
            groupLabelMap: peekGroupLabelMap,
        }),
        [peekRows, peekMatchKey, peekCountKey, peekGroupKey, peekGroupLabelMap],
    );
    // { index, top, left, maxHeight } — one panel at a time, positioned in
    // viewport coordinates. The list is its own scroll region (see the <ul>
    // below), and an absolutely positioned panel inside a scroll container is
    // clipped by it; fixed coordinates are what let the panel reach out over
    // the pane beside it.
    const [openPeek, setOpenPeek] = useState(null);
    const showPeek = useCallback((index, anchor) => {
        if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
        const rect = anchor.getBoundingClientRect();
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        // Open to the right of the row where there is room, and flip to its
        // left where there is not — a rail on the right edge of a narrow window
        // would otherwise push the panel off the screen it is meant to explain.
        const left = vw - rect.right >= PEEK_WIDTH + 16
            ? rect.right + 8
            : Math.max(8, rect.left - PEEK_WIDTH - 8);
        const top = Math.max(8, Math.min(rect.top, vh - 120));
        setOpenPeek({ index, top, left, maxHeight: Math.max(120, vh - top - 16) });
    }, []);
    const hidePeek = useCallback(() => setOpenPeek(null), []);

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={3} />;

    const items = (Array.isArray(source) ? source : []).filter((row) => row && typeof row === 'object');
    if (items.length === 0) return <EmptyText art="empty-inbox" title="Nothing here yet" text={emptyText} />;

    const size = node.style?.size || 'md';
    const clickable = mode === 'run' && node.onRowClick;

    // Look pass (spec: list.look = rows | cards | tiles). 'rows' — and any
    // value this build does not know — is the identity path: the exact class
    // strings and style objects from before the look existed, so stored
    // definitions render byte-identically.
    const look = node.props?.look === 'cards' || node.props?.look === 'tiles' ? node.props.look : 'rows';

    const fillCls = isFill(node) ? ' app-fill h-full min-h-0 overflow-y-auto' : '';
    let listCls = `flex flex-col gap-2${fillCls}`;
    let listStyle;
    if (look === 'cards') {
        // Elevated cards want more air between them than flat rows do.
        listCls = `flex flex-col gap-3${fillCls}`;
    } else if (look === 'tiles') {
        // The tiles arrange INSIDE the component: the outer 12-col grid is
        // untouched, the <ul> becomes its own responsive tile grid.
        listCls = `grid gap-2.5${fillCls}`;
        listStyle = { gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' };
    }

    // 'meta' (identity) keeps the badge on the third line; 'subtitle' moves it
    // to the right of the subtitle line.
    const badgeInMeta = badgePlacement !== 'subtitle';

    // One row. Extracted so the flat and grouped branches below share it —
    // `i` stays the row's index in the source array, so selectedWhen's `index`
    // and the row keys are identical whether or not the list is grouped.
    const renderRow = (item, i) => {
        const subtitle = subtitleKey ? walkPath(item, subtitleKey) : null;
        const meta = metaKey ? walkPath(item, metaKey) : null;
        const stamp = timestampKey ? relativeTime(walkPath(item, timestampKey)) : null;
        const badge = badgeKey ? walkPath(item, badgeKey) : null;
        const unread = unreadKey ? Boolean(walkPath(item, unreadKey)) : false;
        const toneHit = badge != null
            ? (Array.isArray(badgeToneMap) ? badgeToneMap : []).find((m) => m && String(m.value) === String(badge))
            : null;

        // Which row is OPEN. An inbox that cannot show you which conversation
        // you are reading is broken — a formula per row (`item` in scope) is
        // the only shape that works, because the answer lives in a variable the
        // row has to be compared against.
        const selected = selectedWhen
            ? !!tryEvaluate(String(selectedWhen), { ...scope, item, index: i }).value
            : false;
        const detail = selected && selectedDetailKey ? walkPath(item, selectedDetailKey) : null;

        // What is behind this row. `undefined` for every list without a peek,
        // and for every row whose join value matches nothing.
        const peekEntry = peekMatchKey
            ? peekIndex.get(peekKey(walkPath(item, peekRowKey || peekMatchKey)))
            : undefined;
        const hasPeek = !!(peekEntry && peekEntry.count);
        // The count only takes over the badge when the author asked for it, so
        // a peek can be added to an existing list for the panel alone.
        const badgeLabel = peekBadge && hasPeek
            ? peekBadgeLabel(peekEntry, toneHit?.label ?? badge)
            : (toneHit?.label ?? badge);
        // A row whose own status says "fine" can still have records waiting on
        // it, and that count in green reads as a contradiction. The group that
        // names the badge may recolour it; without a tone the row keeps its own.
        const badgeTone = (peekBadge && hasPeek ? peekBadgeTone(peekEntry) : null) || toneHit?.tone;

        const badgeEl = badge != null && badge !== '' ? (
            <span
                className="inline-flex items-center px-1.5 py-0.5 text-[11px] rounded"
                style={{ ...badgeStyle(badgeTone), borderRadius: 'var(--app-radius)' }}
                data-app-list-badge={badgeTone || 'neutral'}
                data-app-list-peek={hasPeek ? 'true' : undefined}
                // Hover lands on the BADGE rather than the whole row: the panel
                // explains the number, and a popup that opens every time the
                // pointer crosses a row on its way somewhere else is a flicker,
                // not an aid. Keyboard users get it from the row's own focus.
                onMouseEnter={hasPeek ? (e) => showPeek(i, e.currentTarget) : undefined}
                onMouseLeave={hasPeek ? hidePeek : undefined}
            >
                {displayValue(badgeLabel)}
            </span>
        ) : null;

        const peekPanel = hasPeek && openPeek && openPeek.index === i
            ? renderPeekPanel(peekEntry, openPeek, {
                peekTitle, peekTitleKey, peekTextKey, peekLimit, peekMoreText, showGroups: !!peekGroupKey,
            })
            : null;

        const body = (
            <>
                {icon ? (
                    <span
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0"
                        style={{ background: 'var(--app-primary-soft)', color: 'var(--app-primary)' }}
                    >
                        <AppIcon name={icon} className="w-3.5 h-3.5" />
                    </span>
                ) : null}
                {unread ? (
                    <span
                        className="h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: 'var(--app-primary)' }}
                        aria-label="Unread"
                        data-app-list-unread="true"
                    />
                ) : null}
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                        <span
                            className={`${size === 'sm' ? 'text-xs' : 'text-sm'} truncate ${unread ? 'font-semibold' : 'font-medium'}`}
                        >
                            {displayValue(walkPath(item, titleKey))}
                        </span>
                        {stamp ? (
                            <span className="ml-auto shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                {stamp}
                            </span>
                        ) : null}
                    </div>
                    {badgeInMeta ? (
                        subtitle != null && subtitle !== '' ? (
                            <div className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                                {displayValue(subtitle)}
                            </div>
                        ) : null
                    ) : (subtitle != null && subtitle !== '') || badgeEl ? (
                        <div className="flex items-baseline gap-2">
                            {subtitle != null && subtitle !== '' ? (
                                <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                                    {displayValue(subtitle)}
                                </span>
                            ) : null}
                            {badgeEl ? <span className="ml-auto shrink-0">{badgeEl}</span> : null}
                        </div>
                    ) : null}
                    {badgeInMeta ? (
                        (meta != null && meta !== '') || badge != null ? (
                            <div className="mt-1 flex items-center gap-1.5">
                                {badgeEl}
                                {meta != null && meta !== '' ? (
                                    <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                                        {displayValue(meta)}
                                    </span>
                                ) : null}
                            </div>
                        ) : null
                    ) : meta != null && meta !== '' ? (
                        <div className="mt-1 flex items-center gap-1.5">
                            <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                                {displayValue(meta)}
                            </span>
                        </div>
                    ) : null}
                    {detail != null && detail !== '' ? (
                        <div className="mt-1 text-xs truncate" style={{ color: 'var(--app-primary)' }} data-app-list-detail="true">
                            {displayValue(detail)}
                        </div>
                    ) : null}
                </div>
            </>
        );

        let cls = `flex items-center gap-2.5 border w-full text-left ${size === 'sm' ? 'px-2.5 py-1.5' : 'px-3 py-2'}`;
        let style = {
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

        return (
            <li key={i} data-app-list-row={i} data-app-list-selected={selected || undefined}>
                {clickable ? (
                    <button
                        type="button"
                        // Hover was missing entirely, so a clickable row looked
                        // exactly like a static one.
                        className={`${cls} cursor-pointer transition-colors hover:brightness-[1.06]`}
                        style={style}
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => runAction(node.onRowClick, { formValues: item, item })}
                        onFocus={hasPeek ? (e) => showPeek(i, e.currentTarget) : undefined}
                        onBlur={hasPeek ? hidePeek : undefined}
                    >
                        {body}
                    </button>
                ) : (
                    <div className={cls} style={style}>{body}</div>
                )}
                {peekPanel}
            </li>
        );
    };

    // Grouping (spec: list.groupKey/groupOrder/groupLabelMap). Without a
    // groupKey the children are exactly today's flat rows. With one, an
    // uppercase section header precedes each group; empty values stay ungrouped
    // and first (the file_gallery precedent), groupOrder fixes the order and
    // any value not in it follows in first-seen order.
    let children;
    if (!groupKey) {
        children = items.map((item, i) => renderRow(item, i));
    } else {
        const labelMap = new Map(
            (Array.isArray(groupLabelMap) ? groupLabelMap : [])
                .filter((m) => m && m.value != null)
                .map((m) => [String(m.value), m.label]),
        );
        const order = (Array.isArray(groupOrder) ? groupOrder : []).map((v) => String(v));
        const loose = [];
        const groups = new Map();
        items.forEach((item, i) => {
            const raw = walkPath(item, groupKey);
            const name = typeof raw === 'string' ? raw.trim() : (raw == null ? '' : String(raw));
            if (!name) { loose.push([item, i]); return; }
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push([item, i]);
        });
        const ordered = [
            ...order.filter((n) => groups.has(n)),
            ...[...groups.keys()].filter((n) => !order.includes(n)),
        ];
        children = [];
        loose.forEach(([item, i]) => children.push(renderRow(item, i)));
        ordered.forEach((name) => {
            const entries = groups.get(name);
            const mapped = labelMap.get(name);
            const label = mapped != null && mapped !== '' ? mapped : name;
            children.push(
                <li
                    key={`grp-${name}`}
                    className="flex items-baseline gap-1 uppercase font-semibold px-1 pt-1 first:pt-0"
                    style={{ fontSize: '11px', letterSpacing: '0.03em', color: 'var(--text-muted)', gridColumn: '1 / -1' }}
                    data-app-list-group={name}
                    aria-hidden="true"
                >
                    <span className="truncate" title={label}>{label}</span>
                    <span className="tabular-nums font-normal">{`· ${entries.length}`}</span>
                </li>,
            );
            entries.forEach(([item, i]) => children.push(renderRow(item, i)));
        });
    }

    // A fill list IS the scroll region — it is the sidebar of an inbox, and a
    // hundred rows must not push the pane. Without this the list overflowed and
    // was silently clipped by the pane's overflow-hidden, which is how the
    // support desk shipped with an unscrollable ticket list.
    return (
        <ul
            className={listCls}
            style={listStyle}
            data-app-list="true"
            data-app-list-look={look === 'rows' ? undefined : look}
        >
            {children}
        </ul>
    );
}
