import React, { useMemo, useState } from 'react';
import LookPreviewIframe from './LookPreviewIframe';
import LookPreviewToolbar from './LookPreviewToolbar';
import { PREVIEW_SURFACES } from './previewSurfaces';
import { useTranslation } from '@/hooks/useTranslation';
import type { DraftPayload } from '../useLookForm';
import type { PreviewSurface } from './previewSurfaces';

interface Props {
    draftPayload: DraftPayload | null;
}

/**
 * Right-rail preview chrome. Wraps the iframe in a soft rounded card so the
 * preview reads as "your app inside a frame" rather than "broken layout".
 *
 *   draftPayload — theme payload sent to the iframe (form + saved wallpaper)
 */
export default function LookPreview({ draftPayload }: Props) {
    const { t } = useTranslation();
    const [activeId, setActiveId] = useState(PREVIEW_SURFACES[0].id);
    const [reloadCount, setReloadCount] = useState(0);
    const surface = useMemo(
        () => PREVIEW_SURFACES.find((s: PreviewSurface) => s.id === activeId) || PREVIEW_SURFACES[0],
        [activeId],
    );

    const liveUrl = `${surface.path}${surface.extraQuery ? `?${surface.extraQuery.slice(1)}` : ''}`;

    return (
        <aside
            className="h-full flex flex-col p-4 gap-3 bg-[var(--bg-primary)]"
            aria-label={t('appearance.look_preview_live_theme_preview', 'Live theme preview')}
        >
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                        {t('appearance.look_preview_live_preview', 'Live preview')}
                    </h3>
                    <p className="text-[11px] mt-0.5 text-[var(--text-muted)]">
                        {t('appearance.look_preview_real_app_signed_in_as_you_clicks_hit', 'Real app, signed in as you. Clicks hit the backend.')}
                    </p>
                </div>
                <span
                    className="inline-flex items-center gap-1 text-[10px] uppercase font-semibold tracking-wider px-2 py-1 rounded-full [background:color-mix(in_srgb,var(--accent-primary)_12%,transparent)] [color:var(--accent-primary)]!"
                >
                    <span
                        className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)]"
                    />
                    {t('appearance.look_preview_live', 'Live')}
                </span>
            </div>

            <div
                className="flex-1 min-h-0 rounded-xl border overflow-hidden flex flex-col [border-color:var(--border-default)] [background:var(--bg-card)]"
                data-surface="opaque"
            >
                <LookPreviewToolbar
                    activeId={activeId}
                    onChange={setActiveId}
                    onReload={() => setReloadCount((n: number) => n + 1)
}
                    surfaceUrl={liveUrl}
                />
                <div className="flex-1 min-h-0">
                    <LookPreviewIframe
                        key={`${surface.id}:${reloadCount}`}
                        surface={surface}
                        draftPayload={draftPayload}
                    />
                </div>
            </div>
        </aside>
    );
}
