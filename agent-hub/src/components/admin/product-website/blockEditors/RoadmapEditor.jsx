import React from 'react';
import { TextField, TextArea, IconField, RepeatableList, LinkField, Toggle } from '../fields';
import { InlineHint, BackgroundCard, FieldSelect, SectionDivider, mintId } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Roadmap ───────────────────────────────────────────────────────────
//
// Items are typed in any order and grouped into status buckets by the
// renderer. Nothing here sorts them, and nothing should: locale overrides
// address array items by numeric index, so reordering the list in the
// default locale drags every translation onto the wrong item.
//
// `status` is on the translation denylist in BOTH server/core/cmsTranslate.js
// and ../translatable.js — if it ever came off, the AI translator would turn
// 'beta' into 'bèta' and the item would fall out of every bucket.

const statusOptions = (t) => [
    { value: 'shipped',   label: t('cms_site.blocks.roadmap.status_shipped', 'Available now') },
    { value: 'beta',      label: t('cms_site.blocks.roadmap.status_beta', 'In beta') },
    { value: 'building',  label: t('cms_site.blocks.roadmap.status_building', 'In development') },
    { value: 'exploring', label: t('cms_site.blocks.roadmap.status_exploring', 'Exploring') },
];

export function RoadmapEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const STATUS_OPTIONS = statusOptions(t);
    const labels = data.statusLabels || {};
    const setLabel = (key, value) =>
        onChange(set(data, 'statusLabels', { ...labels, [key]: value }));

    return (
        <>
            <InlineHint>
                {t('cms_site.blocks.roadmap.items_are_grouped_by_status_when_the', 'Items are grouped by status when the page renders — the order you type them in does not matter, so you can add one anywhere without disturbing translations.')}
            </InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="roadmap" />

            <RepeatableList
                label={t('cms_site.blocks.roadmap.items', 'Items')}
                items={data.items || []}
                onChange={v => onChange(set(data, 'items', v))}
                makeNew={() => ({ id: mintId('rm'), title: 'New item', body: '', status: 'building', icon: '', note: '' })}
                itemLabel={(item) => {
                    const s = STATUS_OPTIONS.find(o => o.value === item.status);
                    return `${item.title || t('cms_site.blocks.roadmap.untitled', '(untitled)')}${s ? ` — ${s.label}` : ''}`;
                }}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.roadmap.title', 'Title')}
                            value={item.title || ''}
                            onChange={v => update({ ...item, title: v })}
                            placeholder={t('cms_site.blocks.roadmap.what_the_thing_is_called', 'What the thing is called')}
                        />
                        <FieldSelect
                            label={t('cms_site.blocks.roadmap.status', 'Status')}
                            value={item.status || 'building'}
                            options={STATUS_OPTIONS}
                            onChange={v => update({ ...item, status: v })}
                            hint={t('cms_site.blocks.roadmap.decides_which_group_it_appears_under', 'Decides which group it appears under.')}
                        />
                        <TextArea
                            label={t('cms_site.blocks.roadmap.description', 'Description')}
                            value={item.body || ''}
                            onChange={v => update({ ...item, body: v })}
                            placeholder={t('cms_site.blocks.roadmap.one_or_two_sentences_on_what', 'One or two sentences on what it does.')}
                            rows={3}
                        />
                        <TextField
                            label={t('cms_site.blocks.roadmap.caveat', 'Caveat')}
                            value={item.note || ''}
                            onChange={v => update({ ...item, note: v })}
                            placeholder={t('cms_site.blocks.roadmap.e_g_enterprise_plan_opt_in', 'e.g. Enterprise plan, opt-in · Dutch law only')}
                            hint={t('cms_site.blocks.roadmap.the_honest_small_print_which_plan', 'The honest small print — which plan it needs, what it does not cover. Shown under the description.')}
                        />
                        <IconField label={t('cms_site.blocks.roadmap.icon', 'Icon')} value={item.icon} onChange={v => update({ ...item, icon: v })} />
                        <LinkField
                            label={t('cms_site.blocks.roadmap.link_optional', 'Link (optional)')}
                            value={item.link}
                            onChange={v => update({ ...item, link: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.roadmap.link_label', 'Link label')}
                            value={item.linkLabel || ''}
                            onChange={v => update({ ...item, linkLabel: v })}
                            placeholder={t('cms_site.blocks.roadmap.read_more', 'Read more')}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.roadmap.add_roadmap_item', 'Add roadmap item')}
            />

            <SectionDivider label={t('cms_site.blocks.roadmap.group_names', 'Group names')} />
            <InlineHint>
                {t('cms_site.blocks.roadmap.what_each_group_is_called_on_the', 'What each group is called on the page. These are translated per language; the statuses behind them are not.')}
            </InlineHint>
            {STATUS_OPTIONS.map(o => (
                <TextField
                    key={o.value}
                    label={o.label}
                    value={labels[o.value] || ''}
                    onChange={v => setLabel(o.value, v)}
                    placeholder={o.label}
                />
            ))}
            <Toggle
                label={t('cms_site.blocks.roadmap.show_the_status_key', 'Show the status key')}
                checked={data.showLegend !== false}
                onChange={v => onChange(set(data, 'showLegend', v))}
            />

            <SectionDivider label={t('cms_site.blocks.roadmap.disclaimer', 'Disclaimer')} />
            <TextArea
                label={t('cms_site.blocks.roadmap.disclaimer', 'Disclaimer')}
                value={data.disclaimer || ''}
                onChange={v => onChange(set(data, 'disclaimer', v))}
                placeholder={t('cms_site.blocks.roadmap.this_page_describes_what_we_are', 'This page describes what we are working on, not what we promise to deliver or when.')}
                rows={2}
            />

            <BackgroundCard data={data} onChange={onChange} persistKey="blk.roadmap.background" />
        </>
    );
}
