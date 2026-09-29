// @typecheck
/**
 * Countries: the GDPR jurisdiction set, display names and flags.
 *
 * EU_EEA_COUNTRIES is the set every "stayed in Europe" answer uses: the 27 EU
 * member states, the three other EEA states, and Switzerland and the United
 * Kingdom (adequacy decisions). The UI labels it "EEA + adequacy (CH, UK)".
 *
 * Names come from Intl.DisplayNames (every ISO 3166 code, from the ICU data in
 * Node itself) with the short table below as an override, so the labels that
 * existing rows and screenshots carry ("UAE", "Czechia") stay as they were.
 */

'use strict';

const EU_EEA_COUNTRIES = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
    'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
    'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    // EEA (non-EU)
    'IS', 'LI', 'NO',
    // Adequacy decisions
    'CH', 'GB',
]);

/** Overrides for Intl's names; also the fallback when Intl lacks a code. */
const COUNTRY_NAMES = {
    US: 'United States', GB: 'United Kingdom', DE: 'Germany', NL: 'Netherlands',
    FR: 'France', IE: 'Ireland', BE: 'Belgium', SE: 'Sweden', FI: 'Finland',
    NO: 'Norway', DK: 'Denmark', CH: 'Switzerland', AT: 'Austria', IT: 'Italy',
    ES: 'Spain', PT: 'Portugal', PL: 'Poland', CZ: 'Czechia', RO: 'Romania',
    BG: 'Bulgaria', HR: 'Croatia', HU: 'Hungary', SK: 'Slovakia', SI: 'Slovenia',
    LT: 'Lithuania', LV: 'Latvia', EE: 'Estonia', LU: 'Luxembourg', MT: 'Malta',
    CY: 'Cyprus', GR: 'Greece', IS: 'Iceland', LI: 'Liechtenstein',
    CA: 'Canada', AU: 'Australia', NZ: 'New Zealand', JP: 'Japan',
    SG: 'Singapore', IN: 'India', BR: 'Brazil', KR: 'South Korea',
    CN: 'China', TW: 'Taiwan', HK: 'Hong Kong', RU: 'Russia',
    ZA: 'South Africa', IL: 'Israel', AE: 'UAE', SA: 'Saudi Arabia',
    MX: 'Mexico', AR: 'Argentina', CL: 'Chile', CO: 'Colombia',
};

let _display = null;
try {
    _display = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
} catch { /* a Node without full ICU: the table above still answers */ }

/** ISO-2 → English name; the code itself when unknown; null for no code. */
function countryName(code) {
    if (!code) return null;
    const cc = String(code).toUpperCase();
    if (COUNTRY_NAMES[cc]) return COUNTRY_NAMES[cc];
    if (_display && /^[A-Z]{2}$/.test(cc)) {
        try {
            const name = _display.of(cc);
            if (name) return name;
        } catch { /* not a region code */ }
    }
    return cc;
}

/** ISO-2 → flag emoji; a globe for anything else. */
function countryFlag(code) {
    if (!code || String(code).length !== 2 || !/^[a-z]{2}$/i.test(String(code))) return '🌐';
    return String.fromCodePoint(...[...String(code).toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

function isEuEea(code) {
    return !!code && EU_EEA_COUNTRIES.has(String(code).toUpperCase());
}

module.exports = { EU_EEA_COUNTRIES, COUNTRY_NAMES, countryName, countryFlag, isEuEea };
