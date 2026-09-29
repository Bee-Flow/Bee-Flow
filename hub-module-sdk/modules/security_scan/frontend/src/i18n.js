/**
 * Tiny self-contained i18n for the module.
 *
 * A runtime module may import only the React family — nothing from agent-hub —
 * so we can't use the host's useTranslation. Instead we read the same locale the
 * host stores in localStorage (`beeflow_locale`) and resolve keys from a local
 * dictionary. Only the keys the ported UI actually translates are shipped
 * (`security_studio.title`, `security_studio.no_scans`) plus the strings the new
 * provisioning panel needs. `studio.tab.security` is host-rendered from the
 * module manifest, so it isn't needed here but is included for completeness.
 *
 * ship en + nl (nl mirrors en where a translation wasn't authoritative).
 */
import { useMemo } from 'react';

const STRINGS = {
    en: {
        'studio.tab.security': 'Security Scan',
        'security_studio.title': 'Security Scan',
        'security_studio.no_scans': 'No scans yet',
        // Provisioning panel (Track C)
        'security_studio.provision.title': 'Scanner image not installed',
        'security_studio.provision.subtitle': 'Operator setup required',
        'security_studio.provision.body':
            'The isolated scanner container image is not present on this host yet. An operator must build or pull it before scans can run.',
        'security_studio.provision.build': 'Build image',
        'security_studio.provision.pull': 'Pull image',
        'security_studio.provision.working': 'Provisioning…',
        'security_studio.provision.recheck': 'Re-check',
        'security_studio.provision.docker_down':
            'Docker is not reachable on this host — the scanner needs a working Docker daemon.',
        'security_studio.provision.done': 'Scanner image ready.',
        'security_studio.provision.failed': 'Provisioning failed',
    },
    nl: {
        'studio.tab.security': 'Beveiligingsscan',
        'security_studio.title': 'Beveiligingsscan',
        'security_studio.no_scans': 'Nog geen scans',
        'security_studio.provision.title': 'Scanner-image niet geïnstalleerd',
        'security_studio.provision.subtitle': 'Installatie door beheerder vereist',
        'security_studio.provision.body':
            'De geïsoleerde scanner-container-image staat nog niet op deze host. Een beheerder moet deze bouwen of ophalen voordat scans kunnen draaien.',
        'security_studio.provision.build': 'Image bouwen',
        'security_studio.provision.pull': 'Image ophalen',
        'security_studio.provision.working': 'Bezig met installeren…',
        'security_studio.provision.recheck': 'Opnieuw controleren',
        'security_studio.provision.docker_down':
            'Docker is niet bereikbaar op deze host — de scanner heeft een werkende Docker-daemon nodig.',
        'security_studio.provision.done': 'Scanner-image gereed.',
        'security_studio.provision.failed': 'Installeren mislukt',
    },
};

function currentLocale() {
    try {
        const stored = typeof localStorage !== 'undefined' && localStorage.getItem('beeflow_locale');
        if (stored) return String(stored).split('-')[0].toLowerCase();
    } catch (_) { /* localStorage unavailable */ }
    try {
        const nav = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || 'en';
        return String(nav).split('-')[0].toLowerCase();
    } catch (_) { return 'en'; }
}

/**
 * useTranslation — drop-in for the host hook the ported files used.
 *
 * `t(key, fallbackOrParams?, params?)` resolves: locale dict → en dict →
 * string fallback → raw key, then interpolates `{name}` placeholders.
 */
export default function useTranslation() {
    const locale = currentLocale();
    const t = useMemo(() => {
        const dict = STRINGS[locale] || STRINGS.en;
        return (key, fallbackOrParams, paramsArg) => {
            const hasStringFallback = typeof fallbackOrParams === 'string';
            const params = hasStringFallback ? paramsArg : fallbackOrParams;
            let value = dict[key];
            if (value === undefined || value === null) value = STRINGS.en[key];
            if (value === undefined || value === null) value = hasStringFallback ? fallbackOrParams : key;
            if (typeof value !== 'string') value = hasStringFallback ? fallbackOrParams : key;
            if (params && typeof params === 'object') {
                for (const [k, v] of Object.entries(params)) {
                    value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
                }
            }
            return value;
        };
    }, [locale]);
    return { t, locale };
}

export { useTranslation };
