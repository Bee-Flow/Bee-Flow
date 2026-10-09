import React from 'react';
import { TextField, IconField, RepeatableList } from '../fields';
import { InlineHint, BackgroundCard } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import VariantPicker from './VariantPicker';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Trust band ────────────────────────────────────────────────────────
//
// Monochrome institutional chips (GDPR / zero-knowledge / fair-code
// register). 'chips' hides sublabels; 'detailed' grows each chip into a
// small card that shows them. A chip with a link renders as an external
// link (new tab) — point it at something verifiable.

export function TrustBandEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const detailed = data.variant === 'detailed';
    return (
        <>
            <VariantPicker
                type="trust-band"
                value={data.variant}
                onChange={v => onChange(set(data, 'variant', v))}
            />
            <InlineHint>
                {detailed
                    ? t('cms_site.blocks.trust_band.chip_labels_and_sublabels_are_editable', 'Chip labels and sublabels are editable in the preview.')
                    : t('cms_site.blocks.trust_band.chip_labels_are_editable_sublabels_hidden', 'Chip labels are editable in the preview. Sublabels stay hidden on this layout — switch to Detailed to show them.')}
            </InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} showLead={false} persistScope="trust-band" />
            <RepeatableList
                label={t('cms_site.blocks.trust_band.chips', 'Chips')}
                items={data.chips || []}
                onChange={v => onChange(set(data, 'chips', v))}
                makeNew={() => ({ icon: 'BadgeCheck', label: 'New claim', sublabel: '', href: '' })}
                itemLabel={(item) => item.label || t('cms_site.blocks.trust_band.no_label', '(no label)')}
                renderItem={(item, update) => (
                    <>
                        <IconField
                            label={t('cms_site.blocks.trust_band.icon', 'Icon')}
                            value={item.icon}
                            onChange={v => update({ ...item, icon: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.trust_band.label', 'Label')}
                            value={item.label || ''}
                            onChange={v => update({ ...item, label: v })}
                            placeholder={t('cms_site.blocks.trust_band.gdpr_compliant', 'GDPR-compliant')}
                        />
                        <TextField
                            label={t('cms_site.blocks.trust_band.sublabel', 'Sublabel')}
                            value={item.sublabel || ''}
                            onChange={v => update({ ...item, sublabel: v })}
                            placeholder={t('cms_site.blocks.trust_band.eu_data_residency', 'EU data residency')}
                        />
                        <TextField
                            label={t('cms_site.blocks.trust_band.link', 'Link')}
                            value={item.href || ''}
                            onChange={v => update({ ...item, href: v })}
                            placeholder="https://…"
                            hint={t('cms_site.blocks.trust_band.optional_a_linked_claim_opens_in', 'Optional — a linked claim opens in a new tab. Link to something verifiable.')}
                        />
                    </>
                )}
                addLabel={t('cms_site.blocks.trust_band.add_chip', 'Add chip')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.trust-band.background" />
        </>
    );
}
