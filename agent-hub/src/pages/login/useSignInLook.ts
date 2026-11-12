import { useLayoutEffect } from 'react';
import { useTheme } from '../../components/appearance/ThemeContext';

const DARK_SURFACE_PRESETS = new Set(['dark', 'obsidian', 'glass-dark']);

/**
 * The preset the sign-in screens are drawn in: glass, in the lightness the
 * organisation chose. High contrast is an accessibility choice and stays.
 */
export function signInPreset(preset: string): string {
    if (preset === 'high-contrast') return preset;
    return DARK_SURFACE_PRESETS.has(preset) ? 'glass-dark' : 'glass';
}

/**
 * Draws the document in the sign-in look for as long as the calling screen is
 * mounted. Lives here, not in the theme provider, so the public entry does
 * not carry it (the login page is a lazy chunk).
 */
export function useSignInLook(): void {
    const { setScreenPreset } = useTheme();
    useLayoutEffect(() => {
        setScreenPreset(signInPreset);
        return () => setScreenPreset(null);
    }, [setScreenPreset]);
}
