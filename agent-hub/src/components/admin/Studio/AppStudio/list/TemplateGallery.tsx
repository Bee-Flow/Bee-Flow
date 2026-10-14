import { Download, Loader2, Sparkles, Trash2, Users } from 'lucide-react';
import React from 'react';
import AppIcon from './appIcon';
import { accentTile, CARD_STYLE } from './cardStyle';
import type { StudioTemplate } from './types';
import useTranslation from '../../../../../hooks/useTranslation';

// ── Template gallery (inside the New-app modal) ─────────────────────

interface TemplateGalleryProps {
    templates: StudioTemplate[] | null;
    loading: boolean;
    error: string | null;
    creatingId: string | null;
    remixingId: string | null;
    deletingId: string | null;
    exportingId: string | null;
    onPick: (tpl: StudioTemplate) => void;
    onRemix: (tpl: StudioTemplate) => void;
    onDelete: (tpl: StudioTemplate) => void;
    onExport?: (tpl: StudioTemplate) => void;
    onRetry: () => void;
}

function TemplateGallery({ templates, loading, error, creatingId, remixingId, deletingId, exportingId, onPick, onRemix, onDelete, onExport, onRetry }: TemplateGalleryProps) {
    const { t } = useTranslation();
    if (loading) {
        return (
            <div className="flex items-center justify-center py-10" role="status" aria-label={t('studio_apps_bi.list.loading_templates', 'Loading templates')}>
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--accent-primary)' }} />
            </div>
        );
    }
    if (error) {
        return (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{error}</div>
                <button
                    type="button"
                    onClick={onRetry}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white/5 hover:bg-[var(--bg-card-hover)]"
                    style={{ color: 'var(--text-primary)' }}
                >
                    {t('studio_apps_bi.list.try_again', 'Try again')}
                </button>
            </div>
        );
    }
    if (!templates || templates.length === 0) {
        return (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {t('studio_apps_bi.list.no_templates', 'No templates available yet.')}
            </div>
        );
    }
    // A busy op anywhere in the gallery locks every card (one create at a time).
    const anyBusy = !!creatingId || !!remixingId;
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {templates.map((tpl) => {
                const picking = creatingId === tpl.id;
                const remixing = remixingId === tpl.id;
                return (
                    <div
                        key={tpl.id}
                        className="rounded-xl border overflow-hidden transition-all hover:shadow-md"
                        style={CARD_STYLE}
                    >
                        {/* Primary action: use the template as-is (create + open). */}
                        <button
                            type="button"
                            onClick={() => onPick(tpl)}
                            disabled={anyBusy}
                            aria-busy={picking}
                            className="w-full p-3 text-left disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            <div className="flex items-start gap-2.5">
                                <span
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
                                    style={accentTile(null)}
                                >
                                    {picking
                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                        : <AppIcon name={tpl.icon || 'LayoutGrid'} className="w-4 h-4" />}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                            {tpl.title}
                                        </span>
                                        {tpl.category ? (
                                            <span
                                                className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0 bg-white/5"
                                                style={{ color: 'var(--text-secondary)' }}
                                            >
                                                {tpl.category}
                                            </span>
                                        ) : null}
                                        {/* Provenance, not decoration: a template made
                                            from one of your own apps carries your
                                            organisation's data model and possibly its
                                            vocabulary rows. Worth knowing before you
                                            build on it. */}
                                        {tpl.source === 'captured' ? (
                                            <span
                                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0"
                                                style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary)' }}
                                                title={(tpl.version ?? 0) > 1
                                                    ? t('studio_apps_bi.list.own_title_version', 'Made from one of your own apps — version {version}', { version: tpl.version })
                                                    : t('studio_apps_bi.list.own_title', 'Made from one of your own apps')}
                                            >
                                                <Users className="w-2.5 h-2.5" />
                                                {t('studio_apps_bi.list.own', 'Own')}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                                        {tpl.description}
                                    </div>
                                </div>
                            </div>
                        </button>
                        {/* Secondary action: create from the template, then open the
                            editor with the AI builder ready to adapt it (remix). */}
                        <div
                            className="flex items-center justify-between gap-2 px-3 pb-2.5 -mt-1 border-t pt-2"
                            style={{ borderColor: 'var(--border-subtle)' }}
                        >
                            <div className="flex items-center gap-1">
                                {/* Only a captured template can be removed — the
                                    built-in gallery is code. */}
                                {tpl.source === 'captured' ? (
                                    <button
                                        type="button"
                                        onClick={() => onDelete(tpl)}
                                        disabled={anyBusy || deletingId === tpl.id}
                                        aria-busy={deletingId === tpl.id}
                                        title={t('studio_apps_bi.list.delete_template_title', 'Delete this custom template')}
                                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60 disabled:cursor-not-allowed"
                                        style={{ color: 'var(--text-tertiary)' }}
                                    >
                                        {deletingId === tpl.id
                                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            : <Trash2 className="w-3.5 h-3.5" />}
                                        {t('studio_apps_bi.list.delete', 'Delete')}
                                    </button>
                                ) : null}
                                {/* Every template exports, built-in included: the
                                    starters are the most useful thing to hand
                                    somebody who is setting up a second
                                    installation, and they carry nothing private. */}
                                {onExport ? (
                                    <button
                                        type="button"
                                        onClick={() => onExport(tpl)}
                                        disabled={anyBusy || exportingId === tpl.id}
                                        aria-busy={exportingId === tpl.id}
                                        title={t('app_studio.list.export_title', 'Download this template as a file')}
                                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60 disabled:cursor-not-allowed text-[var(--text-tertiary)]"
                                        data-testid={`app-template-export-${tpl.id}`}
                                    >
                                        {exportingId === tpl.id
                                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            : <Download className="w-3.5 h-3.5" />}
                                        {t('app_studio.list.export', 'Export')}
                                    </button>
                                ) : null}
                            </div>
                            <button
                                type="button"
                                onClick={() => onRemix(tpl)}
                                disabled={anyBusy}
                                aria-busy={remixing}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60 disabled:cursor-not-allowed"
                                style={{ color: 'var(--accent-primary)' }}
                            >
                                {remixing
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <Sparkles className="w-3.5 h-3.5" />}
                                {t('studio_apps_bi.list.remix', 'Remix with AI')}
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export default TemplateGallery;
