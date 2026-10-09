import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Toggle, TextField } from '../fields';
import { CollapsibleCard, SegmentedControl } from '../primitives';

/**
 * Site-chrome editor for the announcement bar. Edits site.announcement:
 *
 *   { enabled, dismissible, variant, text: { en: {...}, nl: {...}, <locale>: {...} } }
 *
 * Same model as CookieBannerEditor: the `text` blob carries every locale's
 * copy in one place and the public renderer
 * (marketing/components/AnnouncementBar) picks the visitor's language at
 * display time (falling back to English), so there is no per-locale override
 * layer here.
 *
 * The locale sections follow the SITE's locale list (`locales` prop — the org
 * language system). Copy saved for locales that were later removed from the
 * org list is preserved under "Other saved languages" — removing a language
 * must never silently destroy announcement copy.
 */

const FALLBACK_LOCALES = [
    { code: 'en', name: 'English' },
    { code: 'nl', name: 'Nederlands' },
];

const variantOptions = (t) => [
    { value: 'accent',  label: t('cms_site.blocks.announcement.variant_accent', 'Accent'),  hint: t('cms_site.blocks.announcement.variant_accent_hint', 'Brand gradient strip with light label text') },
    { value: 'surface', label: t('cms_site.blocks.announcement.variant_surface', 'Surface'), hint: t('cms_site.blocks.announcement.variant_surface_hint', 'Quiet surface fill with a hairline under it') },
    { value: 'dark',    label: t('cms_site.blocks.announcement.variant_dark', 'Dark'),    hint: t('cms_site.blocks.announcement.variant_dark_hint', 'Dark strip with light text') },
];

function LocaleCard({ code, label, text, defaultOpen, onField }) {
    const { t } = useTranslation();
    const copy = text[code] || {};
    return (
        <CollapsibleCard title={label} defaultOpen={defaultOpen} persistKey={`announce.${code}`}>
            <TextField
                label={t('cms_site.blocks.announcement.message', 'Message')}
                value={copy.message || ''}
                onChange={v => onField(code, 'message', v)}
                hint={t('cms_site.blocks.announcement.keep_it_to_one_short_line', 'Keep it to one short line. Empty = the bar stays hidden for this language.')}
            />
            <TextField
                label={t('cms_site.blocks.announcement.link_label', 'Link label')}
                value={copy.linkLabel || ''}
                onChange={v => onField(code, 'linkLabel', v)}
                hint={t('cms_site.blocks.announcement.optional_call_to_action_e_g', 'Optional call to action, e.g. “Read more”.')}
            />
            <TextField
                label={t('cms_site.blocks.announcement.link_url', 'Link URL')}
                value={copy.linkUrl || ''}
                onChange={v => onField(code, 'linkUrl', v)}
                hint={t('cms_site.blocks.announcement.leave_both_link_fields_empty_to', 'Leave both link fields empty to show the message on its own.')}
            />
        </CollapsibleCard>
    );
}

export default function AnnouncementEditor({ data = {}, onChange, locales = null, defaultLocale = 'en' }) {
    const { t } = useTranslation();
    // Off by default — unlike the cookie banner, an announcement is opt-in
    // (a site that never configured one must not suddenly grow a strip).
    const enabled = data.enabled === true;
    const dismissible = data.dismissible !== false;
    const VARIANT_OPTIONS = variantOptions(t);
    const variant = VARIANT_OPTIONS.some(o => o.value === data.variant) ? data.variant : 'accent';
    const text = data.text || {};

    const siteLocales = (Array.isArray(locales) && locales.length > 0)
        ? locales.map(l => ({ code: l.code, name: l.name || l.code }))
        : FALLBACK_LOCALES;
    const known = new Set(siteLocales.map(l => l.code));
    const orphaned = Object.keys(text).filter(
        code => !known.has(code) && text[code] && typeof text[code] === 'object');

    // Replace one copy field for one locale, leaving every other field and
    // locale intact.
    const updateField = (locale, key, value) => {
        onChange({
            ...data,
            text: {
                ...text,
                [locale]: { ...(text[locale] || {}), [key]: value },
            },
        });
    };

    return (
        <>
            <Toggle
                label={t('cms_site.blocks.announcement.show_announcement_bar', 'Show announcement bar')}
                value={enabled}
                onChange={v => onChange({ ...data, enabled: v })}
            />
            <p className="text-[10px] text-[var(--text-muted)] mb-3 -mt-1">
                {t('cms_site.blocks.announcement.sits_above_the_header_on_every_page', 'Sits above the header on every page. Visitors see the copy for their language; languages without a message hide the bar entirely.')}
            </p>

            <div className="mb-3">
                <div className="text-[11px] font-medium text-[var(--text-secondary)] mb-1.5">{t('cms_site.blocks.announcement.style', 'Style')}</div>
                <SegmentedControl
                    options={VARIANT_OPTIONS}
                    value={variant}
                    onChange={v => onChange({ ...data, variant: v })}
                />
            </div>

            <Toggle
                label={t('cms_site.blocks.announcement.visitors_can_dismiss_it', 'Visitors can dismiss it')}
                value={dismissible}
                onChange={v => onChange({ ...data, dismissible: v })}
            />
            <p className="text-[10px] text-[var(--text-muted)] mb-3 -mt-1">
                {t('cms_site.blocks.announcement.a_dismissed_bar_stays_hidden_for_that', 'A dismissed bar stays hidden for that visitor until you change the message — new copy is shown again to everyone.')}
            </p>

            {siteLocales.map(({ code, name }) => (
                <LocaleCard
                    key={code}
                    code={code}
                    label={`${name} (${code})${code === defaultLocale ? ' ★' : ''}`}
                    text={text}
                    defaultOpen={code === defaultLocale}
                    onField={updateField}
                />
            ))}

            {orphaned.length > 0 && (
                <CollapsibleCard title={t('cms_site.blocks.announcement.other_saved_languages', 'Other saved languages')} defaultOpen={false}>
                    <p className="text-[10px] text-[var(--text-muted)] mb-2">
                        {t('cms_site.blocks.announcement.copy_saved_for_languages_that_are_no', "Copy saved for languages that are no longer in the organization's language list. It stays published until removed here.")}
                    </p>
                    {orphaned.map(code => (
                        <LocaleCard
                            key={code}
                            code={code}
                            label={code}
                            text={text}
                            defaultOpen={false}
                            onField={updateField}
                        />
                    ))}
                </CollapsibleCard>
            )}
        </>
    );
}
