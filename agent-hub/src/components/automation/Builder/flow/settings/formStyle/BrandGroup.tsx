import React, { useId, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { FORM_FOOTER_MAX, FORM_LOGO_URL_MAX, safeLogoUrl } from '@/components/forms/formStyleVars';
import { withStyleValue, type Style } from './stylePresets';
import type { StyleChange } from './formStyleTypes';

const INPUT = 'w-full px-2 py-1 rounded-md text-xs border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]';
const LABEL = 'block text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-0.5';
const HINT = 'text-[10px] leading-snug text-[var(--text-tertiary)] mt-0.5';

/**
 * Brand: a logo and a footer line.
 *
 * The logo is an address on THIS server ('/…'). An address on another site is
 * never stored: the visitor's browser would fetch it, and that site would learn
 * who opens the form. What the author types is kept in the field while it is
 * not (yet) a valid path; only a valid one (or an empty field) is saved.
 */
export default function BrandGroup({ style, onChange }: { style: Style | undefined; onChange: StyleChange }) {
    const { t } = useTranslation();
    const id = useId();
    const saved = typeof style?.logoUrl === 'string' ? style.logoUrl : '';
    const [logo, setLogo] = useState(saved);
    const [lastSaved, setLastSaved] = useState(saved);
    // Another page, or an undo upstream: show what is stored now.
    if (saved !== lastSaved) { setLastSaved(saved); setLogo(saved); }
    const logoValid = !logo.trim() || !!safeLogoUrl(logo.trim());

    const changeLogo = (next: string) => {
        setLogo(next);
        const clean = next.trim();
        if (!clean || safeLogoUrl(clean)) {
            setLastSaved(clean);
            onChange({ style: withStyleValue(style, 'logoUrl', clean || undefined) });
        }
    };

    return (
        <>
            <div>
                <label htmlFor={`${id}-logo`} className={LABEL}>{t('forms.style.logo', 'Logo')}</label>
                <input
                    id={`${id}-logo`}
                    type="text"
                    value={logo}
                    maxLength={FORM_LOGO_URL_MAX}
                    placeholder="/logo.png"
                    aria-invalid={logoValid ? undefined : true}
                    aria-describedby={`${id}-logo-hint`}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => changeLogo(e.target.value)}
                    className={`${INPUT} font-mono`}
                />
                <p id={`${id}-logo-hint`} className={logoValid ? HINT : `${HINT} text-[var(--error)]`} role={logoValid ? undefined : 'alert'}>
                    {logoValid
                        ? t('forms.style.logo_hint', 'An address on this server, starting with /. Images on other sites are not loaded: they would tell that site who opens the form.')
                        : t('forms.style.logo_invalid', 'Use an address on this server that starts with a single /. This one is not saved.')}
                </p>
            </div>
            <div>
                <label htmlFor={`${id}-footer`} className={LABEL}>{t('forms.style.footer', 'Footer text')}</label>
                <textarea
                    id={`${id}-footer`}
                    rows={2}
                    value={typeof style?.footerText === 'string' ? style.footerText : ''}
                    maxLength={FORM_FOOTER_MAX}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ style: withStyleValue(style, 'footerText', e.target.value || undefined) })}
                    className={INPUT}
                />
                <p className={HINT}>{t('forms.style.footer_hint', 'Plain text under the form, for example your organisation\'s name or a privacy line.')}</p>
            </div>
        </>
    );
}
