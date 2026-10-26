import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePublicLocalesQuery } from '../../api/queries/publicSite';
import { API_BASE } from '../../utils/helpers';
import AppIcon from '../../components/icons/AppIcon';
import { logger } from '../../utils/logger';

interface Locale {
    code: string;
    name?: string;
}

/**
 * Public marketing-site language switcher.
 *
 * Lists the locales the org has enabled (from the public, no-auth
 * /api/languages/public/locales endpoint) and lets a visitor switch the site
 * language. The choice is stored in `beeflow_locale` (shared with the app's
 * i18n picker) and applied via the ?locale= query so RootPathGate re-fetches
 * the translated content. Hidden when only one language is available, and in
 * the CMS preview iframe (the admin switches locale from the editor instead).
 */

function currentLocale() {
    try {
        const param = new URLSearchParams(window.location.search).get('locale');
        if (param) return param.toLowerCase().split('-')[0];
        const stored = localStorage.getItem('beeflow_locale');
        if (stored) return stored.toLowerCase().split('-')[0];
    } catch (err) { logger.debug('ignore', err); }
    return (navigator.language || 'en').toLowerCase().split('-')[0];
}

export default function LanguageSwitcher() {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const active = currentLocale();

    const isPreview = typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).has('preview');

    const localesAnswer = usePublicLocalesQuery<Locale[] | { locales?: Locale[] }>(API_BASE, !isPreview).data;
    const locales: Locale[] = useMemo(
        () => (Array.isArray(localesAnswer) ? localesAnswer : (localesAnswer?.locales || [])),
        [localesAnswer],
    );

    useEffect(() => {
        const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node | null)) setOpen(false); };
        document.addEventListener('click', onDoc);
        return () => document.removeEventListener('click', onDoc);
    }, []);

    // Nothing to switch between (or in preview) → render nothing.
    if (isPreview || locales.length < 2) return null;

    const choose = (code: string) => {
        if (code === active) { setOpen(false); return; }
        try { localStorage.setItem('beeflow_locale', code); } catch (err) { logger.debug('ignore', err); }
        const url = new URL(window.location.href);
        url.searchParams.set('locale', code);
        window.location.assign(url.toString());
    };

    const activeInfo = locales.find(l => l.code === active);
    const label = (activeInfo?.code || active).toUpperCase();

    return (
        <div className="lang-switcher [position:relative]" ref={ref}>
            <button
                type="button"
                className="lang-switcher-btn"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen(v => !v)}
                title="Change language"
            >
                {/* Lucide, not the 🌐 emoji it used to be: the emoji sits in
                    the OS font, so the header picked up a blue Apple globe on
                    a Mac and a flat Segoe one on Windows, at a weight nothing
                    else in the chrome shares. */}
                <AppIcon name="Globe" className="w-4 h-4" aria-hidden="true" />
                <span>{label}</span>
            </button>
            {open && (
                <ul className="lang-switcher-menu" role="listbox">
                    {locales.map(l => (
                        <li key={l.code} role="option" aria-selected={l.code === active}>
                            <button
                                type="button"
                                className={l.code === active ? 'active' : undefined}
                                onClick={() => choose(l.code)}
                            >
                                {l.name || l.code} <span className="lang-code">({l.code})</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
