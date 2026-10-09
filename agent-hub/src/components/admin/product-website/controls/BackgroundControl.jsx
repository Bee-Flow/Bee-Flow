import React, { useState } from 'react';
import { FieldRow, ImageField } from '../fields';
import ColorControl from './ColorControl';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * BackgroundControl — the Style tab's background area as one card with
 * three zones:
 *
 *   (a) Image   — the shared ImageField (upload + URL/asset-key input +
 *                 thumbnail), wiring unchanged from BlockStyleEditor.
 *   (b) Overlay — ONE ColorControl row with allowAlpha; it composes the
 *                 rgba() string via colorUtils (replacing the old separate
 *                 color input + raw-string field + opacity slider). A
 *                 collapsed "Advanced" reveal exposes the raw CSS string
 *                 for power users.
 *   (c) Band    — placeholder zone, see below. NOT wired yet.
 *
 * Storage unchanged: style.backgroundImage (URL or cms/ asset key) and
 * style.backgroundOverlay (single CSS color string, canonically rgba()).
 *
 * Props:
 *   image           — style.backgroundImage value ('' when unset)
 *   overlay         — style.backgroundOverlay value ('' when unset)
 *   onChangeImage   — (urlOrKey | '')  — caller nulls empty
 *   onChangeOverlay — (rgbaString | null)
 */
export default function BackgroundControl({ image, overlay, onChangeImage, onChangeOverlay }) {
    const { t } = useTranslation();
    const [showAdvanced, setShowAdvanced] = useState(false);

    return (
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
            {/* (a) Image — existing ImageField wiring, behavior unchanged. */}
            <ImageField
                label={t('cms_site.site.controls.bg_image', 'Image')}
                value={image}
                onChange={onChangeImage}
                placeholder={t('cms_site.site.controls.bg_image_placeholder', 'https://… or cms/file.jpg')}
            />

            {/* (b) Overlay — only relevant once an image is set. */}
            {image ? (
                <>
                    <ColorControl
                        label={t('cms_site.site.controls.bg_overlay', 'Overlay')}
                        hint={t('cms_site.site.controls.bg_overlay_hint', 'Tints the image so foreground text stays readable.')}
                        value={overlay || ''}
                        onChange={onChangeOverlay}
                        allowAlpha
                    />
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => setShowAdvanced(v => !v)}
                            aria-expanded={showAdvanced}
                            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] flex items-center gap-1"
                        >
                            <span
                                className="inline-block transition-transform"
                                style={{ transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)' }}
                                aria-hidden="true"
                            >▸</span>
                            {t('cms_site.site.controls.bg_advanced', 'Advanced')}
                        </button>
                        {overlay ? (
                            <button
                                type="button"
                                onClick={() => onChangeOverlay(null)}
                                className="text-[10px] text-[var(--text-muted)] hover:text-red-400"
                            >
                                {t('cms_site.site.controls.bg_remove_overlay', 'Remove overlay')}
                            </button>
                        ) : null}
                    </div>
                    {showAdvanced ? (
                        <div className="mt-2">
                            <FieldRow
                                label={t('cms_site.site.controls.bg_raw', 'Raw overlay value')}
                                hint={t('cms_site.site.controls.bg_raw_hint', 'The exact CSS color string stored on the block.')}
                            >
                                <input
                                    type="text"
                                    value={overlay || ''}
                                    onChange={(e) => onChangeOverlay(e.target.value || null)}
                                    placeholder="rgba(0,0,0,0.5)"
                                    spellCheck={false}
                                    className="w-full px-2 py-1.5 rounded text-xs font-mono border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                                />
                            </FieldRow>
                        </div>
                    ) : null}
                </>
            ) : null}

            {/*
              (c) Band variants — RESERVED SLOT, deliberately not wired yet.
              WS1-P5 lands renderer support for `style.band`
              (default|surface|tint|dark|primary); the swatch row (painted
              from the site's design colors) mounts here in WS3 once that
              ships. Do not remove this marker.
            */}
        </div>
    );
}
