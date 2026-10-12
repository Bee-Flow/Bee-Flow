import React from 'react';
import { TextField, RepeatableList } from '../fields';
import { InlineHint, StyleTriplet, BackgroundCard } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Tech Stats ────────────────────────────────────────────────────────

export function TechStatsEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.tech_stats.click_any_number_or_label_in', 'Click any number or label in the preview to edit.')}</InlineHint>
            {/* Stats blocks don't store a `lead` field — skip that subsection. */}
            <SectionHeaderFields data={data} onChange={onChange} showLead={false} persistScope="techStats" />
            <RepeatableList
                label={t('cms_site.blocks.tech_stats.stats', 'Stats')}
                items={data.stats || []}
                onChange={v => onChange(set(data, 'stats', v))}
                makeNew={() => ({ number: '0', label: 'New metric' })}
                itemLabel={(item) => item.label || t('cms_site.blocks.tech_stats.no_label', '(no label)')}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.tech_stats.number', 'Number')}
                            value={item.number || ''}
                            onChange={v => update({ ...item, number: v })}
                            placeholder="e.g. 99%"
                            align={item.numberAlign || 'left'}
                            onAlignChange={v => update({ ...item, numberAlign: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.tech_stats.label', 'Label')}
                            value={item.label || ''}
                            onChange={v => update({ ...item, label: v })}
                            placeholder={t('cms_site.blocks.tech_stats.e_g_uptime', 'e.g. Uptime')}
                            align={item.labelAlign || 'left'}
                            onAlignChange={v => update({ ...item, labelAlign: v })}
                        />
                        {/* Per-stat number typography. The big number is
                            the visual centrepiece of a stat; lets users
                            scale + colour it independently of the label. */}
                        <StyleTriplet
                            label={t('cms_site.blocks.tech_stats.number_style', 'Number style')}
                            value={item.numberStyle}
                            onChange={v => update({ ...item, numberStyle: v })}
                            sample={item.number || '99%'}
                            weight={800}
                            min={16} max={160}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.tech_stats.add_stat', 'Add stat')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.techStats.background" />
        </>
    );
}
