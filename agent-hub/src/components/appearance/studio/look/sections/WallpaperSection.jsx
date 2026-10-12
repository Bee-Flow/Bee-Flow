import { Upload, Trash2, Loader2, Image as ImageIcon, AlertCircle } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import { API_BASE } from '../../../../../utils/helpers';
import WallpaperPresets from '../../../WallpaperPresets';
import Slider from '../../../../shared/Slider';
import { toast } from '../../../../shared/Toast';
import useConfirm from '../../../../shared/useConfirm';
import { useTheme } from '../../../ThemeContext';
import { SECTION_IDS } from '../useLookForm';
import { useTranslation } from '../../../../../hooks/useTranslation';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * WallpaperSection — image uploader, overlay slider, and mood (wallpaper-preset)
 * picker, merged from the old standalone Wallpaper tab. Wallpaper image is
 * applied across every preset (not glass-only) thanks to the index.css change
 * that moved the gate to [data-wallpaper-on="image"].
 *
 * Mood presets only matter for Glass themes but we still show them under flat
 * presets so admins can pre-pick a mood before switching back to Glass.
 */
export default function WallpaperSection({ form, setForm, saving }) {
    const { t } = useTranslation();
    const theme = useTheme();
    const fileRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [dragging, setDragging] = useState(false);
    const { confirm, confirmDialog } = useConfirm();

    const handleUpload = useCallback(async (file) => {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            toast.error('Only image files are supported.');
            return;
        }
        if (file.size > MAX_BYTES) {
            toast.error('Image is larger than 5 MB.');
            return;
        }
        setUploading(true);
        try {
            await theme.uploadWallpaper(file);
            toast.success('Wallpaper uploaded');
        } catch (e) {
            toast.error(e?.message || 'Upload failed');
        } finally {
            setUploading(false);
        }
    }, [theme]);

    const handleDelete = useCallback(async () => {
        if (!(await confirm({ title: 'Remove the current wallpaper?', confirmLabel: 'Remove', destructive: true }))) return;
        try {
            await theme.deleteWallpaper();
            toast.success('Wallpaper removed');
        } catch (e) {
            toast.error(e?.message || 'Delete failed');
        }
    }, [theme, confirm]);

    const onDrop = (e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) handleUpload(file);
    };

    const wallpaperFullUrl = theme.wallpaperUrl
        ? (theme.wallpaperUrl.startsWith('http') ? theme.wallpaperUrl : `${API_BASE}${theme.wallpaperUrl}`)
        : null;

    return (
        <section
            id={SECTION_IDS.wallpaper}
            aria-labelledby={`${SECTION_IDS.wallpaper}-heading`}
            className="space-y-5"
        >
            <header>
                <h3
                    id={`${SECTION_IDS.wallpaper}-heading`}
                    className="text-base font-semibold mb-1"
                    style={{ color: 'var(--text-primary)' }}
                >
                    {t('appearance.wallpaper_wallpaper', 'Wallpaper')}
                </h3>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('appearance.wallpaper_optional_photo_background_plus_a', 'Optional photo background, plus a curated mood palette. The image renders behind every preset, not just Glass.')}
                </p>
            </header>

            {wallpaperFullUrl ? (
                <div
                    className="rounded-xl border overflow-hidden"
                    style={{ borderColor: 'var(--border-default)' }}
                >
                    <div className="relative aspect-[16/9]" style={{ background: 'var(--bg-secondary)' }}>
                        <img
                            src={wallpaperFullUrl}
                            alt={t('appearance.wallpaper_current_wallpaper', 'Current wallpaper')}
                            className="absolute inset-0 w-full h-full object-cover"
                        />
                    </div>
                    <div
                        className="p-3 flex items-center justify-between gap-3"
                        style={{ background: 'var(--bg-card)' }}
                    >
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {t('appearance.wallpaper_active_across_every_theme', 'Active across every theme.')}
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => fileRef.current?.click()}
                                disabled={uploading || saving}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium border inline-flex items-center gap-1.5 disabled:opacity-50 hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                            >
                                <Upload className="w-3.5 h-3.5" /> {t('appearance.wallpaper_replace', 'Replace')}
                            </button>
                            <button
                                type="button"
                                onClick={handleDelete}
                                disabled={uploading || saving}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium border inline-flex items-center gap-1.5 disabled:opacity-50"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
                            >
                                <Trash2 className="w-3.5 h-3.5" /> {t('appearance.wallpaper_remove', 'Remove')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    onDragEnter={() => setDragging(true)}
                    onDragLeave={() => setDragging(false)}
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDrop={onDrop}
                    disabled={uploading || saving}
                    className="w-full rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 py-10 px-6 transition-colors"
                    style={{
                        borderColor: dragging ? 'var(--accent-primary)' : 'var(--border-default)',
                        background: dragging ? 'var(--bg-card-hover)' : 'var(--bg-card)',
                        color: 'var(--text-muted)',
                    }}
                >
                    {uploading ? <Loader2 className="w-6 h-6 animate-spin" /> : <ImageIcon className="w-7 h-7" />}
                    <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {t('appearance.wallpaper_drop_an_image_or_click_to_choose', 'Drop an image, or click to choose')}
                    </div>
                    <div className="text-[11px]">{t('appearance.wallpaper_jpg_png_or_webp_up_to_5_mb', 'JPG, PNG, or WebP — up to 5 MB')}</div>
                </button>
            )}
            <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleUpload(e.target.files?.[0])}
            />

            <Slider
                label="Overlay opacity"
                hint="Lighten busy photos so glass surfaces stay readable."
                value={form.wallpaperOverlay ?? 0.1}
                onChange={(v) => setForm((f) => ({ ...f, wallpaperOverlay: v }))}
                min={0}
                max={0.6}
                step={0.02}
                valueFormatter={(v) => `${Math.round(v * 100)}%`}
                disabled={saving}
            />

            <div>
                <div className="flex items-center gap-2 mb-3">
                    <h4 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('appearance.wallpaper_mood', 'Mood')}
                    </h4>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {t('appearance.wallpaper_curated_colour_backdrop_for_glass', '— curated colour backdrop for Glass surfaces')}
                    </span>
                </div>
                <WallpaperPresets
                    value={form.wallpaperPreset}
                    onChange={(id) => setForm((f) => ({ ...f, wallpaperPreset: id }))}
                    disabled={saving}
                />
                {!wallpaperFullUrl && !form.preset.startsWith('glass') && (
                    <p
                        className="text-[11px] mt-3 px-3 py-2 rounded-lg inline-flex items-center gap-2"
                        style={{ background: 'rgba(245,158,11,0.08)', color: 'var(--warning, #f59e0b)' }}
                    >
                        <AlertCircle className="w-3.5 h-3.5" />
                        {t('appearance.wallpaper_moods_only_show_under_glass_themes', 'Moods only show under Glass themes. Pick one anyway — it activates when you switch.')}
                    </p>
                )}
            </div>
            {confirmDialog}
        </section>
    );
}
