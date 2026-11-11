// @typecheck
/**
 * App design presets — the non-technical builder's whole design decision in
 * one click. Each preset is a COMPLETE, materialized {theme, design, navStyle}
 * blob: applying one writes real values (themePresets.js precedent — no
 * "preset reference" indirection that would change rendering when a preset is
 * later edited). `design.preset` records provenance only.
 *
 * `classic` is the do-nothing default: it maps 1:1 to today's theme defaults
 * plus an all-identity design, so an app on `classic` renders byte-identically
 * to an app with no design at all.
 *
 * House rule: no purple/violet/indigo anywhere (AppStudio.noPurple.test.jsx).
 * Every primary comes from THEME_PRIMARY_PRESETS.
 *
 * Shared with the editor's preset gallery: server/appStudio/appDesignPresets.js
 * re-exports it for the server, and agent-hub/src/shared/appDefinition/ is a
 * GENERATED copy (npm run gen:shared) the client runtime re-exports.
 */

export const APP_DESIGN_PRESETS = [
    {
        id: 'classic',
        name: 'Classic',
        description: 'The familiar look — calm, light and compact enough for any team.',
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        design: { preset: 'classic', font: 'system', surface: 'hairline', motion: 'subtle', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
        navStyle: 'tabs',
    },
    {
        id: 'cloud',
        name: 'Cloud',
        description: 'Modern B2B SaaS: light and airy, soft cards, navigation in a sidebar.',
        theme: { primary: '#1D4ED8', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'light' },
        design: { preset: 'cloud', font: 'satoshi', surface: 'soft', motion: 'full', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
        navStyle: 'sidebar',
    },
    {
        id: 'atlas',
        name: 'Atlas',
        description: 'A product, not a form: a top bar whose menus open with a line about each screen.',
        theme: { primary: '#0369A1', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        design: { preset: 'atlas', font: 'satoshi', surface: 'soft', motion: 'full', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
        navStyle: 'mega',
    },
    {
        id: 'midnight',
        name: 'Midnight',
        description: 'A dark ops console — technical, focused, built for long sessions.',
        theme: { primary: '#0891B2', radius: 'md', density: 'compact', fontScale: 'md', appearance: 'dark' },
        design: { preset: 'midnight', font: 'geist', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
        navStyle: 'rail',
    },
    {
        id: 'field',
        name: 'Field',
        description: 'A friendly field-service app: big buttons, plenty of air, mobile first.',
        theme: { primary: '#047857', radius: 'xl', density: 'spacious', fontScale: 'lg', appearance: 'light' },
        design: { preset: 'field', font: 'general-sans', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
        navStyle: 'tabs',
    },
    {
        id: 'paper',
        name: 'Paper',
        description: 'Warm and editorial — a back office that reads like a well-set document.',
        theme: { primary: '#B45309', radius: 'sm', density: 'comfortable', fontScale: 'md', appearance: 'light' },
        design: { preset: 'paper', font: 'cabinet', surface: 'hairline', motion: 'subtle', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
        navStyle: 'tabs',
    },
    {
        id: 'mono',
        name: 'Mono',
        description: 'A dense, businesslike expert tool — no frills, maximum information density.',
        theme: { primary: '#334155', radius: 'sm', density: 'compact', fontScale: 'sm', appearance: 'auto' },
        design: { preset: 'mono', font: 'plex', surface: 'flat', motion: 'none', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
        navStyle: 'tabs',
    },
];

/**
 * Presets added after the base seven. APP_DESIGN_PRESETS above is the base tier and stays as
 * it is (the builder's pinned prompt and tool schemas list exactly those ids); a preset added
 * later goes HERE, appended, with `since: 3`, and its id is appended to DESIGN_SPEC.preset
 * (server/appStudio/appDesignSpec.js, with valuesSince) and to DESIGN_ENUMS.preset in the web
 * runtime. Applying one works like any other: its values are materialized.
 */
export const EXTENSION_APP_DESIGN_PRESETS = [
    {
        id: 'grove',
        since: 3,
        name: 'Grove',
        description: 'Fresh and friendly: a rounded green workspace with its screens in a sidebar.',
        theme: { primary: '#4D7C0F', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'light' },
        design: { preset: 'grove', font: 'poppins', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'none', logoUrl: null },
        navStyle: 'sidebar',
    },
    {
        id: 'ember',
        since: 3,
        name: 'Ember',
        description: 'Warm and energetic: lifted cards and a strong orange call to action.',
        theme: { primary: '#C2410C', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' },
        design: { preset: 'ember', font: 'inter', surface: 'elevated', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
        navStyle: 'tabs',
    },
    {
        id: 'signal',
        since: 3,
        name: 'Signal',
        description: 'A control room: dark, square and compact, for alerts and incidents.',
        theme: { primary: '#B91C1C', radius: 'none', density: 'compact', fontScale: 'md', appearance: 'dark' },
        design: { preset: 'signal', font: 'plex', surface: 'flat', motion: 'none', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null },
        navStyle: 'rail',
    },
    {
        id: 'bloom',
        since: 3,
        name: 'Bloom',
        description: 'Soft and personal: round, roomy and warm, for apps people use about people.',
        theme: { primary: '#BE185D', radius: 'xl', density: 'spacious', fontScale: 'md', appearance: 'light' },
        design: { preset: 'bloom', font: 'poppins', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'none', logoUrl: null },
        navStyle: 'tabs',
    },
    {
        id: 'ledger',
        since: 3,
        name: 'Ledger',
        description: 'Sober and exact: square hairline tables for finance, records and audits.',
        theme: { primary: '#57534E', radius: 'none', density: 'comfortable', fontScale: 'md', appearance: 'light' },
        design: { preset: 'ledger', font: 'inter', surface: 'hairline', motion: 'none', chartPalette: 'classic', accentEdge: 'none', logoUrl: null },
        navStyle: 'sidebar',
    },
    {
        id: 'nocturne',
        since: 3,
        name: 'Nocturne',
        description: 'A dark product look: deep surfaces, lifted cards and a product-style menu.',
        theme: { primary: '#0369A1', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'dark' },
        design: { preset: 'nocturne', font: 'satoshi', surface: 'elevated', motion: 'subtle', chartPalette: 'brand', accentEdge: 'none', logoUrl: null },
        navStyle: 'mega',
    },
];

/** Every preset: the base seven, then the later ones. What the gallery shows and a preset id resolves against. */
export const ALL_APP_DESIGN_PRESETS = [...APP_DESIGN_PRESETS, ...EXTENSION_APP_DESIGN_PRESETS];

export function getAppDesignPreset(id) {
    return ALL_APP_DESIGN_PRESETS.find((p) => p.id === id) || null;
}
