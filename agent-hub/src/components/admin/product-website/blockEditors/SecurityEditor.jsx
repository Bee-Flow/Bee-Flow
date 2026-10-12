import React from 'react';
import { TextField, IconField, RepeatableList } from '../fields';
import { InlineHint, BackgroundCard } from '../primitives';
import { set, SectionHeaderFields, CardActionFields } from './shared';
import VariantPicker from './VariantPicker';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Security ──────────────────────────────────────────────────────────

export function SecurityEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const isLedger = data.variant === 'ledger';
    return (
        <>
            <VariantPicker
                type="security"
                value={data.variant}
                onChange={v => onChange(set(data, 'variant', v))}
            />
            <InlineHint>{t('cms_site.blocks.security.click_any_card_s_title_summary', "Click any card's title, summary, or detail bullet to edit.")}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="security" />
            <RepeatableList
                label={t('cms_site.blocks.security.security_cards', 'Security cards')}
                items={data.cards || []}
                onChange={v => onChange(set(data, 'cards', v))}
                makeNew={() => ({ icon: 'ShieldCheck', title: 'New card', summary: '', details: [], link: { label: '', href: '' }, cardAction: 'none', cardUrl: '', popupEmbed: '' })}
                itemLabel={(item) => item.title || t('cms_site.blocks.security.no_title', '(no title)')}
                renderItem={(item, update) => (
                    <>
                        <IconField label={t('cms_site.blocks.security.icon', 'Icon')} value={item.icon} onChange={v => update({ ...item, icon: v })} />
                        <TextField
                            label={t('cms_site.blocks.security.title', 'Title')}
                            value={item.title || ''}
                            onChange={v => update({ ...item, title: v })}
                            placeholder={t('cms_site.blocks.security.card_title', 'Card title')}
                            align={item.titleAlign || 'left'}
                            onAlignChange={v => update({ ...item, titleAlign: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.security.summary', 'Summary')}
                            value={item.summary || ''}
                            onChange={v => update({ ...item, summary: v })}
                            placeholder={t('cms_site.blocks.security.short_summary', 'Short summary')}
                            align={item.summaryAlign || 'left'}
                            onAlignChange={v => update({ ...item, summaryAlign: v })}
                        />
                        <RepeatableList
                            label={t('cms_site.blocks.security.detail_bullets', 'Detail bullets')}
                            items={item.details || []}
                            onChange={v => update({ ...item, details: v })}
                            makeNew={() => 'New detail'}
                            renderItem={(detail, updateDetail) => (
                                // Detail bullets are bare strings in the
                                // array — update(newString) replaces the
                                // string in place at this index.
                                <TextField
                                    label={t('cms_site.blocks.security.text', 'Text')}
                                    value={detail || ''}
                                    onChange={updateDetail}
                                    placeholder={t('cms_site.blocks.security.bullet_text', 'Bullet text')}
                                />
                            )}
                            addLabel={t('cms_site.blocks.security.add_detail', 'Add detail')}
                        />
                        {/* Verifiable link — rendered as "→ label" on the
                            ledger row (Ledger layout only; the classic card
                            grid ignores it). */}
                        {isLedger ? (
                            <>
                                <TextField
                                    label={t('cms_site.blocks.security.link_label', 'Link label')}
                                    value={item.link?.label || ''}
                                    onChange={v => update({ ...item, link: { ...(item.link || {}), label: v } })}
                                    placeholder={t('cms_site.blocks.security.e_g_read_the_security_whitepaper', 'e.g. Read the security whitepaper')}
                                />
                                <TextField
                                    label={t('cms_site.blocks.security.link_url', 'Link URL')}
                                    value={item.link?.href || ''}
                                    onChange={v => update({ ...item, link: { ...(item.link || {}), href: v } })}
                                    placeholder="https://…"
                                />
                            </>
                        ) : null}
                        {/* Card action — same toggle as the Features block.
                            none/link/popup drives the renderer's per-card
                            behaviour: link wraps in an <a>; popup opens a
                            sandboxed iframe modal; none leaves the card
                            static. */}
                        <CardActionFields item={item} update={update} />
                    </>
                )}
                addLabel={t('cms_site.blocks.security.add_card', 'Add card')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.security.background" />
        </>
    );
}
