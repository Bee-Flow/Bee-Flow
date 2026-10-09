import React from 'react';
import { TextField, IconField, ImageField, RepeatableList, FieldRow, Toggle } from '../fields';
import { InlineHint, ColorSwatch, BackgroundCard, SegmentedControl } from '../primitives';
import { set, SectionHeaderFields, CardActionFields } from './shared';
import VariantPicker from './VariantPicker';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Features ──────────────────────────────────────────────────────────

export function FeaturesEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const isBento = data.variant === 'bento';
    return (
        <>
            <VariantPicker
                type="features"
                value={data.variant}
                onChange={v => onChange(set(data, 'variant', v))}
            />
            {isBento ? (
                <Toggle
                    label={t('cms_site.blocks.features.spotlight_hover', 'Spotlight hover')}
                    value={data.spotlight === true}
                    onChange={v => onChange(set(data, 'spotlight', v))}
                />
            ) : null}
            <InlineHint>{t('cms_site.blocks.features.eyebrow_title_lead_and_each_card', "Eyebrow, title, lead, and each card's title and body are editable in the preview.")}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="features" />
            <RepeatableList
                label={t('cms_site.blocks.features.feature_cards', 'Feature cards')}
                items={data.items || []}
                onChange={v => onChange(set(data, 'items', v))}
                makeNew={() => ({ icon: 'Sparkles', title: 'New feature', body: '', popupEmbed: '', cardAction: 'none', cardUrl: '', span: 1, media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' } })}
                itemLabel={(item) => item.title || t('cms_site.blocks.features.no_title', '(no title)')}
                // Deep-clone via JSON so future nested fields (e.g. a per-card
                // style sub-object) can't share references between the source
                // and its duplicate. Appending " (copy)" gives the user an
                // obvious visual cue for which card is the clone.
                duplicateItem={(item) => ({
                    ...JSON.parse(JSON.stringify(item)),
                    title: `${item.title || 'Feature'} (copy)`,
                })}
                renderItem={(item, update) => (
                    <>
                        {isBento ? (
                            <>
                                <FieldRow label={t('cms_site.blocks.features.card_width', 'Card width')} hint={t('cms_site.blocks.features.wide_cards_anchor_the_bento_grid', 'Wide cards anchor the bento grid — usually just the first one.')}>
                                    <SegmentedControl
                                        value={Number(item.span) === 2 ? '2' : '1'}
                                        onChange={v => update({ ...item, span: Number(v) })}
                                        options={[
                                            { value: '1', label: t('cms_site.blocks.features.width_normal', 'Normal') },
                                            { value: '2', label: t('cms_site.blocks.features.width_wide', 'Wide') },
                                        ]}
                                    />
                                </FieldRow>
                                <FieldRow label={t('cms_site.blocks.features.card_media', 'Card media')} hint={t('cms_site.blocks.features.a_ui_fragment_or_mini_diagram', 'A UI fragment or mini-diagram turns an icon card into a product card.')}>
                                    <ImageField
                                        value={item.media?.src || ''}
                                        onChange={v => update({ ...item, media: { ...(item.media || {}), src: v, frame: item.media?.frame || 'hairline', kind: 'image' } })}
                                    />
                                </FieldRow>
                            </>
                        ) : null}
                        <IconField label={t('cms_site.blocks.features.icon', 'Icon')} value={item.icon} onChange={v => update({ ...item, icon: v })} />
                        {/* Card title + body — also inline-editable in the
                            preview, but the editor needs explicit inputs so
                            users can fill them in before the card is
                            rendered (newly added cards start empty and
                            have nothing to click in the preview). */}
                        <TextField
                            label={t('cms_site.blocks.features.title', 'Title')}
                            value={item.title || ''}
                            onChange={v => update({ ...item, title: v })}
                            placeholder={t('cms_site.blocks.features.feature_title', 'Feature title')}
                            align={item.titleAlign || 'left'}
                            onAlignChange={v => update({ ...item, titleAlign: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.features.body', 'Body')}
                            value={item.body ?? item.description ?? ''}
                            onChange={v => update({ ...item, body: v })}
                            placeholder={t('cms_site.blocks.features.describe_this_feature', 'Describe this feature')}
                            align={item.bodyAlign || 'left'}
                            onAlignChange={v => update({ ...item, bodyAlign: v })}
                        />
                        {/* Per-card text colors. Single hex string, no
                            sub-object — matches the spec for these two
                            fields specifically. Empty = inherit. */}
                        <FieldRow label={t('cms_site.blocks.features.title_color', 'Title color')}>
                            <ColorSwatch
                                value={item.titleColor || ''}
                                onChange={v => update({ ...item, titleColor: v })}
                                title={t('cms_site.blocks.features.card_title_color', 'Card title color')}
                            />
                        </FieldRow>
                        <FieldRow label={t('cms_site.blocks.features.body_color', 'Body color')}>
                            <ColorSwatch
                                value={item.bodyColor || ''}
                                onChange={v => update({ ...item, bodyColor: v })}
                                title={t('cms_site.blocks.features.card_body_color', 'Card body color')}
                            />
                        </FieldRow>
                        {/* Card action — none/link/popup. Drives the
                            renderer's per-card behaviour: link wraps the
                            card in an <a>; popup opens a modal with a
                            sandboxed iframe; none leaves the card static. */}
                        <CardActionFields item={item} update={update} />
                    </>
                )}
                addLabel={t('cms_site.blocks.features.add_card', 'Add card')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.features.background" />
        </>
    );
}
