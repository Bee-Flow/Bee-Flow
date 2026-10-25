import type { PreviewMode, ThemeSettings, ThemeState } from './ThemeContext.types';
import { logger } from '../../utils/logger';
import { BOOTSTRAP_KEY } from './ThemeContext.constants';

export function readBootstrap(): Partial<ThemeSettings> | null {
    try {
        const raw = localStorage.getItem(BOOTSTRAP_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

export function writeBootstrap(theme: ThemeState) {
    try {
        localStorage.setItem(BOOTSTRAP_KEY, JSON.stringify({
            preset: theme.preset,
            accent: theme.accent,
            radiusScale: theme.radiusScale,
            font: theme.font,
            wallpaperUrl: theme.wallpaperUrl,
            wallpaperOverlay: theme.wallpaperOverlay,
            glassIntensity: theme.glassIntensity,
            // Glass v2 attrs — applied by the pre-React bootstrap script in
            // index.html so the page paints with the right look on first frame.
            wallpaperPreset: theme.wallpaperPreset,
            glassTint: theme.glassTint,
            glassLens: theme.glassLens,
            glassAnimation: theme.glassAnimation,
            glassGrain: theme.glassGrain,
            glassBorder: theme.glassBorder,
        }));
    } catch (err) { logger.debug('quota, ignore', err); }
}

export function detectPreviewMode(): PreviewMode {
    if (typeof window === 'undefined') return { inPreview: false, initial: null };
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('themePreview') !== '1') return { inPreview: false, initial: null };
        const t = params.get('t');
        if (!t) return { inPreview: true, initial: null };
        // URL-safe base64 → standard base64 → JSON.
        const b64 = t.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const parsed = JSON.parse(atob(padded));
        if (!parsed || typeof parsed !== 'object') return { inPreview: true, initial: null };
        return { inPreview: true, initial: parsed };
    } catch (e) {
        console.warn('[Theme] preview payload parse failed:', e);
        return { inPreview: true, initial: null };
    }
}
