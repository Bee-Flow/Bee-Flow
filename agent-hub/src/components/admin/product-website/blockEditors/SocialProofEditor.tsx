import React from 'react';
import { TextField, ImageField, IconField, RepeatableList } from '../fields';
import { InlineHint, CollapsibleCard } from '../primitives';
import type { BlockEditorProps } from './editorProps';
import { set, SectionHeaderFields, LogoTintControl } from './shared';
import type { SectionHeaderData } from './shared';
import VariantPicker from './VariantPicker';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Social Proof ──────────────────────────────────────────────────────

type SocialProofStat = { number?: string; label?: string };
type SocialProofChip = { label?: string; icon?: string };
type SocialProofLogo = { src?: string; alt?: string };
type SocialProofData = SectionHeaderData & {
    variant?: string;
    stats?: SocialProofStat[];
    chips?: SocialProofChip[];
    logos?: SocialProofLogo[];
    logoTint?: number;
};

export function SocialProofEditor({ data = {}, onChange }: BlockEditorProps<SocialProofData>) {

    const { t } = useTranslation();
    const variant = (['numbers', 'stats', 'chips'] as (string | undefined)[]).includes(data.variant) ? data.variant : 'classic';
    const showNumbers = variant === 'numbers' || variant === 'stats';
    const showLogos = variant === 'classic' || variant === 'numbers';
    // Eyebrow + Title (style controls + text fields) come from the
    // shared header helper. Social Proof has no `lead`, so showLead
    // is disabled — the helper skips that subsection entirely.
    return (
        <>
            <VariantPicker
                type="socialProof"
                value={data.variant}
                onChange={(v: string) => onChange(set(data, 'variant', v))}
            />
            <InlineHint>{t('cms_site.blocks.social_proof.click_the_eyebrow_and_title_text', 'Click the eyebrow and title text in the preview to edit them inline. Style each independently below.')}</InlineHint>

            <SectionHeaderFields data={data} onChange={onChange} showLead={false} persistScope="socialProof" />

            {/* ── Hard numbers (variants 'numbers' and 'stats') ─── */}
            {showNumbers ? (
                <CollapsibleCard title={t('cms_site.blocks.social_proof.numbers_count', 'Numbers ({count})', { count: (data.stats || []).length })} defaultOpen persistKey="blk.socialProof.stats">
                    <InlineHint>{t('cms_site.blocks.social_proof.quantified_proof_beats_adjectives_stars_users', 'Quantified proof beats adjectives: stars, users, uptime — with the source as the label (e.g. “4.7★ / G2 rating”).')}</InlineHint>
                    <RepeatableList
                        label={t('cms_site.blocks.social_proof.numbers', 'Numbers')}
                        items={data.stats || []}
                        onChange={v => onChange(set(data, 'stats', v))}
                        makeNew={() => ({ number: '', label: '' })}
                        itemLabel={(item) => item.number || item.label || t('cms_site.blocks.social_proof.empty', '(empty)')}
                        renderItem={(item, update) => (
                            <>
                                <TextField label={t('cms_site.blocks.social_proof.number', 'Number')} value={item.number || ''} onChange={v => update({ ...item, number: v })} placeholder="12,000+" />
                                <TextField label={t('cms_site.blocks.social_proof.label', 'Label')} value={item.label || ''} onChange={v => update({ ...item, label: v })} placeholder={t('cms_site.blocks.social_proof.teams_on_bee_flow', 'Teams on Bee Flow')} />
                            </>
                        )}
                        addLabel={t('cms_site.blocks.social_proof.add_number', 'Add number')}
                    />
                </CollapsibleCard>
            ) : null}

            {/* ── Chips (variant 'chips') ─────────────────────── */}
            {variant === 'chips' ? (
                <CollapsibleCard title={t('cms_site.blocks.social_proof.chips_count', 'Chips ({count})', { count: (data.chips || []).length })} defaultOpen persistKey="blk.socialProof.chips">
                    <InlineHint>{t('cms_site.blocks.social_proof.chips_hint', 'Short, honest claims such as “EU-hosted”, “Open source” or “AES-256”. The icon is optional.')}</InlineHint>
                    <RepeatableList
                        label={t('cms_site.blocks.social_proof.chips', 'Chips')}
                        items={data.chips || []}
                        onChange={v => onChange(set(data, 'chips', v))}
                        makeNew={() => ({ label: '', icon: '' })}
                        itemLabel={(item) => item.label || t('cms_site.blocks.social_proof.empty', '(empty)')}
                        renderItem={(item, update) => (
                            <>
                                <TextField label={t('cms_site.blocks.social_proof.label', 'Label')} value={item.label || ''} onChange={v => update({ ...item, label: v })} placeholder={t('cms_site.blocks.social_proof.chip_placeholder', 'EU-hosted')} />
                                <IconField label={t('cms_site.blocks.social_proof.chip_icon', 'Icon (optional)')} value={item.icon} onChange={v => update({ ...item, icon: v })} />
                            </>
                        )}
                        addLabel={t('cms_site.blocks.social_proof.add_chip', 'Add chip')}
                    />
                </CollapsibleCard>
            ) : null}

            {/* ── Logos (variants 'classic' and 'numbers') ────── */}
            {showLogos ? (
                <CollapsibleCard title={t('cms_site.blocks.social_proof.logos_count', 'Logos ({count})', { count: (data.logos || []).length })} persistKey="blk.socialProof.logos">
                    <RepeatableList
                        label={t('cms_site.blocks.social_proof.logos', 'Logos')}
                        items={data.logos || []}
                        onChange={v => onChange(set(data, 'logos', v))}
                        makeNew={() => ({ src: '', alt: 'New logo' })}
                        itemLabel={(item) => item.alt}
                        renderItem={(item, update) => (
                            <>
                                <ImageField label={t('cms_site.blocks.social_proof.logo_image_optional', 'Logo image (optional)')} value={item.src} onChange={v => update({ ...item, src: v })} />
                                <TextField label={t('cms_site.blocks.social_proof.alt_text', 'Alt text')} value={item.alt || ''} onChange={v => update({ ...item, alt: v })} placeholder={t('cms_site.blocks.social_proof.used_as_the_logo_s_accessible', "Used as the logo's accessible name")} />
                            </>
                        )}
                        addLabel={t('cms_site.blocks.social_proof.add_logo', 'Add logo')}
                    />
                    <LogoTintControl
                        value={Number.isFinite(data.logoTint) ? data.logoTint : 0}
                        onChange={v => onChange(set(data, 'logoTint', v))}
                    />
                </CollapsibleCard>
            ) : null}
        </>
    );
}
