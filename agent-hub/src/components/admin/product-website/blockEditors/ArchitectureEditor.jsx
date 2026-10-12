import React from 'react';
import { InlineHint, BackgroundCard } from '../primitives';
import { set, SectionHeaderFields, GroupedItemsField } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Architecture ──────────────────────────────────────────────────────

export function ArchitectureEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.architecture.click_layer_labels_and_tags_in', 'Click layer labels and tags in the preview to edit them.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="architecture" />
            <GroupedItemsField
                groups={data.layers || []}
                onChange={v => onChange(set(data, 'layers', v))}
                groupsLabel={t('cms_site.blocks.architecture.layers', 'Layers')}
                groupNameLabel={t('cms_site.blocks.architecture.layer_name', 'Layer name')}
                addGroupLabel={t('cms_site.blocks.architecture.add_layer', 'Add layer')}
                newGroupName={t('cms_site.blocks.architecture.new_layer', 'New layer')}
                itemKind="string"
                headingKey="label"
                itemsKey="tags"
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.architecture.background" />
        </>
    );
}
