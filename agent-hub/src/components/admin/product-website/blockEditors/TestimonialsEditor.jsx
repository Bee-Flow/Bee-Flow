import React from 'react';
import { TextField, ImageField, RepeatableList, FieldRow } from '../fields';
import { InlineHint, BackgroundCard } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import VariantPicker from './VariantPicker';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Testimonials ──────────────────────────────────────────────────────
//
// Quantified social proof: name + role + company always, optional metric
// per item ('case' layout leads with it), NEVER star ratings. 'spotlight'
// renders only the first item — oversized photo (avatarSrc) + quote.

export function TestimonialsEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const isCase = data.variant === 'case';
    const isSpotlight = data.variant === 'spotlight';
    return (
        <>
            <VariantPicker
                type="testimonials"
                value={data.variant}
                onChange={v => onChange(set(data, 'variant', v))}
            />
            <InlineHint>
                {t('cms_site.blocks.testimonials.quotes_names_roles_and_companies_are', 'Quotes, names, roles and companies are editable in the preview.')}
                {isSpotlight ? ' ' + t('cms_site.blocks.testimonials.spotlight_shows_only_the_first_testimonial', 'Spotlight shows only the first testimonial — give it a large photo.') : ''}
                {isCase ? ' ' + t('cms_site.blocks.testimonials.case_cards_lead_with_the_metric', 'Case cards lead with the metric — a hard number sells better than adjectives.') : ''}
            </InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} showLead={false} persistScope="testimonials" />
            <RepeatableList
                label={t('cms_site.blocks.testimonials.testimonials', 'Testimonials')}
                items={data.items || []}
                onChange={v => onChange(set(data, 'items', v))}
                makeNew={() => ({ quote: '', name: '', role: '', company: '', avatarSrc: '', logoSrc: '', metric: { number: '', label: '' } })}
                itemLabel={(item) => item.name || t('cms_site.blocks.testimonials.no_name', '(no name)')}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.testimonials.quote', 'Quote')}
                            value={item.quote || ''}
                            onChange={v => update({ ...item, quote: v })}
                            placeholder={t('cms_site.blocks.testimonials.what_did_they_say', 'What did they say?')}
                        />
                        <TextField
                            label={t('cms_site.blocks.testimonials.name', 'Name')}
                            value={item.name || ''}
                            onChange={v => update({ ...item, name: v })}
                            placeholder={t('cms_site.blocks.testimonials.jane_jansen', 'Jane Jansen')}
                        />
                        <TextField
                            label={t('cms_site.blocks.testimonials.role', 'Role')}
                            value={item.role || ''}
                            onChange={v => update({ ...item, role: v })}
                            placeholder={t('cms_site.blocks.testimonials.head_of_operations', 'Head of Operations')}
                        />
                        <TextField
                            label={t('cms_site.blocks.testimonials.company', 'Company')}
                            value={item.company || ''}
                            onChange={v => update({ ...item, company: v })}
                            placeholder={t('cms_site.blocks.testimonials.company_name', 'Company name')}
                        />
                        <FieldRow
                            label={t('cms_site.blocks.testimonials.photo', 'Photo')}
                            hint={isSpotlight
                                ? t('cms_site.blocks.testimonials.photo_hint_spotlight', 'The spotlight layout renders this large — use a real photo, landscape or square.')
                                : t('cms_site.blocks.testimonials.photo_hint_default', 'Shown as a 28px round avatar; empty = an initial chip.')}
                        >
                            <ImageField
                                value={item.avatarSrc || ''}
                                onChange={v => update({ ...item, avatarSrc: v })}
                            />
                        </FieldRow>
                        <FieldRow label={t('cms_site.blocks.testimonials.company_logo', 'Company logo')} hint={t('cms_site.blocks.testimonials.optional_rendered_small_and_monochrome_next', 'Optional — rendered small and monochrome next to the attribution.')}>
                            <ImageField
                                value={item.logoSrc || ''}
                                onChange={v => update({ ...item, logoSrc: v })}
                            />
                        </FieldRow>
                        {isCase ? (
                            <>
                                <TextField
                                    label={t('cms_site.blocks.testimonials.metric', 'Metric')}
                                    value={item.metric?.number || ''}
                                    onChange={v => update({ ...item, metric: { ...(item.metric || {}), number: v } })}
                                    placeholder="2.4×"
                                />
                                <TextField
                                    label={t('cms_site.blocks.testimonials.metric_label', 'Metric label')}
                                    value={item.metric?.label || ''}
                                    onChange={v => update({ ...item, metric: { ...(item.metric || {}), label: v } })}
                                    placeholder={t('cms_site.blocks.testimonials.faster_reporting', 'faster reporting')}
                                />
                            </>
                        ) : null}
                    </>
                )}
                addLabel={t('cms_site.blocks.testimonials.add_testimonial', 'Add testimonial')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.testimonials.background" />
        </>
    );
}
