/**
 * Design tokens, ported one-for-one from agent-hub/src/index.css.
 *
 * These are the SAME values the web app paints with, deliberately duplicated
 * rather than derived: there is no build step that could share a CSS custom
 * property with a React Native StyleSheet, and a mobile app that drifts a
 * shade away from the web app looks broken next to it. If a value changes in
 * index.css it must change here — tokens.test.ts pins the ones that matter so
 * the drift shows up as a failing test rather than as a screenshot nobody
 * compares.
 *
 * Two web-only concepts are resolved at build time instead of at paint time:
 *   - `color-mix(in srgb, X n%, transparent)` becomes a literal rgba(), because
 *     RN has no colour arithmetic in styles.
 *   - `--radius-scale` (the admin "roundness" dial) is applied by
 *     ThemeProvider, not baked in, so it can still be changed at runtime.
 */

/** Every theme the web app offers, in the order the picker shows them. */
export const THEME_NAMES = [
    'dark',
    'light',
    'glass',
    'glass-dark',
    'high-contrast',
    'paper',
    'obsidian',
    'sepia',
] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

/**
 * The themes the picker offers. NOT the same set as THEME_NAMES, deliberately.
 *
 * `glass` and `glass-dark` are excluded because on Android they do not exist as
 * designed: expo-blur's ExpoBlurView defaults to `BlurMethod.NONE` and forces
 * NONE whenever `blurTarget == null` — which it always is here, since nothing
 * in this app mounts a blur target. So a quarter of the picker rendered a flat
 * grey wash, paid for with a full-screen native view per screen and another per
 * card, on the only platform this ships to. A theme that misrenders is not a
 * choice, it is a bug with a menu entry.
 *
 * They stay in THEME_NAMES and PALETTES on purpose. Three things read that
 * table and would break if it shrank: tokens.test.ts pins it against the web
 * app's index.css, the server's branding presets share the same vocabulary and
 * an org admin can pin one of these names, and any device that already stored
 * `glass` as its preference would resolve to an undefined palette and crash on
 * boot. ThemeProvider maps them to their flat equivalents instead.
 */
export const PICKABLE_THEMES = THEME_NAMES.filter(
    (name) => name !== 'glass' && name !== 'glass-dark',
);

/** Themes whose ink is light — drives the status bar and keyboard appearance. */
export const DARK_THEMES: ReadonlySet<ThemeName> = new Set<ThemeName>([
    'dark',
    'glass-dark',
    'high-contrast',
    'obsidian',
]);

export interface Palette {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    bgCard: string;
    bgCardHover: string;

    accentPrimary: string;
    accentSecondary: string;
    accentPrimaryHover: string;
    /** Ink ON the accent. Never assume white — the default accent is light grey. */
    accentPrimaryFg: string;
    accentGlow: string;

    success: string;
    warning: string;
    error: string;
    /**
     * The blue the builder teaches as "AI step", and the colour a RUNNING run
     * wears (statusTokens.ts / features/automate/format.ts).
     *
     * Not part of the per-theme palette blocks in index.css: `--type-ai` is
     * declared once for the dark themes and once for the light ones, alongside
     * the other `--type-*` step families. tokens.test.ts reads it from there
     * rather than from a theme block, so the two-set shape is pinned too.
     */
    typeAi: string;

    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    /** Caption tier — declared per theme, NOT aliased to textMuted (WCAG). */
    textTertiary: string;

    borderSubtle: string;
    borderDefault: string;
    /**
     * Derived at runtime by ThemeProvider, never written in a palette below.
     *
     * They depend on other tokens (and on an org's custom accent, which only
     * exists at runtime), and the palettes here are pinned to the web app's
     * index.css by tokens.test.ts — so these two cannot live in the table
     * without either breaking that guard or being wrong for branded orgs.
     */
    /** An accent shade that actually reaches 4.5:1 on `bgCard`. */
    accentText: string;
    /** A card edge that stays visible when `bgCard` equals `bgSecondary`. */
    cardBorder: string;
    /** A fill for a primary button that does not read as a disabled control. */
    accentFill: string;
    /** The label on `accentFill`. */
    accentFillFg: string;

    /** Chat bubble for the user's own messages. */
    userBubbleBg: string;
    userBubbleFg: string;

    /** Row states: hover/pressed and selected. */
    itemHoverBg: string;
    itemActiveBg: string;

    /**
     * True when the theme's surfaces are translucent and want a blur behind
     * them. Only the two glass themes set this; everything else paints flat.
     */
    glass: boolean;
    /** Ground painted behind translucent surfaces on a glass theme. */
    glassBackdrop: string;
}

/**
 * `color-mix(in srgb, <colour> <pct>%, transparent)` — the two row-state
 * tokens are the only place the web app uses it, and both mix against
 * transparent, which is just an alpha change on the source colour.
 */
function mixAlpha(hex: string, pct: number): string {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${(pct / 100).toFixed(3)})`;
}

/**
 * A palette before ThemeProvider derives `accentText` and `cardBorder` from it.
 *
 * The distinction is load-bearing, not bookkeeping: it is what makes the
 * compiler guarantee derivation happens exactly once, after org branding and
 * before any screen reads a colour. Nothing outside ThemeProvider can get hold
 * of a `PaletteSource` and mistake it for a finished `Palette`.
 */
export type PaletteSource = Omit<
    Palette,
    'accentText' | 'cardBorder' | 'accentFill' | 'accentFillFg'
>;

function withRowStates(
    p: Omit<PaletteSource, 'itemHoverBg' | 'itemActiveBg'>,
): PaletteSource {
    return {
        ...p,
        itemHoverBg: mixAlpha(p.textPrimary, 7),
        itemActiveBg: mixAlpha(p.accentPrimary, 12),
    };
}

export const PALETTES: Record<ThemeName, PaletteSource> = {
    dark: withRowStates({
        bgPrimary: '#0f0f13',
        bgSecondary: '#16161d',
        bgTertiary: '#1e1e28',
        bgCard: '#1a1a24',
        bgCardHover: '#22222e',
        accentPrimary: '#9ca3af',
        accentSecondary: '#d1d5db',
        accentPrimaryHover: '#6b7280',
        accentPrimaryFg: '#111827',
        accentGlow: 'rgba(156, 163, 175, 0.2)',
        success: '#10b981',
        warning: '#f59e0b',
        error: '#ef4444',
        typeAi: '#82aaf0',
        textPrimary: '#f8fafc',
        textSecondary: '#94a3b8',
        textMuted: '#64748b',
        textTertiary: '#8b9bb0',
        borderSubtle: 'rgba(255, 255, 255, 0.06)',
        borderDefault: 'rgba(255, 255, 255, 0.1)',
        userBubbleBg: '#2a2a36',
        userBubbleFg: '#f8fafc',
        glass: false,
        glassBackdrop: '#0f0f13',
    }),

    light: withRowStates({
        bgPrimary: '#fafafa',
        bgSecondary: '#f3f3f3',
        bgTertiary: '#e5e5e5',
        bgCard: '#ffffff',
        bgCardHover: '#fafafa',
        accentPrimary: '#9ca3af',
        accentSecondary: '#d1d5db',
        accentPrimaryHover: '#6b7280',
        accentPrimaryFg: '#111827',
        accentGlow: 'rgba(156, 163, 175, 0.12)',
        success: '#059669',
        warning: '#d97706',
        error: '#dc2626',
        typeAi: '#3f6fc4',
        textPrimary: '#0f172a',
        textSecondary: '#334155',
        textMuted: '#64748b',
        textTertiary: '#55606d',
        borderSubtle: 'rgba(0, 0, 0, 0.06)',
        borderDefault: 'rgba(0, 0, 0, 0.12)',
        userBubbleBg: '#e8e8ee',
        userBubbleFg: '#0f172a',
        glass: false,
        glassBackdrop: '#fafafa',
    }),

    glass: withRowStates({
        // bg-primary is `transparent` on the web, where a wallpaper layer sits
        // behind it. RN has no such stacking context for a root view, so the
        // backdrop below is painted by ThemeProvider and the surfaces stay
        // translucent over it.
        bgPrimary: 'transparent',
        bgSecondary: 'rgba(255, 255, 255, 0.06)',
        bgTertiary: 'rgba(255, 255, 255, 0.10)',
        bgCard: 'rgba(255, 255, 255, 0.55)',
        bgCardHover: 'rgba(255, 255, 255, 0.68)',
        accentPrimary: '#6b7280',
        accentSecondary: '#9ca3af',
        accentPrimaryHover: '#4b5563',
        accentPrimaryFg: '#ffffff',
        accentGlow: 'rgba(107, 114, 128, 0.22)',
        success: '#059669',
        warning: '#d97706',
        error: '#dc2626',
        typeAi: '#3f6fc4',
        textPrimary: '#0f172a',
        textSecondary: '#1e293b',
        textMuted: '#475569',
        textTertiary: '#475569',
        borderSubtle: 'rgba(255, 255, 255, 0.40)',
        borderDefault: 'rgba(255, 255, 255, 0.55)',
        userBubbleBg: 'rgba(255, 255, 255, 0.55)',
        userBubbleFg: '#0f172a',
        glass: true,
        glassBackdrop: '#e7eaf0',
    }),

    'glass-dark': withRowStates({
        bgPrimary: 'transparent',
        bgSecondary: 'rgba(15, 23, 42, 0.30)',
        bgTertiary: 'rgba(15, 23, 42, 0.40)',
        bgCard: 'rgba(15, 23, 42, 0.55)',
        bgCardHover: 'rgba(15, 23, 42, 0.68)',
        accentPrimary: '#9ca3af',
        accentSecondary: '#cbd5e1',
        accentPrimaryHover: '#d1d5db',
        accentPrimaryFg: '#111827',
        accentGlow: 'rgba(156, 163, 175, 0.30)',
        success: '#34d399',
        warning: '#fbbf24',
        error: '#f87171',
        typeAi: '#82aaf0',
        textPrimary: '#f8fafc',
        textSecondary: '#cbd5e1',
        textMuted: '#94a3b8',
        textTertiary: '#94a3b8',
        borderSubtle: 'rgba(255, 255, 255, 0.10)',
        borderDefault: 'rgba(255, 255, 255, 0.20)',
        userBubbleBg: 'rgba(15, 23, 42, 0.55)',
        userBubbleFg: '#f8fafc',
        glass: true,
        glassBackdrop: '#111827',
    }),

    'high-contrast': withRowStates({
        bgPrimary: '#000000',
        bgSecondary: '#0a0a0a',
        bgTertiary: '#141414',
        bgCard: '#000000',
        bgCardHover: '#1a1a1a',
        accentPrimary: '#ffd400',
        accentSecondary: '#ffeb70',
        accentPrimaryHover: '#fff080',
        accentPrimaryFg: '#000000',
        accentGlow: 'rgba(255, 212, 0, 0.35)',
        success: '#00ff66',
        warning: '#ffaa00',
        error: '#ff5252',
        // The dark set's blue, not the light set's, even though index.css
        // groups this theme with the light ones for --type-*. Those sets are
        // grouped by surface lightness and this theme's card is #000000: the
        // light #3f6fc4 measures 4.28:1 there, and this is the value a RUNNING
        // run is written in. index.css re-declares it in the high-contrast
        // block for the same reason (8.96:1); tokens.test.ts pins the pair.
        typeAi: '#82aaf0',
        textPrimary: '#ffffff',
        textSecondary: '#e5e5e5',
        textMuted: '#b0b0b0',
        textTertiary: '#b0b0b0',
        borderSubtle: 'rgba(255, 255, 255, 0.35)',
        borderDefault: 'rgba(255, 255, 255, 0.65)',
        userBubbleBg: '#ffffff',
        userBubbleFg: '#000000',
        glass: false,
        glassBackdrop: '#000000',
    }),

    paper: withRowStates({
        bgPrimary: '#fdfcf8',
        bgSecondary: '#f7f4ed',
        bgTertiary: '#f0ebe0',
        bgCard: '#fffdf7',
        bgCardHover: '#fff9ed',
        accentPrimary: '#b45309',
        accentSecondary: '#d97706',
        accentPrimaryHover: '#92400e',
        accentPrimaryFg: '#ffffff',
        accentGlow: 'rgba(180, 83, 9, 0.18)',
        success: '#15803d',
        warning: '#b45309',
        error: '#b91c1c',
        typeAi: '#3f6fc4',
        textPrimary: '#1c1917',
        textSecondary: '#292524',
        textMuted: '#57534e',
        textTertiary: '#57534e',
        borderSubtle: 'rgba(120, 53, 15, 0.08)',
        borderDefault: 'rgba(120, 53, 15, 0.18)',
        userBubbleBg: '#f0ebe0',
        userBubbleFg: '#1c1917',
        glass: false,
        glassBackdrop: '#fdfcf8',
    }),

    obsidian: withRowStates({
        bgPrimary: '#0a0a0c',
        bgSecondary: '#131316',
        bgTertiary: '#1c1c20',
        bgCard: '#131316',
        bgCardHover: '#1c1c20',
        accentPrimary: '#e7e5e4',
        accentSecondary: '#f5f5f4',
        accentPrimaryHover: '#d6d3d1',
        accentPrimaryFg: '#000000',
        accentGlow: 'rgba(231, 229, 228, 0.15)',
        success: '#4ade80',
        warning: '#fbbf24',
        error: '#f87171',
        typeAi: '#82aaf0',
        textPrimary: '#fafaf9',
        textSecondary: '#d6d3d1',
        textMuted: '#a8a29e',
        textTertiary: '#a8a29e',
        borderSubtle: 'rgba(255, 255, 255, 0.06)',
        borderDefault: 'rgba(255, 255, 255, 0.12)',
        userBubbleBg: '#1c1c20',
        userBubbleFg: '#fafaf9',
        glass: false,
        glassBackdrop: '#0a0a0c',
    }),

    sepia: withRowStates({
        bgPrimary: '#f4ede0',
        bgSecondary: '#ebe2d2',
        bgTertiary: '#ddd2bd',
        bgCard: '#fbf6ec',
        bgCardHover: '#f4ede0',
        accentPrimary: '#c2410c',
        accentSecondary: '#ea580c',
        accentPrimaryHover: '#9a3412',
        accentPrimaryFg: '#ffffff',
        accentGlow: 'rgba(194, 65, 12, 0.18)',
        success: '#166534',
        warning: '#a16207',
        error: '#991b1b',
        typeAi: '#3f6fc4',
        textPrimary: '#44322c',
        textSecondary: '#5c443a',
        textMuted: '#8a6f5e',
        textTertiary: '#6f5849',
        borderSubtle: 'rgba(68, 50, 44, 0.10)',
        borderDefault: 'rgba(68, 50, 44, 0.22)',
        userBubbleBg: '#e8dcc4',
        userBubbleFg: '#44322c',
        glass: false,
        glassBackdrop: '#f4ede0',
    }),
};

/**
 * Base radii, before --radius-scale. ThemeProvider multiplies these so the
 * admin roundness dial keeps working.
 */
export const RADII = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;

/**
 * 4px spacing scale. The web app is on Tailwind's default scale; these are the
 * steps it actually uses, named rather than numbered so a screen reads as
 * intent instead of arithmetic.
 */
export const SPACING = {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
    xxxl: 48,
} as const;

/**
 * Type scale. `--font-sans` is Inter on the web; on Android Inter is not a
 * system face, so we ship the variable font and fall back to Roboto rather
 * than to whatever the OEM picked.
 */
export const FONTS = {
    regular: 'Inter_400Regular',
    medium: 'Inter_500Medium',
    semibold: 'Inter_600SemiBold',
    bold: 'Inter_700Bold',
    mono: 'monospace',
} as const;

export const TYPE = {
    /** Screen titles. */
    title: { fontSize: 28, lineHeight: 34, fontFamily: FONTS.bold, letterSpacing: -0.5 },
    /** Section headers and sheet titles. */
    heading: { fontSize: 20, lineHeight: 26, fontFamily: FONTS.semibold, letterSpacing: -0.3 },
    /** Card titles, list row primary text. */
    subheading: { fontSize: 16, lineHeight: 22, fontFamily: FONTS.semibold },
    /** Default reading size. Chat message text lives here. */
    body: { fontSize: 15, lineHeight: 22, fontFamily: FONTS.regular },
    /** List row secondary text, timestamps. */
    caption: { fontSize: 13, lineHeight: 18, fontFamily: FONTS.regular },
    /** Badges, meta. Never smaller than this — 11px is the floor on a phone. */
    label: { fontSize: 11, lineHeight: 15, fontFamily: FONTS.medium, letterSpacing: 0.2 },
    /** Code blocks and inline code. */
    code: { fontSize: 13, lineHeight: 20, fontFamily: FONTS.mono },
} as const;

/**
 * Elevation. Android renders `elevation`; the shadow* props are what actually
 * paint on the newer architecture, so both are set and kept consistent with
 * the web's --shadow-* steps.
 */
export const ELEVATION = {
    none: { elevation: 0 },
    card: { elevation: 1, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 2 } },
    raised: { elevation: 3, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
    popover: { elevation: 8, shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } },
} as const;

/**
 * Minimum touch target. Android's guidance is 48dp; several web controls in
 * Bee Flow are 32px, and every one of them has to grow here.
 */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TOUCH = 48;

/** Motion. Kept short — a phone that feels slow is a phone that feels broken. */
export const MOTION = {
    fast: 120,
    base: 200,
    slow: 320,
} as const;
