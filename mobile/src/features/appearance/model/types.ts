/** Branding and theme shapes (server/routes/branding.js + stores/brandingStore.js). */

/**
 * `GET /api/branding/effective`.
 *
 * `preset` uses the same eight names as ThemeName in core/theme/tokens.ts, plus
 * `custom`. The phone paints each as Day or Night (core/theme/resolve.ts). `allowUserOverride` is the admin's switch: when it is false,
 * `PUT /api/branding/user` answers 403 and the accent is not the user's to
 * change. The three theme knobs are null when absent, which the theme reads as
 * "keep what you have".
 */
export interface EffectiveBranding {
    preset: string | null;
    accent: string | null;
    radiusScale: number | null;
    font: string;
    wallpaperUrl: string | null;
    allowUserOverride: boolean;
    /** 'default' | 'admin' | 'user' — where the winning value came from. */
    source: string;
}

/**
 * `GET /api/branding/public` — the unauthenticated subset, served for the login
 * screen. Same knobs as the effective payload minus the two that only mean
 * something for a known user, so a signed-out phone can paint the org's theme
 * instead of guessing from the device.
 */
export type PublicBranding = Omit<EffectiveBranding, 'allowUserOverride' | 'source'>;

/** `PUT /api/branding/user` body. Only these three survive the server's
 *  sanitiser for a non-admin (`allowAllKnobs: false` in brandingStore). */
export interface UserBrandingPatch {
    preset?: string;
    accent?: string;
    wallpaperPreset?: string;
}

export interface UserBrandingResponse {
    override: UserBrandingPatch | null;
    effective: EffectiveBranding;
}
