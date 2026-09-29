import { Building2, Copy, Globe, Loader2, Lock, Pencil, Table, Trash2, Users, Workflow } from 'lucide-react';
import React from 'react';
import { visibilityOf } from './webpageVisibility';
import { kindColorVar, kindTint } from '../../components/shared/kindColors';
import { audienceLabel, GROUPS, ORG, PERSONAL } from '../../components/shared/VisibilityCapsule';
import { formatRelativeTime } from '../../utils/dateFormatters';
import { API_BASE } from '../../utils/helpers';

/**
 * One card on the Webpages overview (artboard 1a, plan W1): a 150px preview
 * of the real page, the visibility capsule over its top-right corner, then
 * name · when · tagline and the pills that say what this page is wired to.
 *
 * The capsule's four states (three shared + the derived "Public") come from
 * `webpageVisibility.visibilityOf`, so the editor's capsule cannot disagree
 * with the card's.
 */

const MODE_ICON = { [PERSONAL]: Lock, [ORG]: Building2, [GROUPS]: Users };
const MAX_PILLS = 3;

/** The badge over the preview: a live public share first, then the audience. */
function VisibilityBadge({ webpage, t }) {
    const { isPublic, mode } = visibilityOf(webpage);
    const Icon = isPublic ? Globe : MODE_ICON[mode];
    const label = isPublic
        ? t('webpages.visibility.public', 'Public')
        : audienceLabel(t, mode, webpage.sharedGroups, null);
    return (
        <span
            data-testid="webpage-card-visibility"
            data-mode={isPublic ? 'public' : mode}
            className="absolute inline-flex items-center gap-1 text-[10px] font-semibold"
            style={{
                right: 12, top: 12,
                padding: '2px 7px',
                borderRadius: 999,
                background: 'var(--bg-card)',
                border: `1px solid ${isPublic ? kindColorVar('webpage') : 'var(--border-default)'}`,
                color: isPublic ? kindColorVar('webpage') : 'var(--text-secondary)',
            }}
        >
            <Icon size={10} aria-hidden="true" />
            {label}
        </span>
    );
}

/** What this page is wired to — `bridge_grants`, the only link that exists. */
function LinkPills({ webpage }) {
    const grants = webpage.bridgeGrants || {};
    const items = [
        // `tables` lands in W3; reading it here means the pill appears the day
        // the normalizer stops dropping the slice, with no change to this file.
        ...(Array.isArray(grants.tables) ? grants.tables : []).map(x => ({
            key: `t:${x.datatableId}`, kind: 'datatable', label: x.label || x.name || x.datatableId,
        })),
        ...(Array.isArray(grants.automations) ? grants.automations : []).map(x => ({
            key: `a:${x.automationId}`, kind: 'automation', label: x.label || x.automationId,
        })),
    ];
    if (!items.length) return null;
    const shown = items.slice(0, MAX_PILLS);
    const rest = items.length - shown.length;
    return (
        <div className="flex flex-wrap gap-1 text-[11px]" data-testid="webpage-card-links">
            {shown.map(item => {
                const Icon = item.kind === 'automation' ? Workflow : Table;
                return (
                    <span
                        key={item.key}
                        className="inline-flex items-center gap-1 font-semibold max-w-full"
                        style={{
                            padding: '1px 7px',
                            borderRadius: 999,
                            background: kindTint(item.kind, 14),
                            color: kindColorVar(item.kind),
                        }}
                    >
                        <Icon size={10} aria-hidden="true" className="shrink-0" />
                        <span className="truncate">{item.label}</span>
                    </span>
                );
            })}
            {rest > 0 && (
                <span
                    className="inline-flex items-center"
                    style={{ padding: '1px 7px', borderRadius: 999, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
                >
                    +{rest}
                </span>
            )}
        </div>
    );
}

/** The 150px preview: the rendered thumbnail, or the page's emoji on a tint. */
function Preview({ webpage }) {
    const thumbnailUrl = webpage.thumbnailSha
        // Cache-bust on the sha so a fresh thumbnail replaces a stale one
        // without ever serving long-lived stale bytes.
        ? `${API_BASE}/api/webpages/${webpage.id}/thumbnail?v=${webpage.thumbnailSha}`
        : null;
    return (
        <div
            className="relative shrink-0 overflow-hidden"
            style={{ height: 150, background: 'var(--bg-secondary)', padding: '12px 14px 0' }}
        >
            {/* The mock browser page the artboard draws: a sheet that runs off
                the bottom edge, so the card reads as a page and not a photo. */}
            <div
                className="h-full overflow-hidden grid place-items-center"
                style={{
                    borderRadius: '8px 8px 0 0',
                    background: thumbnailUrl ? 'var(--bg-card)' : kindTint('webpage', 12),
                    boxShadow: 'var(--shadow-sm)',
                }}
            >
                {thumbnailUrl ? (
                    <img
                        src={thumbnailUrl}
                        alt=""
                        className="w-full h-full object-cover object-top"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                ) : (
                    <span className="text-4xl select-none" aria-hidden="true">{webpage.icon || '🌐'}</span>
                )}
            </div>
        </div>
    );
}

/**
 * Props
 *   webpage      a list row
 *   dimmed       another card's open is in flight
 *   opening      THIS card's open is in flight
 *   renaming / renameValue / on…  the in-card rename editor (owned by the list)
 *   onOpen / onEdit / onClone / onDelete
 */
export default function WebpageCard({
    webpage,
    dimmed = false,
    opening = false,
    renaming = false,
    renameValue = '',
    onRenameValueChange,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onOpen,
    onEdit,
    onClone,
    onDelete,
    t,
}) {
    const activate = () => { if (!dimmed && !opening) onOpen?.(webpage.id); };

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={activate}
            onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
            }}
            aria-busy={opening}
            data-testid="webpage-card"
            className="group flex flex-col overflow-hidden text-left cursor-pointer transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            style={{
                borderRadius: 12,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-sm)',
                opacity: dimmed && !opening ? 0.6 : 1,
            }}
        >
            <div className="relative">
                <Preview webpage={webpage} />
                <VisibilityBadge webpage={webpage} t={t} />
                {/* Row actions sit top-LEFT: the capsule owns the other corner. */}
                <div className="absolute left-3 top-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <CardAction title={t('webpages.card.edit', 'Edit in IDE')} onClick={() => onEdit?.(webpage.id)}>
                        <Pencil size={12} />
                    </CardAction>
                    <CardAction title={t('webpages.card.duplicate', 'Duplicate')} onClick={() => onClone?.(webpage.id)}>
                        <Copy size={12} />
                    </CardAction>
                    <CardAction title={t('webpages.card.delete', 'Delete')} onClick={() => onDelete?.(webpage.id)} danger>
                        <Trash2 size={12} />
                    </CardAction>
                </div>
                {opening && (
                    <div
                        className="absolute inset-0 z-10 grid place-items-center"
                        style={{ background: 'color-mix(in srgb, var(--bg-card) 70%, transparent)' }}
                        role="status"
                        aria-live="polite"
                    >
                        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                        <span className="sr-only">{t('webpages.card.opening', 'Opening…')}</span>
                    </div>
                )}
            </div>

            <div className="flex flex-col gap-1.5" style={{ padding: '12px 14px' }}>
                <div className="flex items-center gap-2">
                    {renaming ? (
                        <input
                            value={renameValue}
                            onChange={(e) => onRenameValueChange?.(e.target.value)}
                            onBlur={() => onCommitRename?.(webpage.id)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') onCommitRename?.(webpage.id);
                                if (e.key === 'Escape') onCancelRename?.();
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                            aria-label={t('webpages.card.rename', 'Rename')}
                            className="flex-1 min-w-0 px-1 py-0.5 text-[13px] font-semibold rounded outline-none"
                            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--accent-primary)' }}
                        />
                    ) : (
                        <span
                            className="font-semibold truncate text-[13px]"
                            style={{ color: 'var(--text-primary)' }}
                            onDoubleClick={(e) => { e.stopPropagation(); onStartRename?.(webpage); }}
                            title={t('webpages.card.rename_hint', 'Double-click to rename')}
                        >
                            {webpage.name}
                        </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {formatRelativeTime(webpage.updatedAt)}
                    </span>
                </div>
                {webpage.tagline && (
                    <div className="text-[12px] leading-[17px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                        {webpage.tagline}
                    </div>
                )}
                <LinkPills webpage={webpage} />
            </div>
        </div>
    );
}

function CardAction({ title, onClick, danger = false, children }) {
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            className="grid place-items-center w-6 h-6 rounded-md transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-default)',
                color: danger ? 'var(--error)' : 'var(--text-secondary)',
            }}
        >
            {children}
        </button>
    );
}
