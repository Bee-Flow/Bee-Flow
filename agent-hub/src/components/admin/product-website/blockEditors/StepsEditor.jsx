import React from 'react';
import { TextField, ImageField, RepeatableList, FieldRow } from '../fields';
import { InlineHint, ColorSwatch, BackgroundCard } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import VariantPicker from './VariantPicker';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Steps ─────────────────────────────────────────────────────────────

export function StepsEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const chapters = data.variant === 'chapters';
    return (
        <>
            <VariantPicker
                type="steps"
                value={data.variant}
                onChange={v => onChange(set(data, 'variant', v))}
            />
            <InlineHint>{t('cms_site.blocks.steps.click_any_step_s_number_title', "Click any step's number, title, body, or example in the preview to edit.")}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="steps" />
            <RepeatableList
                label={t('cms_site.blocks.steps.steps', 'Steps')}
                items={data.items || []}
                onChange={v => onChange(set(data, 'items', v))}
                makeNew={() => ({ number: '', title: 'New step', body: '', example: '', media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' } })}
                itemLabel={(item) => item.title || t('cms_site.blocks.steps.no_title', '(no title)')}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.steps.number', 'Number')}
                            value={item.number || ''}
                            onChange={v => update({ ...item, number: v })}
                            placeholder="e.g. 1"
                        />
                        <TextField
                            label={t('cms_site.blocks.steps.title', 'Title')}
                            value={item.title || ''}
                            onChange={v => update({ ...item, title: v })}
                            align={item.titleAlign || 'left'}
                            onAlignChange={v => update({ ...item, titleAlign: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.steps.body', 'Body')}
                            value={item.body || ''}
                            onChange={v => update({ ...item, body: v })}
                            placeholder={t('cms_site.blocks.steps.describe_what_happens_in_this_step', 'Describe what happens in this step.')}
                            align={item.bodyAlign || 'left'}
                            onAlignChange={v => update({ ...item, bodyAlign: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.steps.example', 'Example')}
                            value={item.example || ''}
                            onChange={v => update({ ...item, example: v })}
                            placeholder={t('cms_site.blocks.steps.optional_caption_example', 'Optional caption / example')}
                            align={item.exampleAlign || 'left'}
                            onAlignChange={v => update({ ...item, exampleAlign: v })}
                        />
                        {chapters ? (
                            <FieldRow label={t('cms_site.blocks.steps.screenshot', 'Screenshot')} hint={t('cms_site.blocks.steps.chapters_alternate_sides_automatically_a_real', 'Chapters alternate sides automatically. A real product shot per chapter is what makes this layout work.')}>
                                <ImageField
                                    value={item.media?.src || ''}
                                    onChange={v => update({ ...item, media: { ...(item.media || {}), src: v, frame: item.media?.frame || 'hairline', kind: 'image' } })}
                                />
                            </FieldRow>
                        ) : null}
                        {/* Per-step title color — single hex string. */}
                        <FieldRow label={t('cms_site.blocks.steps.title_color', 'Title color')}>
                            <ColorSwatch
                                value={item.titleColor || ''}
                                onChange={v => update({ ...item, titleColor: v })}
                                title={t('cms_site.blocks.steps.step_title_color', 'Step title color')}
                            />
                        </FieldRow>
                    </>
                )}
                addLabel={t('cms_site.blocks.steps.add_step', 'Add step')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.steps.background" />
        </>
    );
}
