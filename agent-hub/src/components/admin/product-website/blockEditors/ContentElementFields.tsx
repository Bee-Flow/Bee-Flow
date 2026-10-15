import { ClipFields } from './ClipFields';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { Align, CmsLink, CmsPageOption } from '../fields';
import type { TextStyle } from './blockEditorTypes';
import { makeElement } from '../../../../marketing/sections/contentMigration';
import { TextField, Toggle, ImageField, RepeatableList, LinkField, FieldRow, inputCls } from '../fields';
import { CollapsibleCard, StyleTriplet, FieldSelect, CtaStyleSelect } from '../primitives';

export const aligns = (t: TranslateFn) => [
    { value: 'left',   label: t('cms_site.blocks.content.align_left', 'Left') },
    { value: 'center', label: t('cms_site.blocks.content.align_center', 'Center') },
    { value: 'right',  label: t('cms_site.blocks.content.align_right', 'Right') },
];

export const elementKinds = (t: TranslateFn) => [
    { value: 'text',   label: t('cms_site.blocks.content.kind_text', 'Text'),   icon: 'Type'    },
    { value: 'image',  label: t('cms_site.blocks.content.kind_image', 'Image'),  icon: 'Image'   },
    { value: 'video',  label: t('cms_site.blocks.content.kind_video', 'Video'),  icon: 'Video'   },
    { value: 'iframe', label: t('cms_site.blocks.content.kind_embed', 'Embed'),  icon: 'Globe'   },
    { value: 'cta',    label: t('cms_site.blocks.content.kind_button', 'Button'), icon: 'Square'  },
];

export type ContentElement = {
    id?: string;
    kind?: string;
    heading?: string;
    headingAlign?: Align;
    align?: Align;
    subheading?: string;
    subheadingAlign?: Align;
    body?: string;
    bodyAlign?: Align;
    headingStyle?: TextStyle;
    subheadingStyle?: TextStyle;
    bodyStyle?: TextStyle;
    src?: string;
    alt?: string;
    aspectRatio?: string;
    frame?: string;
    rounded?: boolean;
    fullBleed?: boolean;
    lightbox?: boolean;
    caption?: string;
    url?: string;
    source?: string;
    height?: number;
    label?: string;
    scrolling?: boolean;
    link?: CmsLink;
    style?: string;
};

export interface ElementFieldsProps {
    el: ContentElement;
    pages?: CmsPageOption[];
    update: (next: ContentElement) => void;
}

export function ElementFields({ el, pages, update }: ElementFieldsProps) {
    const { t } = useTranslation();
    const setKind = (nextKind: string) => {
        if (nextKind === el.kind) return;
        // Preserve the id when changing kind so RepeatableList's collapse
        // state for this row stays attached, but otherwise reset to the
        // new kind's defaults — fields don't share semantics across kinds.
        const fresh = makeElement(nextKind) as ContentElement;
        update({ ...fresh, id: el.id });
    };

    return (
        <>
            <FieldSelect
                label={t('cms_site.blocks.content.element_type', 'Element type')}
                value={el.kind || 'text'}
                options={elementKinds(t).map(k => ({ value: k.value, label: k.label }))}
                onChange={setKind}
            />

            {el.kind === 'text' ? (
                <>
                    <TextField
                        label={t('cms_site.blocks.content.heading', 'Heading')}
                        value={el.heading || ''}
                        onChange={v => update({ ...el, heading: v })}
                        placeholder={t('cms_site.blocks.content.optional_heading', 'Optional heading')}
                        align={el.headingAlign || el.align || 'left'}
                        onAlignChange={v => update({ ...el, headingAlign: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.subheading', 'Subheading')}
                        value={el.subheading || ''}
                        onChange={v => update({ ...el, subheading: v })}
                        placeholder={t('cms_site.blocks.content.optional_subheading', 'Optional subheading')}
                        align={el.subheadingAlign || el.align || 'left'}
                        onAlignChange={v => update({ ...el, subheadingAlign: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.body', 'Body')}
                        value={el.body || ''}
                        onChange={v => update({ ...el, body: v })}
                        placeholder={t('cms_site.blocks.content.write_paragraph_text_line_breaks_are', 'Write paragraph text. Line breaks are preserved.')}
                        align={el.bodyAlign || el.align || 'left'}
                        onAlignChange={v => update({ ...el, bodyAlign: v })}
                    />
                    {/* Per-text-element typography. Stored under
                        element.headingStyle / subheadingStyle / bodyStyle. */}
                    <CollapsibleCard title={t('cms_site.blocks.content.text_styles', 'Text styles')} defaultOpen={false}>
                        <StyleTriplet
                            label={t('cms_site.blocks.content.heading', 'Heading')}
                            value={el.headingStyle}
                            onChange={v => update({ ...el, headingStyle: v })}
                            sample={el.heading || t('cms_site.blocks.content.heading_preview', 'Heading preview')}
                            weight={700}
                            min={12} max={96}
                        />
                        <StyleTriplet
                            label={t('cms_site.blocks.content.subheading', 'Subheading')}
                            value={el.subheadingStyle}
                            onChange={v => update({ ...el, subheadingStyle: v })}
                            sample={el.subheading || t('cms_site.blocks.content.subheading_preview', 'Subheading preview')}
                            weight={500}
                            min={10} max={48}
                        />
                        <StyleTriplet
                            label={t('cms_site.blocks.content.body', 'Body')}
                            value={el.bodyStyle}
                            onChange={v => update({ ...el, bodyStyle: v })}
                            sample={el.body || 'The quick brown fox jumps over the lazy dog.'}
                            weight={400}
                            min={10} max={32}
                        />
                    </CollapsibleCard>
                </>
            ) : null}

            {el.kind === 'image' ? (
                <>
                    <ImageField
                        label={t('cms_site.blocks.content.image', 'Image')}
                        value={el.src || ''}
                        onChange={v => update({ ...el, src: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.alt_text', 'Alt text')}
                        value={el.alt || ''}
                        onChange={v => update({ ...el, alt: v })}
                        placeholder={t('cms_site.blocks.content.describe_the_image', 'Describe the image')}
                    />
                    <FieldSelect
                        label={t('cms_site.blocks.content.aspect_ratio', 'Aspect ratio')}
                        value={el.aspectRatio || 'auto'}
                        options={[
                            { value: 'auto', label: t('cms_site.blocks.content.aspect_auto', 'Auto (intrinsic)') },
                            { value: '16/9', label: '16:9' },
                            { value: '4/3',  label: '4:3'  },
                            { value: '1/1',  label: '1:1'  },
                            { value: '3/4',  label: '3:4'  },
                        ]}
                        onChange={v => update({ ...el, aspectRatio: v })}
                    />
                    {/* Premium frame — routes through FramedMedia. Framed
                        images use the frame's own box (aspect-ratio crop is
                        skipped) and win over the lightbox toggle. */}
                    <FieldSelect
                        label={t('cms_site.blocks.content.frame', 'Frame')}
                        value={el.frame || ''}
                        options={[
                            { value: '',         label: t('cms_site.blocks.content.frame_none', 'None') },
                            { value: 'hairline', label: t('cms_site.blocks.content.frame_hairline', 'Hairline frame') },
                            { value: 'browser',  label: t('cms_site.blocks.content.frame_browser', 'Browser window') },
                        ]}
                        onChange={v => update({ ...el, frame: v })}
                    />
                    <Toggle
                        label={t('cms_site.blocks.content.rounded_corners', 'Rounded corners')}
                        value={!!el.rounded}
                        onChange={v => update({ ...el, rounded: v })}
                    />
                    <Toggle
                        label={t('cms_site.blocks.content.full_width_image', 'Full width image')}
                        value={!!el.fullBleed}
                        onChange={v => update({ ...el, fullBleed: v })}
                    />
                    <Toggle
                        label={t('cms_site.blocks.content.click_to_enlarge_lightbox', 'Click to enlarge (lightbox)')}
                        value={!!el.lightbox}
                        onChange={v => update({ ...el, lightbox: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.caption', 'Caption')}
                        value={el.caption || ''}
                        onChange={v => update({ ...el, caption: v })}
                        placeholder={t('cms_site.blocks.content.optional_caption', 'Optional caption')}
                    />
                </>
            ) : null}

            {el.kind === 'video' ? (
                <>
                    {/* Source toggle: external embed (YouTube/Vimeo iframe)
                        vs. self-hosted file upload (MP4/WebM, looped + muted
                        like the Media + Text 'video-silent' kind). Both paths
                        write the resulting address to el.url so the renderer
                        only has one field to read. */}
                    <FieldSelect
                        label={t('cms_site.blocks.content.source', 'Source')}
                        value={el.source === 'upload' || el.source === 'clip' ? el.source : 'embed'}
                        options={[
                            { value: 'embed',  label: t('cms_site.blocks.content.source_embed', 'External URL (YouTube / Vimeo)') },
                            { value: 'upload', label: t('cms_site.blocks.content.source_upload', 'Upload file (silent loop, MP4 / WebM)') },
                            { value: 'clip',   label: t('cms_site.blocks.content.source_clip', 'Clip (video with sound)') },
                        ]}
                        onChange={v => update({ ...el, source: v, url: '' })}
                    />
                    {el.source === 'clip' ? (
                        <ClipFields value={el} srcKey="url" onPatch={patch => update({ ...el, ...patch })} />
                    ) : el.source === 'upload' ? (
                        <ImageField
                            label={t('cms_site.blocks.content.video_file', 'Video file')}
                            value={el.url || ''}
                            onChange={v => update({ ...el, url: v })}
                            accept="video/mp4,video/webm"
                            previewKind="video"
                            uploadLabel={t('cms_site.blocks.content.upload_video', 'Upload video')}
                            placeholder="https://… or /api/cms/asset/cms/…"
                        />
                    ) : (
                        <TextField
                            label={t('cms_site.blocks.content.video_url', 'Video URL')}
                            value={el.url || ''}
                            onChange={v => update({ ...el, url: v })}
                            placeholder={t('cms_site.blocks.content.youtube_or_vimeo_url', 'YouTube or Vimeo URL')}
                        />
                    )}
                    <FieldSelect
                        label={t('cms_site.blocks.content.aspect_ratio', 'Aspect ratio')}
                        value={el.aspectRatio || '16/9'}
                        options={[
                            { value: '16/9', label: '16:9' },
                            { value: '4/3',  label: '4:3'  },
                            { value: '1/1',  label: '1:1'  },
                        ]}
                        onChange={v => update({ ...el, aspectRatio: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.caption', 'Caption')}
                        value={el.caption || ''}
                        onChange={v => update({ ...el, caption: v })}
                        placeholder={t('cms_site.blocks.content.optional_caption', 'Optional caption')}
                    />
                </>
            ) : null}

            {el.kind === 'iframe' ? (
                <>
                    <TextField
                        label={t('cms_site.blocks.content.embed_url', 'Embed URL')}
                        value={el.src || ''}
                        onChange={v => update({ ...el, src: v })}
                        placeholder={t('cms_site.blocks.content.embed_url_placeholder', 'https://… (chat agent, Calendly, Map, …)')}
                    />
                    <FieldRow label={t('cms_site.blocks.content.height_px', 'Height (px)')}>
                        <input
                            type="number"
                            min={120}
                            max={2000}
                            step={20}
                            className={inputCls}
                            value={Number.isFinite(el.height) ? el.height : 480}
                            onChange={e => update({ ...el, height: Number(e.target.value) || 480 })}
                        />
                    </FieldRow>
                    <TextField
                        label={t('cms_site.blocks.content.accessible_label', 'Accessible label')}
                        value={el.label || ''}
                        onChange={v => update({ ...el, label: v })}
                        placeholder={t('cms_site.blocks.content.used_as_the_iframe_title_attribute', 'Used as the iframe title attribute')}
                    />
                    <Toggle
                        label={t('cms_site.blocks.content.allow_scrolling', 'Allow scrolling')}
                        value={!!el.scrolling}
                        onChange={v => update({ ...el, scrolling: v })}
                    />
                </>
            ) : null}

            {el.kind === 'cta' ? (
                <>
                    <TextField
                        label={t('cms_site.blocks.content.label', 'Label')}
                        value={el.label || ''}
                        onChange={v => update({ ...el, label: v })}
                    />
                    <LinkField
                        label={t('cms_site.blocks.content.link', 'Link')}
                        value={el.link}
                        pages={pages}
                        onChange={v => update({ ...el, link: v })}
                    />
                    <CtaStyleSelect
                        value={el.style || 'primary'}
                        onChange={v => update({ ...el, style: v })}
                    />
                    <FieldSelect
                        label={t('cms_site.blocks.content.align', 'Align')}
                        value={el.align || 'left'}
                        options={aligns(t)}
                        onChange={v => update({ ...el, align: v })}
                    />
                </>
            ) : null}
        </>
    );
}
