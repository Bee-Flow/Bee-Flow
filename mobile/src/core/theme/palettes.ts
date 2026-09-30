/**
 * The colour palettes: the web's own, per theme, plus what only the phone
 * needs.
 *
 * The web's colours are generated from agent-hub/src/index.css
 * (generated/webTokens.generated.ts, written by scripts/sync-web-tokens.mjs and
 * pinned by webTokens.lockstep.test.ts), so a colour changed on the web
 * changes here by re-running the script, not by hand.
 *
 * `PaletteSource` is what a palette literally holds; `Palette` adds the four
 * colours ThemeProvider derives (derive.ts). Re-exported from tokens.ts, which
 * stays the one import for design tokens.
 */

import { WEB_THEMES, WEB_TOKENS, type WebColors, type WebTheme } from './generated/webTokens.generated';

export interface Palette extends WebColors {
    /** Ink ON the accent. Never assume white: the default accent is light grey. */
    accentPrimaryFg: string;
    /**
     * Caption tier. Declared per theme on the web, NOT aliased to textMuted:
     * textMuted fails WCAG AA at caption sizes in three themes.
     */
    textTertiary: string;
    /** Status TEXT (a chip's words); the raw status colour is for borders and dots. */
    successInk: string;
    warningInk: string;
    errorInk: string;
    /**
     * The blue the builder teaches as "AI step", and the colour a RUNNING run
     * wears (statusTokens.ts / features/automations/model/format.ts). The same
     * value as `theme.stepType.ai`, kept on the palette for those readers.
     */
    typeAi: string;

    /**
     * Derived at runtime by ThemeProvider (derive.ts), never written in a
     * palette: they depend on other tokens and on an org's custom accent,
     * which only exists at runtime.
     */
    /** An accent shade that actually reaches 4.5:1 on `bgCard`. */
    accentText: string;
    /** A card edge that stays visible when `bgCard` equals `bgSecondary`. */
    cardBorder: string;
    /** A fill for a primary button that does not read as a disabled control. */
    accentFill: string;
    /** The label on `accentFill`. */
    accentFillFg: string;

    /**
     * True when the theme's surfaces are translucent and want a blur behind
     * them. Only the two glass themes set this; everything else paints flat.
     */
    glass: boolean;
    /**
     * Ground painted behind translucent surfaces on a glass theme, where the
     * web has a wallpaper layer behind `bg-primary: transparent`.
     */
    glassBackdrop: string;
}

/**
 * A palette before ThemeProvider derives `accentText` and friends from it.
 *
 * The distinction is load-bearing, not bookkeeping: it is what makes the
 * compiler guarantee derivation happens exactly once, after org branding and
 * before any screen reads a colour. Nothing outside ThemeProvider can get hold
 * of a `PaletteSource` and mistake it for a finished `Palette`.
 */
export type PaletteSource = Omit<Palette, 'accentText' | 'cardBorder' | 'accentFill' | 'accentFillFg'>;

/** The phone's ground behind the glass themes (the web's wallpaper base). */
const GLASS_BACKDROP: Partial<Record<WebTheme, string>> = {
    glass: '#e7eaf0',
    'glass-dark': '#111827',
};

function paletteFor(name: WebTheme): PaletteSource {
    const web = WEB_TOKENS[name];
    const backdrop = GLASS_BACKDROP[name];
    return {
        ...web.colors,
        typeAi: web.stepType.ai,
        glass: backdrop !== undefined,
        glassBackdrop: backdrop ?? web.colors.bgPrimary,
    };
}

export const PALETTES = Object.fromEntries(WEB_THEMES.map((name) => [name, paletteFor(name)])) as Record<
    WebTheme,
    PaletteSource
>;
