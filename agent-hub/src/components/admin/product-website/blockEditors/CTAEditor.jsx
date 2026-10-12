import React from 'react';
import { TextField, Toggle } from '../fields';
import { InlineHint, CollapsibleCard, BackgroundCard } from '../primitives';
import { set, CtaButtonField } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── CTA ───────────────────────────────────────────────────────────────

export function CTAEditor({ data = {}, pages = [], onChange }) {
    const { t } = useTranslation();
    const button = data.button || {};
    const hasSecondary = !!data.secondaryCta;
    return (
        <>
            <InlineHint>{t('cms_site.blocks.cta.title_lead_and_button_label_are', 'Title, lead, and button label are editable in the preview.')}</InlineHint>
            <Toggle
                label={t('cms_site.blocks.cta.hexagon_motif_backdrop', 'Hexagon motif backdrop')}
                value={data.showMotif !== false}
                onChange={v => onChange(set(data, 'showMotif', v))}
            />
            <CollapsibleCard title={t('cms_site.blocks.cta.text', 'Text')} defaultOpen={true} persistKey="blk.cta.text">
                <TextField
                    label={t('cms_site.blocks.cta.title', 'Title')}
                    value={data.title || ''}
                    onChange={v => onChange(set(data, 'title', v))}
                    placeholder={t('cms_site.blocks.cta.call_to_action_title', 'Call to action title')}
                    align={data.titleAlign || data.align || 'left'}
                    onAlignChange={v => onChange(set(data, 'titleAlign', v))}
                />
                <TextField
                    label={t('cms_site.blocks.cta.lead', 'Lead')}
                    value={data.lead || ''}
                    onChange={v => onChange(set(data, 'lead', v))}
                    placeholder={t('cms_site.blocks.cta.supporting_line', 'Supporting line')}
                    align={data.leadAlign || data.align || 'left'}
                    onAlignChange={v => onChange(set(data, 'leadAlign', v))}
                />
            </CollapsibleCard>
            <CtaButtonField
                value={button}
                pages={pages}
                onChange={v => onChange(set(data, 'button', v))}
                label={t('cms_site.blocks.cta.button', 'Button')}
            />
            <CollapsibleCard title={t('cms_site.blocks.cta.secondary_button_ghost', 'Secondary button (ghost)')} persistKey="blk.cta.secondary">
                <Toggle
                    label={t('cms_site.blocks.cta.show_secondary_button', 'Show secondary button')}
                    value={hasSecondary}
                    onChange={v => onChange(set(data, 'secondaryCta',
                        v ? { label: 'Learn more', link: { kind: 'anchor', anchor: '' } } : null))}
                />
                {hasSecondary ? (
                    <CtaButtonField
                        value={data.secondaryCta}
                        pages={pages}
                        onChange={v => onChange(set(data, 'secondaryCta', v))}
                        label={t('cms_site.blocks.cta.secondary_button', 'Secondary button')}
                    />
                ) : null}
            </CollapsibleCard>
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.cta.background" />
        </>
    );
}
