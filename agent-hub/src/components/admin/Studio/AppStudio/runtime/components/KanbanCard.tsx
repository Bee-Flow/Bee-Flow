import { useDraggable, useDroppable } from '@dnd-kit/core';
import { walkPath } from '../resolveBinding';
import { ROLE_COLORS } from '../styleResolver.constants';
import { displayValue } from '../uiBits';
import type React from 'react';
import type { CardFieldProps, CardBodyProps, KanbanCardProps } from './AppKanban.types';

export const CARD_PREFIX = 'appkanban-card:';

function CardField({ field, row }: CardFieldProps) {
    const raw = walkPath(row, field.key);
    if (raw == null || raw === '') return null;
    let text = displayValue(raw);
    if (field.format === 'number') {
        const n = Number(raw);
        if (Number.isFinite(n)) text = String(n);
    } else if (field.format === 'date') {
        const d = new Date(raw as string | number);
        if (!Number.isNaN(d.getTime())) text = d.toLocaleDateString();
    }
    const title = field.label ? `${field.label}: ${text}` : String(text);
    if (field.slot === 'chip') {
        return (
            <span
                className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums [background:var(--app-primary-soft,var(--bg-tertiary))] [color:var(--text-primary)]!"
                title={title}
                data-app-kanban-field={field.key}
            >
                <span className="sr-only">{field.label ? `${field.label}: ` : ''}</span>
                {text}
            </span>
        );
    }
    return (
        <span
            className="inline-flex items-center text-[11px] truncate max-w-[10rem] text-[var(--text-secondary)]"
            title={title}
            data-app-kanban-field={field.key}
        >
            <span className="sr-only">{field.label ? `${field.label}: ` : ''}</span>
            {text}
        </span>
    );
}

export function CardBody({ row, titleKey, subtitleKey, badgeKey, badgeToneMap, cardFields }: CardBodyProps) {
    const subtitle = subtitleKey ? walkPath(row, subtitleKey) : null;
    const badge = badgeKey ? walkPath(row, badgeKey) : null;
    const toneHit = badge != null && badge !== ''
        ? (Array.isArray(badgeToneMap) ? badgeToneMap : []).find((m) => m && String(m.value) === String(badge))
        : null;
    const dot = toneHit ? (ROLE_COLORS[toneHit.tone] || ROLE_COLORS.neutral) : null;
    const fields = Array.isArray(cardFields) ? cardFields.filter((f) => f && f.key) : [];

    return (
        <>
            <div className="flex items-start gap-1.5">
                <div className="text-sm font-medium break-words min-w-0 flex-1 text-[var(--text-primary)]">
                    {displayValue(walkPath(row, titleKey))}
                </div>
                {dot ? (
                    <span
                        className="h-2.5 w-2.5 rounded-full shrink-0 mt-1"
                        style={{ background: dot }}
                        title={toneHit?.label || String(badge)}
                        data-app-kanban-dot={toneHit?.tone || 'neutral'}
                    >
                        <span className="sr-only">{toneHit?.label || String(badge)}</span>
                    </span>
                ) : null}
            </div>
            {subtitle != null && subtitle !== '' ? (
                <div className="text-xs mt-0.5 break-words text-[var(--text-secondary)]">
                    {displayValue(subtitle)}
                </div>
            ) : null}
            {badge != null && badge !== '' && !toneHit ? (
                <span
                    className="inline-flex items-center rounded-full px-1.5 py-0.5 mt-1.5 text-[11px] font-medium [background:var(--bg-tertiary)] [color:var(--text-secondary)]!"
                >
                    {displayValue(badge)}
                </span>
            ) : null}
            {fields.length ? (
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    {fields.map((f) => <CardField key={f.key} field={f} row={row} />)}
                </div>
            ) : null}
        </>
    );
}

export function KanbanCard({
    row, index, titleKey, subtitleKey, badgeKey, badgeToneMap, cardFields,
    accent, dragEnabled, clickable, onClick, cardLook,
}: KanbanCardProps) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `${CARD_PREFIX}${index}`,
        data: { row },
        disabled: !dragEnabled,
    });
    // A card is a drop target as well as a drag source: without that, a drop
    // could only say WHICH column, never WHERE in it, and a rank-ordered
    // backlog is exactly "where in it".
    const { setNodeRef: setDropRef, isOver } = useDroppable({
        id: `${CARD_PREFIX}${index}`,
        data: { row, cardIndex: index },
        disabled: !dragEnabled,
    });

    const ref = (el: HTMLElement | null) => { setNodeRef(el); setDropRef(el); };

    // Look pass (spec: kanban.cardLook = default | tinted | raised). 'default'
    // — and any unknown value — is the identity path: the exact style object
    // from before the look existed. This styles EVERY card the same way;
    // colorKey/cardColorMap keep coloring individual cards BY DATA (the
    // `accent` edge survives in every look).
    const look = cardLook === 'tinted' || cardLook === 'raised' ? cardLook : 'default';
    let surface: React.CSSProperties = {
        background: 'var(--bg-card)',
        borderColor: isOver && !isDragging ? 'var(--app-primary)' : 'var(--border-default)',
        borderRadius: 'var(--app-radius)',
    };
    if (look === 'tinted') {
        // Soft wash from the card's own accent when it has one, the primary
        // tint otherwise; text stays var(--text-primary) via CardBody, which
        // keeps it readable on the wash in both host themes.
        surface = {
            background: accent
                ? `color-mix(in srgb, ${accent} 10%, var(--bg-card))`
                : 'var(--app-primary-soft)',
            borderColor: isOver && !isDragging ? 'var(--app-primary)' : 'transparent',
            borderRadius: 'var(--app-radius)',
        };
    } else if (look === 'raised') {
        // Semantic elevation (--app-shadow-2 degrades to a ring in high
        // contrast) replaces the hairline; slightly larger radius.
        surface = {
            background: 'var(--bg-card)',
            borderColor: isOver && !isDragging ? 'var(--app-primary)' : 'transparent',
            borderRadius: 'calc(var(--app-radius) * 1.25)',
            boxShadow: 'var(--app-shadow-2)',
        };
    }

    return (
        <div
            ref={ref}
            {...attributes}
            {...listeners}
            data-app-kanban-card={index}
            data-app-kanban-cardlook={look === 'default' ? undefined : look}
            data-app-kanban-cardover={isOver && !isDragging ? 'true' : undefined}
            onClick={clickable ? onClick : undefined}
            // dnd-kit's attributes already announce this as a button with a tab
            // stop, so a keyboard user lands here and nothing happens: Enter
            // neither opens the card nor starts a drag. Opening it is the one
            // that matters, and it is one handler.
            onKeyDown={clickable ? (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onClick?.();
            } : undefined}
            className={`border px-2.5 py-2 select-none app-focusable ${clickable ? 'cursor-pointer' : dragEnabled ? 'cursor-grab' : ''}`}
            // The card does NOT follow the pointer itself: it lives inside the
            // column's overflow-y-auto, so a transform beyond the lane edge is
            // clipped and the drag looks dead. The DragOverlay carries the
            // moving copy; the original stays put, dimmed to show its slot.
            style={{
                ...surface,
                borderLeft: accent ? `3px solid ${accent}` : undefined,
                opacity: isDragging ? 0.4 : 1,
                touchAction: 'none',
            }}
        >
            <CardBody
                row={row}
                titleKey={titleKey}
                subtitleKey={subtitleKey}
                badgeKey={badgeKey}
                badgeToneMap={badgeToneMap}
                cardFields={cardFields}
            />
        </div>
    );
}
