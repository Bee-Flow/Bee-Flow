import React from 'react';
import AppIcon from './appIcon';
import { accentTile, CARD_CLASSES, CARD_STYLE } from './cardStyle';
import type { StudioApp } from './types';
import useTranslation from '@/hooks/useTranslation';

/**
 * What an app card in the gallery shows: icon, name, description and the small
 * status row (published, storage, template update, last edit), plus the
 * skeleton grid that stands in for the cards while they load.
 */

function formatUpdated(iso?: string | null): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function PublishedBadge() {
    const { t } = useTranslation();
    return (
        <span
            className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold [background:rgba(16,185,129,0.12)] [color:#059669]!"
        >
            {t('studio_apps_bi.list.published', 'Published')}
        </span>
    );
}

// Amber "Storage NN%" pill for owner cards whose per-app SQLite DB is above 80%
// of the cap — an unobtrusive nudge to prune/split before writes start 409ing.
// dbRatio (0–1) is computed server-side (GET /mine), so no cap constant here.
const STORAGE_PILL_THRESHOLD = 0.8;

function StoragePill({ ratio }: { ratio?: number }) {
    const { t } = useTranslation();
    if (typeof ratio !== 'number' || !(ratio > STORAGE_PILL_THRESHOLD)) return null;
    const pct = Math.min(100, Math.round(ratio * 100));
    return (
        <span
            className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold [background:rgba(245,158,11,0.14)] [color:#b45309]!"
            title={t('studio_apps_bi.list.storage_title', 'Storage {pct}% of the app\'s database limit', { pct })}
        >
            {t('studio_apps_bi.list.storage', 'Storage {pct}%', { pct })}
        </span>
    );
}

// Small "Update beschikbaar" pill-button on OWNER cards whose source template
// carries a newer registry version while the app is still untouched since
// install. templateUpgrade { available, fromVersion, toVersion } is computed
// server-side on GET /mine (registry version newer + install-hash pristine),
// so this renders purely on that flag. stopPropagation on click AND keydown —
// the whole card is itself a click/Enter target that opens the editor.
interface CardBodyProps {
    app: StudioApp;
    onUpgrade?: (app: StudioApp) => void;
}

function TemplateUpdatePill({ app, onUpgrade }: CardBodyProps) {
    const { t } = useTranslation();
    if (!app.templateUpgrade?.available || !onUpgrade) return null;
    const { fromVersion, toVersion } = app.templateUpgrade;
    return (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUpgrade(app); }}
            onKeyDown={(e) => e.stopPropagation()}
            className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold transition-opacity hover:opacity-80 [background:rgba(59,130,246,0.12)] [color:#2563eb]!"
            title={t('studio_apps_bi.list.update_title', 'New template version available (v{from} → v{to})', { from: fromVersion, to: toVersion })}
        >
            {t('studio_apps_bi.list.update_available', 'Update available')}
        </button>
    );
}

function CardBody({ app, onUpgrade }: CardBodyProps) {
    const { t } = useTranslation();
    return (
        <>
            <div className="flex items-start gap-2.5 mb-2">
                <span
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg shrink-0"
                    style={accentTile(app.accentColor)}
                >
                    <AppIcon name={app.icon || 'LayoutGrid'} className="w-4.5 h-4.5" />
                </span>
                <div className="flex-1 min-w-0 pt-0.5">
                    <div className="text-sm font-semibold truncate text-[var(--text-primary)]">
                        {app.name}
                    </div>
                    {app.description ? (
                        <div className="text-xs mt-0.5 line-clamp-2 text-[var(--text-secondary)]">
                            {app.description}
                        </div>
                    ) : null}
                </div>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
                {app.isPublished ? <PublishedBadge /> : null}
                <StoragePill ratio={app.usage?.dbRatio} />
                <TemplateUpdatePill app={app} onUpgrade={onUpgrade} />
                {formatUpdated(app.updatedAt) ? <span>{t('studio_apps_bi.list.updated', 'Updated {date}', { date: formatUpdated(app.updatedAt) })}</span> : null}
            </div>
        </>
    );
}

function SkeletonGrid() {
    const { t } = useTranslation();
    return (
        <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
            role="status"
            aria-label={t('studio_apps_bi.list.loading_apps', 'Loading apps')}
        >
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`${CARD_CLASSES} animate-pulse`} style={CARD_STYLE}>
                    <div className="flex items-start gap-2.5 mb-3">
                        <div className="h-9 w-9 rounded-lg bg-[var(--bg-secondary)]" />
                        <div className="flex-1 pt-0.5">
                            <div className="h-3.5 w-2/3 rounded mb-2 bg-[var(--bg-secondary)]" />
                            <div className="h-2.5 w-full rounded bg-[var(--bg-secondary)]" />
                        </div>
                    </div>
                    <div className="h-2.5 w-1/3 rounded bg-[var(--bg-secondary)]" />
                </div>
            ))}
            <span className="sr-only">{t('studio_apps_bi.list.loading', 'Loading…')}</span>
        </div>
    );
}

export { CardBody, SkeletonGrid };
