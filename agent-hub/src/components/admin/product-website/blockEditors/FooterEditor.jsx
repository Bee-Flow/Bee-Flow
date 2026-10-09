import React from 'react';
import { TextField, Toggle, RepeatableList, LinkField, FieldRow } from '../fields';
import {
    InlineHint,
    CollapsibleCard,
    ColorSwatch,
    FontRow,
    FieldSelect,
    mintId,
} from '../primitives';
import { set } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Footer ────────────────────────────────────────────────────────────

export function FooterEditor({ data = {}, pages = [], onChange }) {
    const { t } = useTranslation();
    const themeSwitcherEnabled = !!data.themeSwitcher?.enabled;
    // Master footer-link styling. Sibling to columns/socials so it
    // applies across all footer link labels (both inside columns and
    // socials when wired). Matches the *Style naming used elsewhere.
    const linkStyle = data.linkStyle || {};
    const updateLinkStyle = (patch) => onChange(set(data, 'linkStyle', { ...linkStyle, ...patch }));

    return (
        <>
            <InlineHint>{t('cms_site.blocks.footer.brand_text_blurb_column_headings_link', 'Brand text, blurb, column headings, link labels, and copyright are editable in the preview.')}</InlineHint>

            {/* Outer "Footer" card wraps the entire editor body. The
                SectionDivider above (rendered by SiteChromeEditor) is
                redundant — flagged for cleanup in a follow-up pass. */}
            <CollapsibleCard title={t('cms_site.blocks.footer.footer', 'Footer')} defaultOpen={true} persistKey="blk.footer.main">
                <Toggle
                    label={t('cms_site.blocks.footer.show_theme_switcher', 'Show theme switcher')}
                    value={themeSwitcherEnabled}
                    onChange={v => onChange(set(data, 'themeSwitcher', { ...(data.themeSwitcher || {}), enabled: v }))}
                />
                <Toggle
                    label={t('cms_site.blocks.footer.show_en_nl_language_toggle', 'Show EN / NL language toggle')}
                    value={data.showLanguageSwitcher === true}
                    onChange={v => onChange(set(data, 'showLanguageSwitcher', v))}
                />
                <Toggle
                    label={t('cms_site.blocks.footer.show_dot_after_brand_name', 'Show "." after brand name')}
                    value={data.showBrandDot === true}
                    onChange={v => onChange(set(data, 'showBrandDot', v))}
                />

                {/* ── Master link style (no per-link overrides) ─── */}
                <CollapsibleCard title={t('cms_site.blocks.footer.link_style', 'Link style')} persistKey="blk.footer.link-style">
                    <FontRow
                        label={t('cms_site.blocks.footer.link_font', 'Link font')}
                        value={linkStyle.fontFamily || ''}
                        onChange={v => updateLinkStyle({ fontFamily: v })}
                        sample={t('cms_site.blocks.footer.pricing_docs_blog', 'Pricing  ·  Docs  ·  Blog')}
                        weight={500}
                    />
                    <FieldRow label={t('cms_site.blocks.footer.link_color', 'Link color')}>
                        <ColorSwatch
                            value={linkStyle.color || ''}
                            onChange={v => updateLinkStyle({ color: v })}
                            title={t('cms_site.blocks.footer.footer_link_color', 'Footer link color')}
                        />
                    </FieldRow>
                </CollapsibleCard>

                {/* ── Columns ───────────────────────────────────── */}
                <CollapsibleCard title={t('cms_site.blocks.footer.columns', 'Columns')} persistKey="blk.footer.columns">
                    <RepeatableList
                        items={data.columns || []}
                        onChange={v => onChange(set(data, 'columns', v))}
                        makeNew={() => ({ id: mintId('fcol'), heading: 'New column', links: [] })}
                        itemLabel={(c) => c.heading || t('cms_site.blocks.footer.no_heading', '(no heading)')}
                        collapsible
                        renderItem={(col, updateCol) => (
                            <>
                                <TextField
                                    label={t('cms_site.blocks.footer.heading', 'Heading')}
                                    value={col.heading || ''}
                                    onChange={v => updateCol({ ...col, heading: v })}
                                />
                                <RepeatableList
                                    label={t('cms_site.blocks.footer.links', 'Links')}
                                    items={col.links || []}
                                    onChange={v => updateCol({ ...col, links: v })}
                                    makeNew={() => ({ id: mintId('fl'), label: 'New link', link: { kind: 'external', url: '#' } })}
                                    itemLabel={(l) => l.label || t('cms_site.blocks.footer.no_label', '(no label)')}
                                    collapsible
                                    renderItem={(l, updL) => (
                                        <>
                                            <TextField
                                                label={t('cms_site.blocks.footer.label', 'Label')}
                                                value={l.label || ''}
                                                onChange={v => updL({ ...l, label: v })}
                                            />
                                            <LinkField
                                                label={t('cms_site.blocks.footer.link', 'Link')}
                                                value={l.link}
                                                pages={pages}
                                                onChange={v => updL({ ...l, link: v })}
                                            />
                                        </>
                                    )}
                                    addLabel={t('cms_site.blocks.footer.add_link', 'Add link')}
                                />
                            </>
                        )}
                        addLabel={t('cms_site.blocks.footer.add_column', 'Add column')}
                    />
                </CollapsibleCard>

                {/* ── Accountability (trust surface) ────────────── */}
                <CollapsibleCard title={t('cms_site.blocks.footer.accountability', 'Accountability')} persistKey="blk.footer.accountability">
                    <InlineHint>{t('cms_site.blocks.footer.address_registration_and_legal_links_make', 'Address, registration and legal links make the footer a trust surface — important for GDPR-minded buyers. The row hides itself while everything is empty.')}</InlineHint>
                    <TextField
                        label={t('cms_site.blocks.footer.address', 'Address')}
                        value={data.accountability?.address || ''}
                        onChange={v => onChange(set(data, 'accountability', { ...(data.accountability || {}), address: v }))}
                        placeholder={t('cms_site.blocks.footer.street_1_1234_ab_city_netherlands', 'Street 1, 1234 AB City, Netherlands')}
                    />
                    <TextField
                        label={t('cms_site.blocks.footer.registration', 'Registration')}
                        value={data.accountability?.registration || ''}
                        onChange={v => onChange(set(data, 'accountability', { ...(data.accountability || {}), registration: v }))}
                        placeholder="KvK 12345678"
                    />
                    <TextField
                        label={t('cms_site.blocks.footer.vat', 'VAT')}
                        value={data.accountability?.vat || ''}
                        onChange={v => onChange(set(data, 'accountability', { ...(data.accountability || {}), vat: v }))}
                        placeholder="NL123456789B01"
                    />
                    <RepeatableList
                        label={t('cms_site.blocks.footer.legal_links', 'Legal links')}
                        items={data.accountability?.links || []}
                        onChange={v => onChange(set(data, 'accountability', { ...(data.accountability || {}), links: v }))}
                        makeNew={() => ({ label: 'DPA', href: '' })}
                        itemLabel={(l) => l.label || t('cms_site.blocks.footer.no_label', '(no label)')}
                        renderItem={(l, updL) => (
                            <>
                                <TextField label={t('cms_site.blocks.footer.label', 'Label')} value={l.label || ''} onChange={v => updL({ ...l, label: v })} placeholder={t('cms_site.blocks.footer.dpa_impressum_security', 'DPA / Impressum / Security')} />
                                <TextField label={t('cms_site.blocks.footer.url', 'URL')} value={l.href || ''} onChange={v => updL({ ...l, href: v })} placeholder="https://…" />
                            </>
                        )}
                        addLabel={t('cms_site.blocks.footer.add_link', 'Add link')}
                    />
                </CollapsibleCard>

                {/* ── Social links ──────────────────────────────── */}
                <CollapsibleCard title={t('cms_site.blocks.footer.social_links', 'Social links')} persistKey="blk.footer.socials">
                    <RepeatableList
                        items={data.socials || []}
                        onChange={v => onChange(set(data, 'socials', v))}
                        makeNew={() => ({ id: mintId('soc'), platform: 'github', link: { kind: 'external', url: '' } })}
                        itemLabel={(s) => s.platform || t('cms_site.blocks.footer.no_platform', '(no platform)')}
                        collapsible
                        renderItem={(s, updS) => (
                            <>
                                <FieldSelect
                                    label={t('cms_site.blocks.footer.platform', 'Platform')}
                                    value={s.platform}
                                    options={[
                                        { value: 'github',   label: 'GitHub' },
                                        { value: 'twitter',  label: 'Twitter / X' },
                                        { value: 'linkedin', label: 'LinkedIn' },
                                        { value: 'other',    label: t('cms_site.blocks.footer.platform_other', 'Other') },
                                    ]}
                                    onChange={v => updS({ ...s, platform: v })}
                                />
                                <LinkField
                                    label={t('cms_site.blocks.footer.url', 'URL')}
                                    value={s.link}
                                    pages={pages}
                                    onChange={v => updS({ ...s, link: v })}
                                />
                            </>
                        )}
                        addLabel={t('cms_site.blocks.footer.add_social', 'Add social')}
                    />
                </CollapsibleCard>
            </CollapsibleCard>
        </>
    );
}
