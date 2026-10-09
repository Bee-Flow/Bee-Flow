import type { ComponentType } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { ImageField as ImageFieldJs, TextField as TextFieldJs } from '../fields';

// fields.jsx is plain JS: TypeScript infers every destructured prop as
// required there, although they all have defaults or are optional.
const ImageField = ImageFieldJs as unknown as ComponentType<Record<string, unknown>>;
const TextField = TextFieldJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * Editor fields for a "clip": a demo video WITH sound, shown with controls
 * (never autoplay, never muted), an optional poster image and an optional
 * WebVTT captions track. Shared by Media + Text, Showcase and the Content
 * video element so the three cannot drift.
 *
 * The clip's own address lives under `srcKey` ('src' for media slots, 'url'
 * for the Content element, which has always kept its video address there).
 * Everything else is flat on the same object: poster, captionsSrc,
 * captionsLang, alt.
 */

export interface ClipValue {
    poster?: string;
    captionsSrc?: string;
    captionsLang?: string;
    alt?: string;
    [key: string]: unknown;
}

interface ClipFieldsProps {
    value: ClipValue;
    srcKey?: string;
    onPatch: (patch: Record<string, unknown>) => void;
}

export const DEFAULT_CAPTIONS_LANG = 'en';
const SRC_PLACEHOLDER = 'https://… or /api/cms/asset/cms/…';

export function ClipFields({ value, srcKey = 'src', onPatch }: ClipFieldsProps) {
    const { t } = useTranslation();
    const src = typeof value[srcKey] === 'string' ? (value[srcKey] as string) : '';
    return (
        <>
            <ImageField
                label={t('cms_site.blocks.clip.clip_file', 'Clip (MP4 / WebM, with sound, up to 500 MB)')}
                value={src}
                onChange={(v: string) => onPatch({ [srcKey]: v })}
                accept="video/mp4,video/webm"
                previewKind="clip"
                uploadPath="upload-clip"
                uploadLabel={t('cms_site.blocks.clip.upload_clip', 'Upload clip')}
                placeholder={SRC_PLACEHOLDER}
            />
            <ImageField
                label={t('cms_site.blocks.clip.poster_image_optional', 'Poster image (optional)')}
                value={value.poster || ''}
                onChange={(v: string) => onPatch({ poster: v })}
                uploadLabel={t('cms_site.blocks.clip.upload_poster', 'Upload poster')}
            />
            <ImageField
                label={t('cms_site.blocks.clip.captions_optional_vtt', 'Captions (optional, .vtt)')}
                value={value.captionsSrc || ''}
                onChange={(v: string) => onPatch({ captionsSrc: v, ...(v && !value.captionsLang ? { captionsLang: DEFAULT_CAPTIONS_LANG } : {}) })}
                accept=".vtt,text/vtt"
                previewKind="captions"
                uploadLabel={t('cms_site.blocks.clip.upload_captions', 'Upload captions')}
            />
            {value.captionsSrc ? (
                <TextField
                    label={t('cms_site.blocks.clip.captions_language', 'Captions language')}
                    value={value.captionsLang || DEFAULT_CAPTIONS_LANG}
                    onChange={(v: string) => onPatch({ captionsLang: v.trim() })}
                    hint={t('cms_site.blocks.clip.language_code_of_the_captions_file', 'Language code of the captions file, for example en or nl.')}
                />
            ) : null}
            <TextField
                label={t('cms_site.blocks.clip.title_description_for_screen_readers', 'Title / description (for screen readers)')}
                value={value.alt || ''}
                onChange={(v: string) => onPatch({ alt: v })}
                hint={t('cms_site.blocks.clip.read_out_for_the_video_describe_what', 'Read out for the video. Describe what the clip shows.')}
            />
        </>
    );
}
