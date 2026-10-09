import React from 'react';
import { TextField, ImageField } from '../fields';
import { InlineHint, CollapsibleCard, FieldSelect, MonoTextarea, BackgroundCard } from '../primitives';
import { ClipFields } from './ClipFields';
import { set, SectionHeaderFields } from './shared';
import VariantPicker from './VariantPicker';
import { useTranslation } from '../../../../hooks/useTranslation';

// One FramedMedia slot editor — shared media shape
// { src, srcDark, alt, frame, kind }. Used for `media` and (in the pair
// layout) `mediaSecondary`.
function MediaSlotFields({ media = {}, onChange }) {
    const { t } = useTranslation();
    const update = (key, value) => onChange({ ...media, [key]: value });
    const isVideo = media.kind === 'video';
    const isClip = media.kind === 'clip';
    return (
        <>
            <FieldSelect
                label={t('cms_site.blocks.showcase.media_type', 'Media type')}
                value={isVideo ? 'video' : (isClip ? 'clip' : 'image')}
                options={[
                    { value: 'image', label: t('cms_site.blocks.showcase.kind_image', 'Image') },
                    { value: 'video', label: t('cms_site.blocks.showcase.kind_video', 'Video loop (no audio)') },
                    { value: 'clip',  label: t('cms_site.blocks.showcase.kind_clip', 'Clip (video with sound)') },
                ]}
                onChange={v => update('kind', v)}
            />
            {isClip ? (
                <ClipFields value={media} onPatch={patch => onChange({ ...media, ...patch })} />
            ) : isVideo ? (
                <ImageField
                    label={t('cms_site.blocks.showcase.video', 'Video')}
                    value={media.src || ''}
                    onChange={v => update('src', v)}
                    accept="video/mp4,video/webm"
                    previewKind="video"
                    uploadLabel={t('cms_site.blocks.showcase.upload_video', 'Upload video')}
                    placeholder="https://… or /api/cms/asset/cms/…"
                />
            ) : (
                <>
                    <ImageField
                        label={t('cms_site.blocks.showcase.image', 'Image')}
                        value={media.src || ''}
                        onChange={v => update('src', v)}
                    />
                    <ImageField
                        label={t('cms_site.blocks.showcase.dark_theme_image_optional', 'Dark-theme image (optional)')}
                        value={media.srcDark || ''}
                        onChange={v => update('srcDark', v)}
                    />
                    <TextField
                        label={t('cms_site.blocks.showcase.alt_text', 'Alt text')}
                        value={media.alt || ''}
                        onChange={v => update('alt', v)}
                        placeholder={t('cms_site.blocks.showcase.describe_the_screenshot', 'Describe the screenshot')}
                    />
                </>
            )}
            <FieldSelect
                label={t('cms_site.blocks.showcase.frame', 'Frame')}
                value={['hairline', 'browser', 'none'].includes(media.frame) ? media.frame : 'browser'}
                options={[
                    { value: 'browser',  label: t('cms_site.blocks.showcase.frame_browser', 'Browser window') },
                    { value: 'hairline', label: t('cms_site.blocks.showcase.frame_hairline', 'Hairline frame') },
                    { value: 'none',     label: t('cms_site.blocks.showcase.frame_none', 'None') },
                ]}
                onChange={v => update('frame', v)}
            />
        </>
    );
}

// ── Showcase ──────────────────────────────────────────────────────────
//
// Staged product proof. 'single' = one full-container framed shot with
// glow + fade-mask; 'pair' = two frames side by side; 'code-ui' = mono
// code panel + frame (5/7, deliberately no syntax highlighting).

export function ShowcaseEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const variant = ['pair', 'code-ui'].includes(data.variant) ? data.variant : 'single';
    const code = data.code || {};
    const updateCode = (key, value) => onChange(set(data, 'code', { ...code, [key]: value }));
    return (
        <>
            <VariantPicker
                type="showcase"
                value={data.variant}
                onChange={v => onChange(set(data, 'variant', v))}
            />
            <InlineHint>
                {t('cms_site.blocks.showcase.a_real_product_screenshot_is_the_whole', 'A real product screenshot is the whole point of this block — a light/dark pair keeps it sharp in both themes.')}
                {variant === 'code-ui' ? ' ' + t('cms_site.blocks.showcase.the_code_snippet_is_never_auto_translated', 'The code snippet is never auto-translated.') : ''}
            </InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="showcase" />
            <CollapsibleCard title={variant === 'pair' ? t('cms_site.blocks.showcase.media_left', 'Media (left)') : t('cms_site.blocks.showcase.media', 'Media')} defaultOpen={true} persistKey="blk.showcase.media">
                <MediaSlotFields
                    media={data.media}
                    onChange={v => onChange(set(data, 'media', v))}
                />
            </CollapsibleCard>
            {variant === 'pair' ? (
                <CollapsibleCard title={t('cms_site.blocks.showcase.media_right', 'Media (right)')} defaultOpen={true} persistKey="blk.showcase.media2">
                    <MediaSlotFields
                        media={data.mediaSecondary}
                        onChange={v => onChange(set(data, 'mediaSecondary', v))}
                    />
                </CollapsibleCard>
            ) : null}
            {variant === 'code-ui' ? (
                <CollapsibleCard title={t('cms_site.blocks.showcase.code_panel', 'Code panel')} defaultOpen={true} persistKey="blk.showcase.code">
                    <TextField
                        label={t('cms_site.blocks.showcase.language_label', 'Language label')}
                        value={code.language || ''}
                        onChange={v => updateCode('language', v)}
                        placeholder="bash"
                    />
                    <MonoTextarea
                        rows={5}
                        value={code.snippet || ''}
                        onChange={v => updateCode('snippet', v)}
                        placeholder="docker compose up -d"
                        ariaLabel={t('cms_site.blocks.showcase.code_snippet', 'Code snippet')}
                    />
                </CollapsibleCard>
            ) : null}
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.showcase.background" />
        </>
    );
}
