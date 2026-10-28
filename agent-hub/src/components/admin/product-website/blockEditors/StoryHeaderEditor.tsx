import React from 'react';
import { TextField, ImageField, RepeatableList, FieldRow } from '../fields';
import { InlineHint, BackgroundCard } from '../primitives';
import type { BlockEditorProps } from './editorProps';
import { set } from './shared';
import { useTranslation } from '@/hooks/useTranslation';
import { STORY_METRICS_MAX, STORY_METRICS_MIN } from './blockData.generated.mjs';

// ── Customer story header ─────────────────────────────────────────────
//
// The top of a case-study page. The "Customer stories" grid builds its cards
// from these fields on the published page, so they are written once. The
// figures must be the customer's real numbers.

type Logo = { src?: string; srcDark?: string; alt?: string; frame?: string; kind?: string };
type Metric = { stat?: string; label?: string };
type StoryHeaderData = {
    customer?: string;
    sector?: string;
    title?: string;
    lead?: string;
    logo?: Logo;
    quote?: string;
    quoteBy?: string;
    metrics?: Metric[];
    backgroundVariant?: string;
};

export function StoryHeaderEditor({ data = {}, onChange }: BlockEditorProps<StoryHeaderData>) {
    const { t } = useTranslation();
    const logo = data.logo || {};
    const metrics = data.metrics || [];
    const setField = (key: string, value: unknown) => onChange(set(data, key, value));
    const setLogo = (patch: Logo) => setField('logo', { frame: 'none', kind: 'image', ...logo, ...patch });
    return (
        <>
            <InlineHint>{t('cms_site.blocks.story_header.hint', 'The top of a customer story page. Click the text in the preview to edit it inline. The Customer stories grid shows this page as a card once the site is published.')}</InlineHint>
            <TextField label={t('cms_site.blocks.story_header.customer', 'Customer')} value={data.customer || ''} onChange={v => setField('customer', v)} />
            <TextField
                label={t('cms_site.blocks.story_header.sector', 'Sector')}
                value={data.sector || ''}
                onChange={v => setField('sector', v)}
                placeholder={t('cms_site.blocks.story_header.sector_placeholder', 'e.g. Public sector')}
            />
            <TextField label={t('cms_site.blocks.story_header.title', 'Headline')} value={data.title || ''} onChange={v => setField('title', v)} />
            <TextField
                label={t('cms_site.blocks.story_header.lead', 'Summary')}
                value={data.lead || ''}
                onChange={v => setField('lead', v)}
                placeholder={t('cms_site.blocks.story_header.lead_placeholder', 'One or two sentences, also shown on the story card.')}
            />
            <FieldRow label={t('cms_site.blocks.story_header.logo', 'Customer logo')}>
                <ImageField value={logo.src || ''} onChange={v => setLogo({ src: v })} />
            </FieldRow>
            <FieldRow label={t('cms_site.blocks.story_header.logo_dark', 'Logo for dark mode (optional)')}>
                <ImageField value={logo.srcDark || ''} onChange={v => setLogo({ srcDark: v })} />
            </FieldRow>
            <TextField
                label={t('cms_site.blocks.story_header.logo_alt', 'Logo description (alt text)')}
                value={logo.alt || ''}
                onChange={v => setLogo({ alt: v })}
            />
            {metrics.length < STORY_METRICS_MIN ? (
                <InlineHint>{t('cms_site.blocks.story_header.min_metrics', 'Add at least two figures: they are the first thing a visitor reads.')}</InlineHint>
            ) : null}
            <RepeatableList
                label={t('cms_site.blocks.story_header.metrics', 'Figures')}
                items={metrics}
                maxItems={STORY_METRICS_MAX}
                onChange={v => setField('metrics', v)}
                makeNew={() => ({ stat: '', label: '' })}
                itemLabel={(m) => [m.stat, m.label].filter(Boolean).join(' ') || t('cms_site.blocks.story_header.no_metric', '(empty figure)')}
                renderItem={(m, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.story_header.stat', 'Figure')}
                            value={m.stat || ''}
                            onChange={v => update({ ...m, stat: v })}
                            placeholder="60%"
                        />
                        <TextField
                            label={t('cms_site.blocks.story_header.stat_label', 'What it measures')}
                            value={m.label || ''}
                            onChange={v => update({ ...m, label: v })}
                            placeholder={t('cms_site.blocks.story_header.stat_label_placeholder', 'less time on review')}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.story_header.add_metric', 'Add figure')}
            />
            <TextField label={t('cms_site.blocks.story_header.quote', 'Quote')} value={data.quote || ''} onChange={v => setField('quote', v)} />
            <TextField
                label={t('cms_site.blocks.story_header.quote_by', 'Who said it')}
                value={data.quoteBy || ''}
                onChange={v => setField('quoteBy', v)}
                placeholder={t('cms_site.blocks.story_header.quote_by_placeholder', 'Name, role')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.story-header.background" />
        </>
    );
}
