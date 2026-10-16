import React from 'react';
import { TextField, Toggle } from '../fields';
import { InlineHint, BackgroundCard } from '../primitives';
import type { BlockEditorProps } from './editorProps';
import { set, SectionHeaderFields } from './shared';
import type { SectionHeaderData } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';
import { STORY_GRID_MAX } from './blockData.generated.mjs';

// ── Customer stories grid ─────────────────────────────────────────────
//
// Stores no stories: the pages of the live site that start with a customer
// story header, as last published, are fetched (and put in the rendered HTML).

type CustomerStoriesData = SectionHeaderData & {
    limit?: number | string;
    sectorId?: string;
    showFilter?: boolean;
    allLabel?: string;
    linkLabel?: string;
    emptyText?: string;
    backgroundVariant?: string;
};

/** The URL form of a sector: lowercase letters, digits and single dashes. */
export function cleanSectorId(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40);
}

export function CustomerStoriesEditor({ data = {}, onChange }: BlockEditorProps<CustomerStoriesData>) {
    const { t } = useTranslation();
    const setField = (key: string, value: unknown) => onChange(set(data, key, value));
    return (
        <>
            <InlineHint>{t('cms_site.blocks.customer_stories.hint', 'Shows the customer stories of the live site: every published page that starts with a Customer story header. Create one from the Customer story template when adding a page.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="customer-stories" />
            <TextField
                label={t('cms_site.blocks.customer_stories.limit', 'How many stories (1–{max})', { max: STORY_GRID_MAX })}
                value={String(data.limit ?? '')}
                onChange={(v: string) => {
                    const n = Number.parseInt(v, 10);
                    setField('limit', v === '' ? '' : Math.min(STORY_GRID_MAX, Math.max(1, Number.isFinite(n) ? n : 6)));
                }}
                placeholder="6"
            />
            <Toggle
                label={t('cms_site.blocks.customer_stories.show_filter', 'Show the sector filter')}
                value={data.showFilter !== false}
                onChange={v => setField('showFilter', v)}
            />
            <TextField
                label={t('cms_site.blocks.customer_stories.sector', 'Only this sector (optional)')}
                value={data.sectorId || ''}
                onChange={v => setField('sectorId', cleanSectorId(v))}
                placeholder={t('cms_site.blocks.customer_stories.sector_placeholder', 'e.g. public-sector')}
            />
            <TextField
                label={t('cms_site.blocks.customer_stories.all_label', 'Label of the "all" filter')}
                value={data.allLabel || ''}
                onChange={v => setField('allLabel', v)}
                placeholder={t('cms_site.blocks.customer_stories.all_placeholder', 'All')}
            />
            <TextField
                label={t('cms_site.blocks.customer_stories.link_label', 'Label of the card link')}
                value={data.linkLabel || ''}
                onChange={v => setField('linkLabel', v)}
                placeholder={t('cms_site.blocks.customer_stories.link_placeholder', 'Read the story')}
            />
            <TextField
                label={t('cms_site.blocks.customer_stories.empty_text', 'Text in the editor while there are no stories')}
                value={data.emptyText || ''}
                onChange={v => setField('emptyText', v)}
                placeholder={t('cms_site.blocks.customer_stories.empty_placeholder', 'Published customer stories appear here')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.customer-stories.background" />
        </>
    );
}
