import { createContext } from 'react';
import type { ThemeContextValue, ThemeOption, ThemeSettings } from './ThemeContext.types';

export const BOOTSTRAP_KEY = 'beeflow:theme:bootstrap';

export const DEFAULTS: ThemeSettings = Object.freeze({
    preset: 'light',
    accent: '#9ca3af',
    radiusScale: 1,
    font: 'system',
    wallpaperOverlay: 0.1,
    glassIntensity: 1,
    // Glass v2 config — drive [data-*] attrs on <html> for CSS to pick up.
    wallpaperPreset: 'mono',
    glassTint: 'neutral',
    glassLens: 'on',
    glassAnimation: 'off',
    glassGrain: 'subtle',
    glassBorder: 'subtle',
    glassTierSubtle: null,
    glassTierDefault: null,
    glassTierOpaque: null,
    wallpaperUrl: null,
    allowUserOverride: true,
    source: 'default',
});

export const ThemeContext = createContext<ThemeContextValue>({
    ...DEFAULTS,
    loading: true,
    error: null,
    setUserOverride: async () => {},
    clearUserOverride: async () => {},
    setAdminDefault: async () => {},
    uploadWallpaper: async () => {},
    deleteWallpaper: async () => {},
    reload: async () => {},
});

export const THEME_PRESETS: ThemeOption[] = [
    { id: 'light', label: 'Light' },
    { id: 'paper', label: 'Paper' },
    { id: 'sepia', label: 'Sepia' },
    { id: 'glass', label: 'Glass' },
    { id: 'glass-dark', label: 'Glass Dark' },
    { id: 'dark', label: 'Dark' },
    { id: 'obsidian', label: 'Obsidian' },
    { id: 'high-contrast', label: 'High Contrast' },
    { id: 'custom', label: 'Custom' },
];

export const FONT_OPTIONS: ThemeOption[] = [
    { id: 'system', label: 'System default' },
    { id: 'inter', label: 'Inter' },
    { id: 'plex', label: 'IBM Plex Sans' },
    { id: 'geist', label: 'Geist' },
];
