import { tryEvaluate } from '@shared/expr/engine.mjs';
import { useCallback, useMemo, useState } from 'react';
import type React from 'react';
import useTranslation from '@/hooks/useTranslation';
import { buildPeekIndex, peekBadgeLabel, peekBadgeTone, peekKey, type PeekGroupLabel, type PeekRow } from '../listPeek';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill } from '../styleResolver.helpers';
import { EmptyText, ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';
import type { BindingInput } from '../resolveBinding.types';
import type { NodeProps } from './appNode.types';
import type { ListProps } from './AppList.types';
import { relativeTime, renderPeekPanel } from './AppList.helpers';
import { ListBadge, ListRowBody, groupRows, listLook, peekPosition, rowLook } from './AppListRow';

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

export default function AppList({ node }: NodeProps<ListProps>) {
    const { t } = useTranslation();
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const {
        titleKey = 'title', subtitleKey = null, metaKey = null,
        timestampKey = null, badgeKey = null, badgeToneMap = [], unreadKey = null,
        badgePlacement = 'meta', selectedWhen = null, selectedDetailKey = null,
        groupKey = null, groupOrder = [], groupLabelMap = [],
        icon = null, emptyText = t('studio_apps_runtime.ui.nothing_to_show', 'Nothing to show yet.'),
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
        () => buildPeekIndex(peekRows as PeekRow[] | null | undefined, {
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
    const [openPeek, setOpenPeek] = useState<{ index: number; top: number; left: number; maxHeight: number } | null>(null);
    const showPeek = useCallback((index: number, anchor: (EventTarget & HTMLSpanElement) | (EventTarget & HTMLButtonElement)) => {
        if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
        setOpenPeek({ index, ...peekPosition(anchor.getBoundingClientRect(), window.innerWidth || 0, window.innerHeight || 0) });
    }, []);
    const hidePeek = useCallback(() => setOpenPeek(null), []);
    if (error) return <ErrorText error={error} errorCode={errorCode} />;
    if (isLoading) return <SkeletonLines lines={3} />;
    const items = (Array.isArray(source) ? source : []).filter((row) => row && typeof row === 'object');
    if (items.length === 0) return <EmptyText art="empty-inbox" title={t('studio_apps_runtime.grid.nothing_here', 'Nothing here yet')} text={emptyText} />;
    const size = node.style?.size || 'md';
    const clickable = mode === 'run' && node.onRowClick;

    // Look pass (spec: list.look = rows | cards | tiles). 'rows' — and any
    // value this build does not know — is the identity path: the exact class
    // strings and style objects from before the look existed, so stored
    // definitions render byte-identically.
    const look = node.props?.look === 'cards' || node.props?.look === 'tiles' ? node.props.look : 'rows';
    const fillCls = isFill(node) ? ' app-fill h-full min-h-0 overflow-y-auto' : '';
    const { listCls, listStyle } = listLook(look, fillCls);

    // 'meta' (identity) keeps the badge on the third line; 'subtitle' moves it
    // to the right of the subtitle line.
    const badgeInMeta = badgePlacement !== 'subtitle';

    // One row. Extracted so the flat and grouped branches below share it —
    // `i` stays the row's index in the source array, so selectedWhen's `index`
    // and the row keys are identical whether or not the list is grouped.
    const renderRow = (item: PeekRow, i: number) => {
        const subtitle = subtitleKey ? walkPath(item, subtitleKey) : null;
        const meta = metaKey ? walkPath(item, metaKey) : null;
        const stamp = timestampKey ? relativeTime(walkPath(item, timestampKey), t) : null;
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
            ? peekBadgeLabel(peekEntry, (toneHit?.label ?? badge) as string | null | undefined)
            : (toneHit?.label ?? badge);
        // A row whose own status says "fine" can still have records waiting on
        // it, and that count in green reads as a contradiction. The group that
        // names the badge may recolour it; without a tone the row keeps its own.
        const badgeTone = (peekBadge && hasPeek ? peekBadgeTone(peekEntry) : null) || toneHit?.tone;

        const badgeEl = badge != null && badge !== '' ? (
            <ListBadge label={badgeLabel} tone={badgeTone} hasPeek={hasPeek} onShow={(e) => showPeek(i, e.currentTarget)} onHide={hidePeek} />
        ) : null;

        const peekPanel = hasPeek && openPeek && openPeek.index === i
            ? renderPeekPanel(peekEntry, openPeek, {
                peekTitle, peekTitleKey, peekTextKey, peekLimit, peekMoreText, showGroups: !!peekGroupKey, t,
            })
            : null;

        const body = (
            <ListRowBody
                t={t} icon={icon} unread={unread} size={size} title={walkPath(item, titleKey)} stamp={stamp}
                badgeInMeta={badgeInMeta} subtitle={subtitle} meta={meta} badge={badge} badgeEl={badgeEl} detail={detail}
            />
        );

        const { cls, style } = rowLook(look, size, selected);

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
                        onClick={() => runAction(node.onRowClick as string, { formValues: item, item })}
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
    let children: React.ReactNode[];
    if (!groupKey) {
        children = items.map((item, i) => renderRow(item, i));
    } else {
        const { loose, sections } = groupRows(items, groupKey, groupOrder, groupLabelMap);
        children = [];
        loose.forEach(([item, i]) => children.push(renderRow(item, i)));
        sections.forEach(({ name, label, entries }) => {
            children.push(
                <li
                    key={`grp-${name}`}
                    className="flex items-baseline gap-1 uppercase font-semibold px-1 pt-1 first:pt-0 [font-size:11px] [letter-spacing:0.03em] [color:var(--text-muted)] [grid-column:1_/_-1]"
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
