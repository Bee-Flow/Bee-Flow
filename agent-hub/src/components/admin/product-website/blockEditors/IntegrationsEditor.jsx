import React from 'react';
import { TextField, IconField, ImageField, RepeatableList } from '../fields';
import { InlineHint, BackgroundCard } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Integrations ──────────────────────────────────────────────────────

// Categories editor is inlined (rather than the shared GroupedItemsField)
// because integration items grew a `logoSrc` slot: a real logo image that
// renders as a 20px grayscale mark on the chip (color on hover — same
// recipe as the social-proof wall), falling back to the Lucide `icon`,
// then label-only. Storage shape is unchanged apart from the additive
// `logoSrc` key: categories[] of { heading, items: [{ icon, label }] }.

export function IntegrationsEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.integrations.category_headings_and_tool_names_are', 'Category headings and tool names are editable in the preview.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="integrations" />
            <RepeatableList
                label={t('cms_site.blocks.integrations.categories', 'Categories')}
                items={data.categories || []}
                onChange={v => onChange(set(data, 'categories', v))}
                makeNew={() => ({ heading: 'New category', items: [] })}
                itemLabel={(g) => g?.heading || t('cms_site.blocks.integrations.no_heading', '(no heading)')}
                collapsible
                renderItem={(group, updateGroup) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.integrations.category_name', 'Category name')}
                            value={group?.heading || ''}
                            onChange={v => updateGroup({ ...group, heading: v })}
                            align={group?.headingAlign || 'left'}
                            onAlignChange={v => updateGroup({ ...group, headingAlign: v })}
                        />
                        <RepeatableList
                            label={t('cms_site.blocks.integrations.items', 'Items')}
                            items={group?.items || []}
                            onChange={v => updateGroup({ ...group, items: v })}
                            makeNew={() => ({ icon: 'Plug', label: 'New item', logoSrc: '' })}
                            itemLabel={(it) => it?.label || t('cms_site.blocks.integrations.no_label', '(no label)')}
                            renderItem={(it, updateItem) => (
                                <>
                                    <ImageField
                                        label={t('cms_site.blocks.integrations.logo_image_optional', 'Logo image (optional)')}
                                        value={it?.logoSrc || ''}
                                        onChange={v => updateItem({ ...(it || {}), logoSrc: v })}
                                    />
                                    <IconField
                                        label={t('cms_site.blocks.integrations.icon_fallback', 'Icon (fallback)')}
                                        value={it?.icon}
                                        onChange={v => updateItem({ ...(it || {}), icon: v })}
                                    />
                                    <TextField
                                        label={t('cms_site.blocks.integrations.label', 'Label')}
                                        value={it?.label || ''}
                                        onChange={v => updateItem({ ...(it || {}), label: v })}
                                    />
                                </>
                            )}
                            addLabel={t('cms_site.blocks.integrations.add_item', 'Add item')}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.integrations.add_category', 'Add category')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.integrations.background" />
        </>
    );
}
