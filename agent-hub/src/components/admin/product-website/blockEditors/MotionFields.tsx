import { ImageField, TextField, Toggle } from '../fields';
import { CollapsibleCard, FieldSelect, InlineHint } from '../primitives';
import { useTranslation } from '@/hooks/useTranslation';
import { DEFAULT_CAPTIONS_LANG } from './ClipFields';

// ── Motion and rich media (issue 244) ─────────────────────────────────
//
// Editor cards shared by Hero, CTA Banner and Media + Text. Each edits one
// sub-object of the block content (`backgroundVideo`, `tour`) or one key of
// the media slot (`motion`); the renderers (marketing/motion/) ignore what is
// empty, so a block that never touches these cards renders as before.

export interface BackgroundVideoValue {
    src?: string;
    webmSrc?: string;
    poster?: string;
    fit?: string;
    position?: string;
    overlay?: string;
    overlayColor?: string;
    overlayOpacity?: number;
}

export interface TourValue {
    enabled?: boolean;
    src?: string;
    poster?: string;
    captionsSrc?: string;
    captionsLang?: string;
    label?: string;
    duration?: string;
    teaserSrc?: string;
    alt?: string;
}

interface CardProps<V> {
    value: V | undefined;
    onChange: (next: V) => void;
    persistKey: string;
}

const VIDEO_ACCEPT = 'video/mp4,video/webm';
const ASSET_PLACEHOLDER = 'https://… or /api/cms/asset/cms/…';

export function BackgroundVideoCard({ value, onChange, persistKey }: CardProps<BackgroundVideoValue>) {
    const { t } = useTranslation();
    const v = value || {};
    const patch = (next: BackgroundVideoValue) => onChange({ ...v, ...next });
    const overlay = v.overlay || 'dark';
    return (
        <CollapsibleCard title={t('cms_site.blocks.motion.background_video', 'Background video')} defaultOpen={false} persistKey={persistKey}>
            <InlineHint>{t('cms_site.blocks.motion.background_video_hint', 'A silent looping video behind the block. On phones, with reduced motion and with a data saver the poster image is shown instead, so always set a poster.')}</InlineHint>
            <ImageField
                label={t('cms_site.blocks.motion.video_mp4', 'Video (MP4)')}
                value={v.src || ''}
                onChange={(x: string) => patch({ src: x })}
                accept={VIDEO_ACCEPT}
                previewKind="video"
                uploadLabel={t('cms_site.blocks.motion.upload_video', 'Upload video')}
                placeholder={ASSET_PLACEHOLDER}
            />
            <ImageField
                label={t('cms_site.blocks.motion.video_webm', 'Video (WebM, optional)')}
                value={v.webmSrc || ''}
                onChange={(x: string) => patch({ webmSrc: x })}
                accept={VIDEO_ACCEPT}
                previewKind="video"
                uploadLabel={t('cms_site.blocks.motion.upload_video', 'Upload video')}
                placeholder={ASSET_PLACEHOLDER}
            />
            <ImageField
                label={t('cms_site.blocks.motion.poster', 'Poster image (static fallback)')}
                value={v.poster || ''}
                onChange={(x: string) => patch({ poster: x })}
                uploadLabel={t('cms_site.blocks.motion.upload_poster', 'Upload poster')}
            />
            <FieldSelect
                label={t('cms_site.blocks.motion.fit', 'Fit')}
                value={v.fit || 'cover'}
                options={[
                { value: 'cover', label: t('cms_site.blocks.motion.fit_cover', 'Cover (fill, crop the edges)') },
                { value: 'contain', label: t('cms_site.blocks.motion.fit_contain', 'Contain (whole video)') },
                ]}
                onChange={(x: string) => patch({ fit: x })}
            />
            <FieldSelect
                label={t('cms_site.blocks.motion.position', 'Focus')}
                value={v.position || 'center'}
                options={[
                { value: 'center', label: t('cms_site.blocks.motion.position_center', 'Centre') },
                { value: 'top', label: t('cms_site.blocks.motion.position_top', 'Top') },
                { value: 'bottom', label: t('cms_site.blocks.motion.position_bottom', 'Bottom') },
                ]}
                onChange={(x: string) => patch({ position: x })}
            />
            <FieldSelect
                label={t('cms_site.blocks.motion.overlay', 'Overlay for legibility')}
                value={overlay}
                options={[
                { value: 'dark', label: t('cms_site.blocks.motion.overlay_dark', 'Dark') },
                { value: 'light', label: t('cms_site.blocks.motion.overlay_light', 'Light (text turns dark)') },
                { value: 'gradient', label: t('cms_site.blocks.motion.overlay_gradient', 'Dark gradient (top and bottom)') },
                { value: 'custom', label: t('cms_site.blocks.motion.overlay_custom', 'Custom colour') },
                { value: 'none', label: t('cms_site.blocks.motion.overlay_none', 'None') },
                ]}
                onChange={(x: string) => patch({ overlay: x })}
            />
            {overlay === 'custom' ? (
                <TextField
                label={t('cms_site.blocks.motion.overlay_color', 'Overlay colour')}
                value={v.overlayColor || ''}
                onChange={(x: string) => patch({ overlayColor: x })}
                placeholder="#0b1020"
                />
            ) : null}
            {overlay !== 'none' ? (
                <TextField
                label={t('cms_site.blocks.motion.overlay_strength', 'Overlay strength (0–100)')}
                value={v.overlayOpacity === undefined ? '' : String(v.overlayOpacity)}
                onChange={(x: string) => {
                const n = Number.parseInt(x, 10);
                patch({ overlayOpacity: Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined });
                }}
                placeholder="45"
                />
            ) : null}
        </CollapsibleCard>
    );
}

export function TourCard({ value, onChange, persistKey }: CardProps<TourValue>) {
    const { t } = useTranslation();
    const v = value || {};
    const patch = (next: TourValue) => onChange({ ...v, ...next });
    return (
        <CollapsibleCard title={t('cms_site.blocks.motion.product_tour', 'Product tour')} defaultOpen={false} persistKey={persistKey}>
            <InlineHint>{t('cms_site.blocks.motion.product_tour_hint', 'A pill that opens the full video in a player with captions. The video never starts by itself and never plays with sound until the visitor presses play.')}</InlineHint>
            <Toggle
                label={t('cms_site.blocks.motion.tour_show', 'Show the tour button')}
                value={v.enabled !== false}
                onChange={(x: boolean) => patch({ enabled: x })}
            />
            <ImageField
                label={t('cms_site.blocks.motion.tour_video', 'Tour video (MP4 / WebM, with sound)')}
                value={v.src || ''}
                onChange={(x: string) => patch({ src: x })}
                accept={VIDEO_ACCEPT}
                previewKind="clip"
                uploadPath="upload-clip"
                uploadLabel={t('cms_site.blocks.motion.upload_video', 'Upload video')}
                placeholder={ASSET_PLACEHOLDER}
            />
            <ImageField
                label={t('cms_site.blocks.motion.tour_poster', 'Poster image (optional)')}
                value={v.poster || ''}
                onChange={(x: string) => patch({ poster: x })}
                uploadLabel={t('cms_site.blocks.motion.upload_poster', 'Upload poster')}
            />
            <ImageField
                label={t('cms_site.blocks.motion.tour_captions', 'Captions (optional, .vtt)')}
                value={v.captionsSrc || ''}
                onChange={(x: string) => patch({ captionsSrc: x, ...(x && !v.captionsLang ? { captionsLang: DEFAULT_CAPTIONS_LANG } : {}) })}
                accept=".vtt,text/vtt"
                previewKind="captions"
                uploadLabel={t('cms_site.blocks.motion.upload_captions', 'Upload captions')}
            />
            {v.captionsSrc ? (
                <TextField
                label={t('cms_site.blocks.motion.tour_captions_lang', 'Captions language')}
                value={v.captionsLang || DEFAULT_CAPTIONS_LANG}
                onChange={(x: string) => patch({ captionsLang: x.trim() })}
                />
            ) : null}
            <TextField
                label={t('cms_site.blocks.motion.tour_label', 'Button text')}
                value={v.label || ''}
                onChange={(x: string) => patch({ label: x })}
                placeholder={t('cms_site.blocks.motion.tour_label_placeholder', 'Watch product tour')}
            />
            <TextField
                label={t('cms_site.blocks.motion.tour_duration', 'Duration (shown after the text)')}
                value={v.duration || ''}
                onChange={(x: string) => patch({ duration: x })}
                placeholder={t('cms_site.blocks.motion.tour_duration_placeholder', '4 minutes')}
            />
            <ImageField
                label={t('cms_site.blocks.motion.teaser_loop', 'Teaser loop (short, silent, optional)')}
                value={v.teaserSrc || ''}
                onChange={(x: string) => patch({ teaserSrc: x })}
                accept={VIDEO_ACCEPT}
                previewKind="video"
                uploadLabel={t('cms_site.blocks.motion.upload_video', 'Upload video')}
                placeholder={ASSET_PLACEHOLDER}
            />
            <TextField
                label={t('cms_site.blocks.motion.tour_alt', 'Title for screen readers')}
                value={v.alt || ''}
                onChange={(x: string) => patch({ alt: x })}
            />
        </CollapsibleCard>
    );
}

export function MediaMotionSelect({ value, onChange }: { value: string | undefined; onChange: (next: string) => void }) {
    const { t } = useTranslation();
    return (
        <FieldSelect
            label={t('cms_site.blocks.motion.scroll_motion', 'Motion while scrolling')}
            value={value || ''}
            options={[
                { value: '', label: t('cms_site.blocks.motion.motion_none', 'None') },
                { value: 'parallax', label: t('cms_site.blocks.motion.motion_parallax', 'Parallax (image drifts inside its frame)') },
                { value: 'scale', label: t('cms_site.blocks.motion.motion_scale', 'Grow into view') },
            ]}
            onChange={onChange}
        />
    );
}
