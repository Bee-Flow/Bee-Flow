import React from 'react';
import { TextField, TextArea, RepeatableList } from '../fields';
import { InlineHint } from '../primitives';
import type { BlockEditorProps } from './editorProps';
import { set, SectionHeaderFields } from './shared';
import type { SectionHeaderData } from './shared';
import { StepMediaFields } from './StepMediaFields';
import type { StepMedia } from './StepMediaFields';
import { useTranslation } from '../../../../hooks/useTranslation';

type StoryStep = { title?: string; body?: string; media?: StepMedia };
type ScrollStoryData = SectionHeaderData & { steps?: StoryStep[] };

export function ScrollStoryEditor({ data = {}, onChange }: BlockEditorProps<ScrollStoryData>) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.scroll_story.hint', 'Steps run down the page; the image next to them changes with the step in view. On phones and with reduced motion each image sits under its step.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="scrollStory" />
            <RepeatableList
                label={t('cms_site.blocks.scroll_story.steps', 'Steps')}
                items={data.steps || []}
                onChange={v => onChange(set(data, 'steps', v))}
                makeNew={() => ({ title: '', body: '', media: { kind: 'image', src: '', alt: '', frame: 'browser' } })}
                itemLabel={(item) => item.title || t('cms_site.blocks.scroll_story.no_title', '(no title)')}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.scroll_story.step_title', 'Title')}
                            value={item.title || ''}
                            onChange={v => update({ ...item, title: v })}
                        />
                        <TextArea
                            label={t('cms_site.blocks.scroll_story.step_body', 'Text')}
                            value={item.body || ''}
                            onChange={v => update({ ...item, body: v })}
                        />
                        <StepMediaFields media={item.media} onChange={media => update({ ...item, media })} />
                    </>
                )}
                addLabel={t('cms_site.blocks.scroll_story.add_step', 'Add step')}
            />
        </>
    );
}
