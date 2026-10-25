import type { TranslateParams } from '../../../../../hooks/useTranslation';

const enumLabels = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string): Record<string, string> => ({
    none: t('studio_apps_insp.theme.enum_none', 'None'), sm: 'S', md: 'M', lg: 'L', xl: 'XL',
    compact: t('studio_apps_insp.theme.enum_compact', 'Compact'),
    comfortable: t('studio_apps_insp.theme.enum_comfortable', 'Comfy'),
    spacious: t('studio_apps_insp.theme.enum_spacious', 'Spacious'),
    light: t('studio_apps_insp.theme.enum_light', 'Light'),
    dark: t('studio_apps_insp.theme.enum_dark', 'Dark'),
    auto: t('studio_apps_insp.theme.enum_auto', 'Auto'),
    // App Design v2
    hairline: t('studio_apps_insp.theme.enum_hairline', 'Outline'),
    flat: t('studio_apps_insp.theme.enum_flat', 'Flat'),
    soft: t('studio_apps_insp.theme.enum_soft', 'Soft'),
    elevated: t('studio_apps_insp.theme.enum_elevated', 'Raised'),
    subtle: t('studio_apps_insp.theme.enum_subtle', 'Subtle'),
    full: t('studio_apps_insp.theme.enum_full', 'Full'),
    classic: t('studio_apps_insp.theme.enum_classic', 'Classic'),
    brand: t('studio_apps_insp.theme.enum_brand', 'Brand'),
});

export const designFields = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string): Array<{ key: 'surface' | 'motion' | 'chartPalette'; label: string; hint: string }> => [
    { key: 'surface', label: t('studio_apps_insp.theme.design_surface', 'Surfaces'), hint: t('studio_apps_insp.theme.design_surface_hint', 'How cards, stats and grids sit on the page.') },
    { key: 'motion', label: t('studio_apps_insp.theme.design_motion', 'Motion'), hint: t('studio_apps_insp.theme.design_motion_hint', 'Animation level. Viewers who ask for reduced motion always get none.') },
    { key: 'chartPalette', label: t('studio_apps_insp.theme.design_chart_colours', 'Chart colours'), hint: t('studio_apps_insp.theme.design_chart_colours_hint', 'Brand derives chart colours from the primary colour.') },
];

// Typeface pairings. Self-hosted families load from our own server — no
// request to Google — which is worth saying out loud in a privacy product.
export const fontLabels = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string): Record<string, string> => ({
    system: t('studio_apps_insp.theme.font_system', 'System'), inter: 'Inter',
    satoshi: t('studio_apps_insp.theme.font_satoshi', 'Satoshi (local)'),
    'general-sans': t('studio_apps_insp.theme.font_general_sans', 'General Sans (local)'),
    cabinet: t('studio_apps_insp.theme.font_cabinet', 'Cabinet Grotesk (local)'),
    geist: 'Geist', plex: 'IBM Plex Sans', poppins: 'Poppins',
});

export const widthLabels = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string): Record<string, string> => ({ narrow: 'S', medium: 'M', wide: 'L', full: t('studio_apps_insp.theme.enum_full', 'Full') });

export const refreshLabels = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string): Record<number, string> => ({ 0: t('studio_apps_insp.theme.refresh_off', 'Off'), 15: '15s', 30: '30s', 60: '1m', 300: '5m' });

export const navStyleLabels = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string): Record<string, string> => ({
    tabs: t('studio_apps_insp.theme.nav_tabs', 'Tabs'),
    sidebar: t('studio_apps_insp.theme.nav_sidebar', 'Sidebar'),
    mega: t('studio_apps_insp.theme.nav_mega', 'Mega'),
    rail: t('studio_apps_insp.theme.nav_rail', 'Rail'),
});

export function options(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, values: string[]) {
    const labels = enumLabels(t);
    return values.map((v) => ({ value: v, label: labels[v] || v }));
}

export const themeFields = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { key: 'radius', label: t('studio_apps_insp.theme.field_corners', 'Corners') },
    { key: 'density', label: t('studio_apps_insp.theme.field_density', 'Density') },
    { key: 'fontScale', label: t('studio_apps_insp.theme.field_text_size', 'Text size') },
    { key: 'appearance', label: t('studio_apps_insp.theme.field_appearance', 'Appearance') },
];
