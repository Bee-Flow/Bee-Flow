import React, { useEffect, useEffectEvent } from 'react';
import { Loader2, X, Pencil, Globe } from 'lucide-react';
import { useWebpageBundleQuery } from '../../api/queries/webpagesPanels';
import WebpagePreview from '../../pages/webpages/WebpagePreview';
import { useTranslation } from '../../hooks/useTranslation';
import type { ExtraFileMeta, PrimaryContent, WebpageRow } from '../../api/webpageEditorTypes';
import type { PreviewSelection } from '../../pages/webpages/preview/usePreviewToken';
import { errorMessage } from '../../utils/caughtError';

interface SideWebpagePanelProps {
    webpageId: string;
    onClose: () => void;
    user?: { id?: string } | null;
    onLoaded?: (webpage: WebpageRow | null) => void;
    onFilesLoaded?: (files: (PrimaryContent & { extraFiles: ExtraFileMeta[] }) | null) => void;
    onSelectionAttach?: (selection: PreviewSelection) => void;
    reloadKey?: number;
    onNavigate?: (page: string) => void;
}

/**
 * Read-only webpage view for the right-hand chat slot. Fetches the webpage
 * once and reuses WebpagePreview for the sandboxed iframe body. Editing
 * lives in Studio › Webpages — the pencil here jumps there.
 */
export default function SideWebpagePanel({
    webpageId,
    onClose,
    user,
    onLoaded,         // (webpage) — metadata-only, fires once on load
    onFilesLoaded,    // ({ html, css, js, extraFiles }) — content snapshot
    onSelectionAttach, // (selection) — user highlighted text in the preview
    reloadKey = 0,    // bump to force a refetch (e.g. after AI edits)
    onNavigate,       // (page) — same shape as App.jsx's navigateToPage
}: SideWebpagePanelProps) {
    const { t } = useTranslation();
    const bundle = useWebpageBundleQuery(webpageId, reloadKey);
    // Tell the parent about each answer once. useEffectEvent reads the latest callbacks without making
    // them dependencies: parents pass inline arrows, and listing them would re-fire on every render.
    const announce = useEffectEvent(() => {
        if (bundle.isError) {
            if (typeof onLoaded === 'function') onLoaded(null);
            if (typeof onFilesLoaded === 'function') onFilesLoaded(null);
            return;
        }
        const data = bundle.data;
        if (typeof onLoaded === 'function' && data?.webpage) onLoaded(data.webpage);
        if (typeof onFilesLoaded === 'function') {
            onFilesLoaded({
                html: data?.files?.html || '',
                css: data?.files?.css || '',
                js: data?.files?.js || '',
                extraFiles: Array.isArray(data?.extraFiles) ? data.extraFiles : [],
            });
        }
    });
    useEffect(() => {
        if (bundle.isSuccess || bundle.isError) announce();
    }, [bundle.isSuccess, bundle.isError, bundle.dataUpdatedAt, bundle.errorUpdatedAt]);
    const state = {
        loading: bundle.isPending,
        error: bundle.isError ? errorMessage(bundle.error) : null,
        data: bundle.data ?? null,
    };

    const openInEditor = () => {
        if (typeof onNavigate === 'function') {
            onNavigate(`studio/webpages/${webpageId}`);
            return;
        }
        // Defensive fallback — route through the app shell rather than a
        // synthetic popstate. The new URL still triggers App's popstate
        // listener via the browser navigation it implies.
        window.location.assign(`/app/studio/webpages/${webpageId}`);
    };

    const wp = state.data?.webpage;
    const files = state.data?.files || {};
    const isOwner = wp && user?.id && wp.userId === user.id;

    return (
        <div className="flex flex-col h-full bg-[var(--bg-primary)]">
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)]">
                <Globe className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
                <span className="text-sm font-semibold truncate flex-1 text-[var(--text-primary)]">
                    {wp?.name || (state.loading ? 'Loading…' : 'Webpage')}
                </span>
                {isOwner && (
                    <button
                        onClick={openInEditor}
                        title={t('webpages.side_panel.open_in_editor', 'Open in editor')}
                        className="p-1 rounded hover:bg-[var(--bg-secondary)]"
                    >
                        <Pencil className="w-4 h-4 text-[var(--text-secondary)]" />
                    </button>
                )}
                <button
                    onClick={onClose}
                    title={t('common.close', 'Close')}
                    className="p-1 rounded hover:bg-[var(--bg-secondary)]"
                >
                    <X className="w-4 h-4 text-[var(--text-secondary)]" />
                </button>
            </div>

            <div className="flex-1 min-h-0">
                {state.loading && (
                    <div className="h-full flex items-center justify-center">
                        <Loader2 className="w-5 h-5 animate-spin text-[var(--accent-primary)]" />
                    </div>
                )}
                {state.error && (
                    <div className="h-full flex flex-col items-center justify-center text-center px-6">
                        <Globe className="w-8 h-8 mb-3 text-[var(--text-tertiary)]" />
                        <div className="text-sm font-semibold mb-1 text-[var(--text-primary)]">
                            {t('webpages.side_panel.unavailable', 'Webpage unavailable')}
                        </div>
                        <div className="text-xs text-[var(--text-tertiary)]">{state.error}</div>
                    </div>
                )}
                {!state.loading && !state.error && wp && (
                    <WebpagePreview
                        webpageId={wp.id}
                        html={files.html || ''}
                        css={files.css || ''}
                        js={files.js || ''}
                        extraFiles={state.data?.extraFiles || []}
                        extraContents={{}}
                        onSelectionAttach={onSelectionAttach}
                    />
                )}
            </div>
        </div>
    );
}
