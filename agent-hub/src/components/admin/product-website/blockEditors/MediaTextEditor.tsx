import React from 'react';
import { TextField, Toggle, ImageField, LinkField } from '../fields';
import {
    InlineHint,
    CollapsibleCard,
    StyleTriplet,
    FieldSelect,
    CtaStyleSelect,
    BackgroundCard,
} from '../primitives';
import { ClipFields } from './ClipFields';
import { TourCard, MediaMotionSelect } from './MotionFields';
import type { TourValue } from './MotionFields';
import type { CmsLink } from '../fields';
import type { StyleBlob } from '../primitives.types';
import type { BlockEditorWithPagesProps } from './editorProps';
import { set } from './shared';
import { TranslateParams, useTranslation } from '../../../../hooks/useTranslation';

// ── Media + Text ─────────────────────────────────────────────────────

type MediaSlot = {
    kind?: string;
    src?: string;
    srcDark?: string;
    alt?: string;
    frame?: string;
    poster?: string;
    captionsSrc?: string;
    captionsLang?: string;
    motion?: string;
};
type MediaTextCta = { label?: string; link?: CmsLink | null; style?: string };
type MediaTextData = {
    heading?: string;
    headingAlign?: string;
    /** `null` (or absent) while the subheading is switched off. */
    subheading?: string | null;
    subheadingAlign?: string;
    body?: string;
    bodyAlign?: string;
    align?: string;
    media?: MediaSlot;
    mediaPosition?: string;
    mediaSize?: string;
    cta?: MediaTextCta | null;
    headingStyle?: StyleBlob;
    subheadingStyle?: StyleBlob;
    bodyStyle?: StyleBlob;
    ctaStyle?: StyleBlob;
    tour?: TourValue;
};

export function MediaTextEditor({ data = {}, pages = [], onChange }: BlockEditorWithPagesProps<MediaTextData>) {
    const { t } = useTranslation();
    const setField = (key: string, value: unknown) => onChange(set(data, key, value));
    const media    = data.media || { kind: 'image', src: '', alt: '' };
    const cta      = data.cta || {};

    // Per-field style blobs — same `*Style.{fontFamily,fontSize,color}`
    // shape Hero uses (badgeStyle/titleStyle/leadStyle). Keeping the
    // storage shape stable means existing pages don't need migration and
    // the renderer's inlineTextStyle() reads keep working unchanged.
    const headingStyle    = data.headingStyle    || {};
    const subheadingStyle = data.subheadingStyle || {};
    const bodyStyle       = data.bodyStyle       || {};
    const ctaStyle        = data.ctaStyle        || {};

    const showSubheading = data.subheading !== null && data.subheading !== undefined;
    const showCta        = !!data.cta;

    const toggleSubheading = (next: boolean) => setField('subheading', next ? '' : null);
    const toggleCta        = (next: boolean) => setField('cta',
        next ? { label: 'Learn more', link: { kind: 'anchor', anchor: '' } } : null);

    const updateMedia = (key: string, value: unknown) => setField('media', { ...media, [key]: value });
    const updateCta   = (key: string, value: unknown) => setField('cta',   { ...cta, [key]: value });

    return (
        <>
            <InlineHint>{t('cms_site.blocks.media_text.click_the_heading_subheading_body_and', 'Click the heading, subheading, body, and CTA label in the preview to edit them inline. Use the panels below for structure and styling.')}</InlineHint>

            {/* ── Heading ─────────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.media_text.heading', 'Heading')} defaultOpen={true} persistKey="blk.media-text.heading">
                <TextField
                    label={t('cms_site.blocks.media_text.text', 'Text')}
                    value={data.heading || ''}
                    onChange={v => setField('heading', v)}
                    placeholder={t('cms_site.blocks.media_text.heading', 'Heading')}
                    align={data.headingAlign || data.align || 'left'}
                    onAlignChange={v => setField('headingAlign', v)}
                />
                <StyleTriplet
                    label={t('cms_site.blocks.media_text.heading', 'Heading')}
                    value={headingStyle}
                    onChange={v => setField('headingStyle', v)}
                    sample={data.heading || t('cms_site.blocks.media_text.heading_preview', 'Heading preview')}
                    weight={700}
                    min={12} max={96}
                />
            </CollapsibleCard>

            {/* ── Subheading ──────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.media_text.subheading', 'Subheading')} defaultOpen={false} persistKey="blk.media-text.subheading">
                <Toggle
                    label={t('cms_site.blocks.media_text.show_subheading', 'Show subheading')}
                    value={showSubheading}
                    onChange={toggleSubheading}
                />
                {showSubheading ? (
                    <>
                        <TextField
                            label={t('cms_site.blocks.media_text.text', 'Text')}
                            value={data.subheading || ''}
                            onChange={v => setField('subheading', v)}
                            placeholder={t('cms_site.blocks.media_text.subheading', 'Subheading')}
                            align={data.subheadingAlign || data.align || 'left'}
                            onAlignChange={v => setField('subheadingAlign', v)}
                        />
                        <StyleTriplet
                            label={t('cms_site.blocks.media_text.subheading', 'Subheading')}
                            value={subheadingStyle}
                            onChange={v => setField('subheadingStyle', v)}
                            sample={data.subheading || t('cms_site.blocks.media_text.subheading_preview', 'Subheading preview')}
                            weight={500}
                            min={10} max={48}
                        />
                    </>
                ) : null}
            </CollapsibleCard>

            {/* ── Body ────────────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.media_text.body', 'Body')} defaultOpen={false} persistKey="blk.media-text.body">
                <TextField
                    label={t('cms_site.blocks.media_text.text', 'Text')}
                    value={data.body || ''}
                    onChange={v => setField('body', v)}
                    placeholder={t('cms_site.blocks.media_text.body_text', 'Body text')}
                    align={data.bodyAlign || data.align || 'left'}
                    onAlignChange={v => setField('bodyAlign', v)}
                />
                <StyleTriplet
                    label={t('cms_site.blocks.media_text.body', 'Body')}
                    value={bodyStyle}
                    onChange={v => setField('bodyStyle', v)}
                    sample={data.body || 'The quick brown fox jumps over the lazy dog.'}
                    weight={400}
                    min={10} max={32}
                />
            </CollapsibleCard>

            {/* ── CTA ─────────────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.media_text.cta', 'CTA')} defaultOpen={false} persistKey="blk.media-text.cta">
                <Toggle
                    label={t('cms_site.blocks.media_text.show_cta', 'Show CTA')}
                    value={showCta}
                    onChange={toggleCta}
                />
                {showCta ? (
                    <>
                        <TextField
                            label={t('cms_site.blocks.media_text.label', 'Label')}
                            value={cta.label || ''}
                            onChange={v => updateCta('label', v)}
                            placeholder={t('cms_site.blocks.media_text.learn_more', 'Learn more')}
                        />
                        <LinkField
                            label={t('cms_site.blocks.media_text.destination', 'Destination')}
                            value={cta.link}
                            pages={pages}
                            onChange={v => updateCta('link', v)}
                        />
                        <CtaStyleSelect
                            value={cta.style || 'primary'}
                            onChange={v => updateCta('style', v)}
                        />
                        <StyleTriplet
                            label={t('cms_site.blocks.media_text.cta', 'CTA')}
                            value={ctaStyle}
                            onChange={v => setField('ctaStyle', v)}
                            sample={cta.label || t('cms_site.blocks.media_text.button_label_preview', 'Button label')}
                            weight={600}
                            min={10} max={32}
                        />
                    </>
                ) : null}
            </CollapsibleCard>

            {/* ── Media ───────────────────────────────────────────── */}
            <MediaTextEditorCollapsibleCard t={t} media={media} updateMedia={updateMedia} setField={setField} data={data} />

            <TourCard value={data.tour} onChange={v => setField('tour', v)} persistKey="blk.media-text.tour" />

            <BackgroundCard data={data} onChange={onChange} persistKey="blk.media-text.background" />
        </>
    );
}

function MediaTextEditorCollapsibleCard({ t, media, updateMedia, setField, data }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; media: MediaSlot; updateMedia: (key: string, value: unknown) => void; setField: (key: string, value: unknown) => void; data: MediaTextData; }) {
    return <CollapsibleCard title={t('cms_site.blocks.media_text.media', 'Media')} defaultOpen={false} persistKey="blk.media-text.media">
        <FieldSelect
            label={t('cms_site.blocks.media_text.media_type', 'Media type')}
            value={media.kind || 'image'}
            options={[
                { value: 'image', label: t('cms_site.blocks.media_text.kind_image', 'Image') },
                { value: 'gif', label: t('cms_site.blocks.media_text.kind_gif', 'GIF / Animation') },
                { value: 'video', label: t('cms_site.blocks.media_text.kind_video', 'Video (embed URL)') },
                { value: 'video-silent', label: t('cms_site.blocks.media_text.kind_video_silent', 'Video loop (no audio)') },
                { value: 'clip', label: t('cms_site.blocks.media_text.kind_clip', 'Clip (video with sound)') },
            ]}
            onChange={v => updateMedia('kind', v)} />
        {media.kind === 'gif' ? (
            <>
                <ImageField
                    label={t('cms_site.blocks.media_text.gif_animation', 'GIF / animation')}
                    value={media.src || ''}
                    onChange={v => updateMedia('src', v)}
                    accept="image/gif,image/webp,image/apng,image/png,image/jpeg"
                    uploadLabel={t('cms_site.blocks.media_text.upload_gif', 'Upload GIF')}
                    placeholder="https://… or /api/cms/asset/cms/…" />
                <TextField
                    label={t('cms_site.blocks.media_text.alt_text', 'Alt text')}
                    value={media.alt || ''}
                    onChange={v => updateMedia('alt', v)}
                    placeholder={t('cms_site.blocks.media_text.describe_the_animation', 'Describe the animation')} />
            </>
        ) : media.kind === 'video-silent' ? (
            <>
                <ImageField
                    label={t('cms_site.blocks.media_text.video', 'Video')}
                    value={media.src || ''}
                    onChange={v => updateMedia('src', v)}
                    accept="video/mp4,video/webm"
                    previewKind="video"
                    uploadLabel={t('cms_site.blocks.media_text.upload_video', 'Upload video')}
                    placeholder="https://… or /api/cms/asset/cms/…" />
                <TextField
                    label={t('cms_site.blocks.media_text.alt_text', 'Alt text')}
                    value={media.alt || ''}
                    onChange={v => updateMedia('alt', v)}
                    placeholder={t('cms_site.blocks.media_text.describe_the_video', 'Describe the video')} />
            </>
        ) : media.kind === 'clip' ? (
            <ClipFields
                value={media}
                onPatch={patch => setField('media', { ...media, ...patch })} />
        ) : media.kind === 'video' ? (
            <TextField
                label={t('cms_site.blocks.media_text.video_embed_url', 'Video embed URL')}
                value={media.src || ''}
                onChange={v => updateMedia('src', v)}
                placeholder="https://www.youtube.com/embed/… or https://player.vimeo.com/video/…"
                hint={t('cms_site.blocks.media_text.use_the_embed_url_not_the', 'Use the embed URL, not the public watch URL.')} />
        ) : (
            <>
                <ImageField
                    label={t('cms_site.blocks.media_text.image', 'Image')}
                    value={media.src || ''}
                    onChange={v => updateMedia('src', v)} />
                <TextField
                    label={t('cms_site.blocks.media_text.alt_text', 'Alt text')}
                    value={media.alt || ''}
                    onChange={v => updateMedia('alt', v)}
                    placeholder={t('cms_site.blocks.media_text.describe_the_image', 'Describe the image')} />
            </>
        )}
        {/* Frame + dark-theme pair — image-ish kinds only (the
            renderer routes framed images through FramedMedia;
            video/embed rendering is unchanged). Empty frame =
            legacy bare <img>, so old pages are untouched. */}
        {(!media.kind || media.kind === 'image' || media.kind === 'gif') ? (
            <>
                <FieldSelect
                    label={t('cms_site.blocks.media_text.frame', 'Frame')}
                    value={media.frame || ''}
                    options={[
                        { value: '', label: t('cms_site.blocks.media_text.frame_none', 'None (bare image)') },
                        { value: 'hairline', label: t('cms_site.blocks.media_text.frame_hairline', 'Hairline frame') },
                        { value: 'browser', label: t('cms_site.blocks.media_text.frame_browser', 'Browser window') },
                    ]}
                    onChange={v => updateMedia('frame', v)} />
                {media.frame === 'hairline' || media.frame === 'browser' ? (
                    <>
                        <ImageField
                            label={t('cms_site.blocks.media_text.dark_theme_image_optional', 'Dark-theme image (optional)')}
                            value={media.srcDark || ''}
                            onChange={v => updateMedia('srcDark', v)} />
                        <MediaMotionSelect value={media.motion} onChange={v => updateMedia('motion', v)} />
                    </>
                ) : null}
            </>
        ) : null}
        <FieldSelect
            label={t('cms_site.blocks.media_text.media_position', 'Media position')}
            value={data.mediaPosition || 'left'}
            options={[
                { value: 'left', label: t('cms_site.blocks.media_text.position_left', 'Left') },
                { value: 'right', label: t('cms_site.blocks.media_text.position_right', 'Right') },
            ]}
            onChange={v => setField('mediaPosition', v)} />
        <FieldSelect
            label={t('cms_site.blocks.media_text.media_size', 'Media size')}
            value={data.mediaSize || 'half'}
            options={[
                { value: 'half', label: t('cms_site.blocks.media_text.size_half', 'Half (50 / 50)') },
                { value: 'third', label: t('cms_site.blocks.media_text.size_third', 'One third (33 / 67)') },
                { value: 'two-thirds', label: t('cms_site.blocks.media_text.size_two_thirds', 'Two thirds (66 / 34)') },
            ]}
            onChange={v => setField('mediaSize', v)} />
    </CollapsibleCard>;
}
