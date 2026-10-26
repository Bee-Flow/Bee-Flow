import React from 'react';
import { TextField, TextArea, RepeatableList } from '../fields';
import { InlineHint } from '../primitives';
import type { BlockEditorProps } from './editorProps';
import { set, SectionHeaderFields } from './shared';
import type { SectionHeaderData } from './shared';
import { StepMediaFields } from './StepMediaFields';
import type { StepMedia } from './StepMediaFields';
import { useTranslation } from '@/hooks/useTranslation';

type Hotspot = { x?: number; y?: number; label?: string; body?: string };
type TourStep = { title?: string; body?: string; media?: StepMedia; hotspots?: Hotspot[] };
type TourLabels = { previous?: string; next?: string; stepOf?: string; hotspot?: string };
type TourData = SectionHeaderData & { steps?: TourStep[]; labels?: TourLabels };

const toPct = (v: string): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50;
};

export function TourEditor({ data = {}, onChange }: BlockEditorProps<TourData>) {
    const { t } = useTranslation();
    const labels = data.labels || {};
    const setLabel = (key: keyof TourLabels, v: string) => onChange(set(data, 'labels', { ...labels, [key]: v }));
    return (
        <>
            <InlineHint>{t('cms_site.blocks.tour.hint', 'One screenshot per step. Hotspots are numbered dots on the image; a visitor clicks one to read its explanation. Position is a percentage of the image, 0 to 100.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="tour" />
            <RepeatableList
                label={t('cms_site.blocks.tour.steps', 'Steps')}
                items={data.steps || []}
                onChange={v => onChange(set(data, 'steps', v))}
                makeNew={() => ({ title: '', body: '', media: { kind: 'image', src: '', alt: '', frame: 'browser' }, hotspots: [] })}
                itemLabel={(item) => item.title || t('cms_site.blocks.tour.no_title', '(no title)')}
                renderItem={(item, update) => (
                    <>
                        <TextField label={t('cms_site.blocks.tour.step_title', 'Title')} value={item.title || ''} onChange={v => update({ ...item, title: v })} />
                        <TextArea label={t('cms_site.blocks.tour.step_body', 'Text')} value={item.body || ''} onChange={v => update({ ...item, body: v })} />
                        <StepMediaFields media={item.media} onChange={media => update({ ...item, media })} />
                        <RepeatableList
                            label={t('cms_site.blocks.tour.hotspots', 'Hotspots')}
                            items={item.hotspots || []}
                            onChange={hotspots => update({ ...item, hotspots })}
                            makeNew={() => ({ x: 50, y: 50, label: '', body: '' })}
                            itemLabel={(h, n) => h.label || t('cms_site.blocks.tour.hotspot_n', 'Hotspot {n}', { n: n + 1 })}
                            renderItem={(h, updateHotspot) => (
                                <>
                                    <TextField label={t('cms_site.blocks.tour.hotspot_label', 'Label')} value={h.label || ''} onChange={v => updateHotspot({ ...h, label: v })} />
                                    <TextArea label={t('cms_site.blocks.tour.hotspot_body', 'Explanation')} value={h.body || ''} onChange={v => updateHotspot({ ...h, body: v })} />
                                    <TextField label={t('cms_site.blocks.tour.hotspot_x', 'Left (%)')} value={String(h.x ?? 50)} onChange={v => updateHotspot({ ...h, x: toPct(v) })} />
                                    <TextField label={t('cms_site.blocks.tour.hotspot_y', 'Top (%)')} value={String(h.y ?? 50)} onChange={v => updateHotspot({ ...h, y: toPct(v) })} />
                                </>
                            )}
                            addLabel={t('cms_site.blocks.tour.add_hotspot', 'Add hotspot')}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.tour.add_step', 'Add step')}
            />
            <TextField label={t('cms_site.blocks.tour.label_previous', 'Previous button')} value={labels.previous || ''} onChange={v => setLabel('previous', v)} placeholder={t('cms_site.blocks.tour.default_previous', 'Previous step')} />
            <TextField label={t('cms_site.blocks.tour.label_next', 'Next button')} value={labels.next || ''} onChange={v => setLabel('next', v)} placeholder={t('cms_site.blocks.tour.default_next', 'Next step')} />
            <TextField label={t('cms_site.blocks.tour.label_step_of', 'Step counter')} value={labels.stepOf || ''} onChange={v => setLabel('stepOf', v)} placeholder={t('cms_site.blocks.tour.default_step_of', 'Step {n} of {total}')} />
        </>
    );
}
