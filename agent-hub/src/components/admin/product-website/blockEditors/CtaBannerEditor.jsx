import React from 'react';
import { TextField, Toggle } from '../fields';
import {
    InlineHint,
    CollapsibleCard,
    StyleTriplet,
    FieldSelect,
    BackgroundVariantSelect,
} from '../primitives';
import { set, CtaButtonField } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── CTA Banner ───────────────────────────────────────────────────────

export function CtaBannerEditor({ data = {}, pages = [], onChange }) {
    const { t } = useTranslation();
    const setField = (key, value) => onChange(set(data, key, value));
    const primary  = data.primaryCta || { label: '', link: { kind: 'external', url: '' } };
    const showSecondary = !!data.secondaryCta;

    const toggleSecondary = (next) => setField('secondaryCta',
        next ? { label: 'Learn more', link: { kind: 'anchor', anchor: '' } } : null);

    return (
        <>
            <InlineHint>{t('cms_site.blocks.cta_banner.click_heading_and_subheading_in_the', 'Click heading and subheading in the preview to edit inline.')}</InlineHint>

            <CollapsibleCard title={t('cms_site.blocks.cta_banner.text', 'Text')} defaultOpen={true} persistKey="blk.cta-banner.text">
                <TextField
                    label={t('cms_site.blocks.cta_banner.heading', 'Heading')}
                    value={data.heading || ''}
                    onChange={v => setField('heading', v)}
                    placeholder={t('cms_site.blocks.cta_banner.heading', 'Heading')}
                    align={data.headingAlign || data.align || 'left'}
                    onAlignChange={v => setField('headingAlign', v)}
                />
                <TextField
                    label={t('cms_site.blocks.cta_banner.subheading', 'Subheading')}
                    value={data.subheading || ''}
                    onChange={v => setField('subheading', v)}
                    placeholder={t('cms_site.blocks.cta_banner.subheading', 'Subheading')}
                    align={data.subheadingAlign || data.align || 'left'}
                    onAlignChange={v => setField('subheadingAlign', v)}
                />
            </CollapsibleCard>

            <FieldSelect
                label={t('cms_site.blocks.cta_banner.layout', 'Layout')}
                value={data.layout || 'centered'}
                options={[
                    { value: 'centered', label: t('cms_site.blocks.cta_banner.layout_centered', 'Centered') },
                    { value: 'split',    label: t('cms_site.blocks.cta_banner.layout_split', 'Split (heading left, CTAs right)') },
                ]}
                onChange={v => setField('layout', v)}
            />

            <BackgroundVariantSelect
                label={t('cms_site.blocks.cta_banner.background', 'Background')}
                value={data.backgroundVariant || 'primary'}
                onChange={v => setField('backgroundVariant', v)}
            />

            <CollapsibleCard title={t('cms_site.blocks.cta_banner.primary_cta', 'Primary CTA')} persistKey="blk.cta-banner.primary-cta">
                <CtaButtonField
                    value={primary}
                    pages={pages}
                    onChange={v => setField('primaryCta', v)}
                    label={t('cms_site.blocks.cta_banner.primary_cta', 'Primary CTA')}
                />
            </CollapsibleCard>

            <Toggle label={t('cms_site.blocks.cta_banner.show_secondary_cta', 'Show secondary CTA')} value={showSecondary} onChange={toggleSecondary} />

            {showSecondary ? (
                <CollapsibleCard title={t('cms_site.blocks.cta_banner.secondary_cta', 'Secondary CTA')} persistKey="blk.cta-banner.secondary-cta">
                    <CtaButtonField
                        value={data.secondaryCta || {}}
                        pages={pages}
                        onChange={v => setField('secondaryCta', v)}
                        label={t('cms_site.blocks.cta_banner.secondary_cta', 'Secondary CTA')}
                    />
                </CollapsibleCard>
            ) : null}

            {/* Text styles — heading + subheading only (CTA Banner has
                no body paragraph; its text is just headline + tagline). */}
            <CollapsibleCard title={t('cms_site.blocks.cta_banner.text_styles', 'Text styles')} defaultOpen={false} persistKey="blk.cta-banner.text-styles">
                <StyleTriplet
                    label={t('cms_site.blocks.cta_banner.heading', 'Heading')}
                    value={data.headingStyle}
                    onChange={v => setField('headingStyle', v)}
                    sample={data.heading || t('cms_site.blocks.cta_banner.heading_preview', 'Heading preview')}
                    weight={700}
                    min={12} max={96}
                />
                <StyleTriplet
                    label={t('cms_site.blocks.cta_banner.subheading', 'Subheading')}
                    value={data.subheadingStyle}
                    onChange={v => setField('subheadingStyle', v)}
                    sample={data.subheading || t('cms_site.blocks.cta_banner.subheading_preview', 'Subheading preview')}
                    weight={500}
                    min={10} max={48}
                />
            </CollapsibleCard>
        </>
    );
}
