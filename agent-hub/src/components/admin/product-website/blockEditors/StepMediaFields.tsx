import React from 'react';
import { TextField, ImageField } from '../fields';
import { useTranslation } from '@/hooks/useTranslation';

export interface StepMedia {
    kind?: string;
    src?: string;
    srcDark?: string;
    alt?: string;
    frame?: string;
}

/** Screenshot + alt text for one step of a scroll story or tour. */
export function StepMediaFields({ media = {}, onChange }: { media?: StepMedia; onChange: (next: StepMedia) => void }) {
    const { t } = useTranslation();
    const patch = (key: keyof StepMedia, v: string) => onChange({ kind: 'image', frame: 'browser', ...media, [key]: v });
    return (
        <>
            <ImageField
                label={t('cms_site.blocks.story_media.image', 'Screenshot')}
                value={media.src || ''}
                onChange={v => patch('src', v)}
                uploadLabel={t('cms_site.blocks.story_media.upload', 'Upload image')}
            />
            <TextField
                label={t('cms_site.blocks.story_media.alt', 'Alt text')}
                value={media.alt || ''}
                onChange={v => patch('alt', v)}
                placeholder={t('cms_site.blocks.story_media.alt_placeholder', 'Describe what the screenshot shows')}
            />
        </>
    );
}
