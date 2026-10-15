import type { CmsDesign } from './DesignEditor.types';

// Mirrors DESIGN_DEFAULTS in server/i18n/defaults/cmsDefaults.js — keep
// the two in sync (the server back-fills missing fields from its copy).
export const FALLBACK_DESIGN: CmsDesign = {
    colors: {
        primary:       '#F5A623',
        secondary:     '#1F2937',
        accent:        '#FFD166',
        background:    '#FAF8F4',
        surface:       '#F3EFE7',
        textPrimary:   '#1C1917',
        textSecondary: '#57534E',
    },
    darkColors: {
        background:    '#101012',
        surface:       '#17171B',
        textPrimary:   '#F4F2EE',
        textSecondary: '#A6A29A',
        primary:       '',
        accent:        '',
    },
    fonts:    { heading: 'Fraunces', body: 'Inter', mono: 'IBM Plex Mono' },
    logo:     '',
    favicon:  '',
    radius:   12,
    theme:    'light',
    gradient: false,
    preset:   'custom',
    typography: { displaySize: 'lg', headingWeight: 600, bodySize: 16 },
    motion:   'full',
    grain:    false,
    // Identity values — these emit no CSS at all (see SHAPE_MAPS in
    // marketing/ProductWebsite.jsx), so a site without them renders
    // exactly as it did before the theme system existed.
    components: {
        buttonShape: 'soft', buttonSize: 'md', buttonTextColor: 'light',
        navStyle: 'bar', navHeight: 'default', logoSize: 'md',
        cardStyle: 'hairline', cardPadding: 'default', shadow: 'soft',
    },
    layout: { containerWidth: 'default', sectionRhythm: 'default' },
};
