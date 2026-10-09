import React from 'react';
import { TextField, Toggle, IconField, ImageField, RepeatableList, LinkField, FieldRow, AlignControl, inputCls } from '../fields';
import {
    InlineHint,
    CollapsibleCard,
    StyleTriplet,
    FieldSelect,
    CtaStyleSelect,
    BackgroundCard,
} from '../primitives';
import { set } from './shared';
import VariantPicker from './VariantPicker';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Hero ──────────────────────────────────────────────────────────────

export function HeroEditor({ data = {}, pages = [], onChange }) {
    const { t } = useTranslation();
    const badge       = data.badge       || {};
    const badgeStyle  = data.badgeStyle  || {};
    const titleStyle  = data.titleStyle  || {};
    const leadStyle   = data.leadStyle   || {};
    const primary     = data.primaryCta  || {};
    const secondary   = data.secondaryCta|| {};
    const mockup      = data.mockup      || {};
    const media       = data.media       || {};

    // Helpers — each one lets a card's contents read/write a sub-object
    // without re-implementing the spread on every onChange.
    const setBadge        = (patch) => onChange(set(data, 'badge',        { ...badge,       ...patch }));
    const setPrimary      = (patch) => onChange(set(data, 'primaryCta',   { ...primary,     ...patch }));
    const setSecondary    = (patch) => onChange(set(data, 'secondaryCta', { ...secondary,   ...patch }));
    const setMockup       = (patch) => onChange(set(data, 'mockup',       { ...mockup,      ...patch }));
    const setMedia        = (patch) => onChange(set(data, 'media',        { ...media,       ...patch }));

    const hasMedia = typeof media.src === 'string' && media.src.trim() !== '';

    // `enabled` defaults to true for old blocks that never stored the
    // field, so the toggles all start in the "on" position.
    const badgeOn     = badge.enabled     !== false;
    const leadOn      = data.leadEnabled  !== false;
    const primaryOn   = primary.enabled   !== false;
    const secondaryOn = secondary.enabled !== false;
    const mockupOn    = mockup.enabled    !== false;

    return (
        <>
            <VariantPicker
                type="hero"
                value={data.variant}
                onChange={v => onChange(set(data, 'variant', v))}
            />
            <InlineHint>{t('cms_site.blocks.hero.click_the_badge_title_segments_lead', 'Click the badge, title segments, lead, CTA labels, and chat bubbles in the preview to edit them inline. Use the panels below for structure and styling.')}</InlineHint>

            {/* ── Product media ───────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.hero.product_media', 'Product media')} defaultOpen={true} persistKey="blk.hero.media">
                <InlineHint>{t('cms_site.blocks.hero.a_real_product_screenshot_in_a', 'A real product screenshot in a framed panel is the single biggest visual upgrade. When empty, the chat mockup (below) or a skeleton panel renders instead.')}</InlineHint>
                <FieldRow label={t('cms_site.blocks.hero.image', 'Image')} hint={t('cms_site.blocks.hero.2x_screenshot_recommended_shown_framed_with', '2x screenshot recommended; shown framed with a hairline border and glow.')}>
                    <ImageField value={media.src || ''} onChange={v => setMedia({ src: v })} />
                </FieldRow>
                <FieldRow label={t('cms_site.blocks.hero.dark_theme_image', 'Dark-theme image')} hint={t('cms_site.blocks.hero.optional_shown_instead_of_the_image', 'Optional. Shown instead of the image above while the site is in dark mode.')}>
                    <ImageField value={media.srcDark || ''} onChange={v => setMedia({ srcDark: v })} />
                </FieldRow>
                <TextField
                    label={t('cms_site.blocks.hero.alt_text', 'Alt text')}
                    value={media.alt || ''}
                    onChange={v => setMedia({ alt: v })}
                    placeholder={t('cms_site.blocks.hero.describe_the_screenshot', 'Describe the screenshot')}
                />
                <FieldSelect
                    label={t('cms_site.blocks.hero.frame', 'Frame')}
                    value={media.frame || 'browser'}
                    options={[
                        { value: 'browser', label: t('cms_site.blocks.hero.frame_browser', 'Browser window') },
                        { value: 'hairline', label: t('cms_site.blocks.hero.frame_hairline', 'Hairline only') },
                        { value: 'none', label: t('cms_site.blocks.hero.frame_none', 'No frame') },
                    ]}
                    onChange={v => setMedia({ frame: v })}
                />
            </CollapsibleCard>

            {/* ── Badge ───────────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.hero.badge', 'Badge')} defaultOpen={true} persistKey="blk.hero.badge">
                <Toggle
                    label={t('cms_site.blocks.hero.show_badge', 'Show badge')}
                    value={badgeOn}
                    onChange={v => setBadge({ enabled: v })}
                />
                {badgeOn ? (
                    <>
                        <TextField
                            label={t('cms_site.blocks.hero.text', 'Text')}
                            value={badge.text || ''}
                            onChange={v => setBadge({ text: v })}
                            placeholder={t('cms_site.blocks.hero.e_g_new_v2_0', 'e.g. New · v2.0')}
                            align={data.badgeAlign || data.align || 'left'}
                            onAlignChange={v => onChange(set(data, 'badgeAlign', v))}
                        />
                        <IconField
                            label={t('cms_site.blocks.hero.icon', 'Icon')}
                            value={badge.icon}
                            onChange={v => setBadge({ icon: v })}
                        />
                        <StyleTriplet
                            label={t('cms_site.blocks.hero.badge', 'Badge')}
                            value={badgeStyle}
                            onChange={v => onChange(set(data, 'badgeStyle', v))}
                            sample={t('cms_site.blocks.hero.new_just_shipped', 'New · just shipped')}
                            weight={500}
                            min={8} max={48}
                        />
                    </>
                ) : null}
            </CollapsibleCard>

            {/* ── Headline ────────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.hero.headline', 'Headline')} persistKey="blk.hero.headline">
                <RepeatableList
                    label={t('cms_site.blocks.hero.title_segments', 'Title segments')}
                    items={data.titleParts || []}
                    onChange={v => onChange(set(data, 'titleParts', v))}
                    makeNew={() => ({ text: '', gradient: false })}
                    itemLabel={(it) => it.text || t('cms_site.blocks.hero.empty_segment', '(empty segment)')}
                    collapsible
                    renderItem={(item, update) => (
                        <>
                            <TextField
                                label={t('cms_site.blocks.hero.text', 'Text')}
                                value={item.text || ''}
                                onChange={v => update({ ...item, text: v })}
                                placeholder={t('cms_site.blocks.hero.segment_text', 'Segment text')}
                            />
                            <Toggle
                                label={t('cms_site.blocks.hero.gradient_fill', 'Gradient fill')}
                                value={!!item.gradient}
                                onChange={v => update({ ...item, gradient: v })}
                            />
                        </>
                    )}
                    addLabel={t('cms_site.blocks.hero.add_segment', 'Add segment')}
                />
                <FieldRow label={t('cms_site.blocks.hero.alignment', 'Alignment')}>
                    <AlignControl
                        value={data.titleAlign || data.align || 'left'}
                        onChange={v => onChange(set(data, 'titleAlign', v))}
                    />
                </FieldRow>
                <StyleTriplet
                    label={t('cms_site.blocks.hero.title', 'Title')}
                    value={titleStyle}
                    onChange={v => onChange(set(data, 'titleStyle', v))}
                    sample={t('cms_site.blocks.hero.the_quick_brown_fox_jumps', 'The quick brown fox jumps')}
                    weight={800}
                    min={16} max={160}
                />
            </CollapsibleCard>

            {/* ── Lead ────────────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.hero.lead_paragraph', 'Lead paragraph')} persistKey="blk.hero.lead">
                <Toggle
                    label={t('cms_site.blocks.hero.show_lead', 'Show lead')}
                    value={leadOn}
                    onChange={v => onChange(set(data, 'leadEnabled', v))}
                />
                {leadOn ? (
                    <>
                        <TextField
                            label={t('cms_site.blocks.hero.text', 'Text')}
                            value={data.lead || ''}
                            onChange={v => onChange(set(data, 'lead', v))}
                            placeholder={t('cms_site.blocks.hero.short_paragraph_below_the_headline', 'Short paragraph below the headline.')}
                            align={data.leadAlign || data.align || 'left'}
                            onAlignChange={v => onChange(set(data, 'leadAlign', v))}
                        />
                        <StyleTriplet
                            label={t('cms_site.blocks.hero.lead', 'Lead')}
                            value={leadStyle}
                            onChange={v => onChange(set(data, 'leadStyle', v))}
                            sample={t('cms_site.blocks.hero.the_quick_brown_fox_jumps_over', 'The quick brown fox jumps over the lazy dog.')}
                            weight={400}
                            min={12} max={48}
                        />
                    </>
                ) : null}
            </CollapsibleCard>

            {/* ── Primary CTA ─────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.hero.primary_cta', 'Primary CTA')} persistKey="blk.hero.primary-cta">
                <Toggle
                    label={t('cms_site.blocks.hero.show_primary_cta', 'Show primary CTA')}
                    value={primaryOn}
                    onChange={v => setPrimary({ enabled: v })}
                />
                {primaryOn ? (
                    <>
                        <TextField
                            label={t('cms_site.blocks.hero.label', 'Label')}
                            value={primary.label || ''}
                            onChange={v => setPrimary({ label: v })}
                            placeholder={t('cms_site.blocks.hero.get_started', 'Get started')}
                        />
                        <LinkField
                            label={t('cms_site.blocks.hero.destination', 'Destination')}
                            value={primary.link}
                            pages={pages}
                            onChange={v => setPrimary({ link: v })}
                        />
                        <CtaStyleSelect
                            value={primary.style || 'primary'}
                            onChange={v => setPrimary({ style: v })}
                        />
                    </>
                ) : null}
            </CollapsibleCard>

            {/* ── Secondary CTA ───────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.hero.secondary_cta', 'Secondary CTA')} persistKey="blk.hero.secondary-cta">
                <Toggle
                    label={t('cms_site.blocks.hero.show_secondary_cta', 'Show secondary CTA')}
                    value={secondaryOn}
                    onChange={v => setSecondary({ enabled: v })}
                />
                {secondaryOn ? (
                    <>
                        <TextField
                            label={t('cms_site.blocks.hero.label', 'Label')}
                            value={secondary.label || ''}
                            onChange={v => setSecondary({ label: v })}
                            placeholder={t('cms_site.blocks.hero.learn_more', 'Learn more')}
                        />
                        <LinkField
                            label={t('cms_site.blocks.hero.destination', 'Destination')}
                            value={secondary.link}
                            pages={pages}
                            onChange={v => setSecondary({ link: v })}
                        />
                        <CtaStyleSelect
                            value={secondary.style || 'secondary'}
                            onChange={v => setSecondary({ style: v })}
                        />
                    </>
                ) : null}
            </CollapsibleCard>

            {/* ── Mockup ──────────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.hero.chat_mockup_fallback', 'Chat mockup (fallback)')} persistKey="blk.hero.mockup">
                {hasMedia ? (
                    <InlineHint>{t('cms_site.blocks.hero.a_product_image_is_set_above', 'A product image is set above, so the chat mockup is not shown. Clear the image to bring it back.')}</InlineHint>
                ) : null}
                <Toggle
                    label={t('cms_site.blocks.hero.show_mockup', 'Show mockup')}
                    value={mockupOn}
                    onChange={v => setMockup({ enabled: v })}
                />
                {mockupOn ? (
                    <RepeatableList
                        label={t('cms_site.blocks.hero.chat_bubbles', 'Chat bubbles')}
                        items={mockup.chatBubbles || []}
                        onChange={v => setMockup({ chatBubbles: v })}
                        makeNew={() => ({ role: 'user', text: '' })}
                        itemLabel={(b) => b.text || t('cms_site.blocks.hero.empty', '(empty)')}
                        collapsible
                        renderItem={(item, update) => (
                            <>
                                <FieldSelect
                                    label={t('cms_site.blocks.hero.speaker', 'Speaker')}
                                    value={item.role}
                                    options={[{ value: 'user', label: t('cms_site.blocks.hero.role_user', 'User') }, { value: 'ai', label: 'AI' }]}
                                    onChange={v => update({ ...item, role: v })}
                                />
                                <FieldRow label={t('cms_site.blocks.hero.text', 'Text')}>
                                    <textarea
                                        rows={2}
                                        className={inputCls + ' resize-y'}
                                        value={item.text || ''}
                                        onChange={e => update({ ...item, text: e.target.value })}
                                        placeholder={t('cms_site.blocks.hero.bubble_text', 'Bubble text')}
                                    />
                                </FieldRow>
                            </>
                        )}
                        addLabel={t('cms_site.blocks.hero.add_bubble', 'Add bubble')}
                    />
                ) : null}
            </CollapsibleCard>

            {/* ── Background ──────────────────────────────────────── */}
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.hero.background" />
        </>
    );
}
