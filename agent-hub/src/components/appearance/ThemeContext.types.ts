/** One glass tier's override: blur in px, saturate in %, brightness as a factor. */
export interface GlassTier {
    blur: number;
    saturate: number;
    brightness: number;
}

/** The knobs a theme is made of, as the branding endpoints send and take them. */
export interface ThemeSettings {
    preset: string;
    accent: string;
    radiusScale: number;
    font: string;
    wallpaperOverlay: number;
    glassIntensity: number;
    wallpaperPreset: string;
    glassTint: string;
    glassLens: string;
    glassAnimation: string;
    glassGrain: string;
    glassBorder: string;
    glassTierSubtle: GlassTier | null;
    glassTierDefault: GlassTier | null;
    glassTierOpaque: GlassTier | null;
    wallpaperUrl: string | null;
    allowUserOverride: boolean;
    source: string;
}

export interface ThemeState extends ThemeSettings {
    loading: boolean;
    error: string | null;
}

interface ThemeActions {
    setUserOverride: (patch: Partial<ThemeSettings>) => Promise<unknown>;
    clearUserOverride: () => Promise<unknown>;
    setAdminDefault: (patch: Partial<ThemeSettings>) => Promise<unknown>;
    uploadWallpaper: (file: File | Blob) => Promise<unknown>;
    deleteWallpaper: () => Promise<void>;
    reload: () => Promise<void>;
}

export type ThemeContextValue = ThemeState & ThemeActions;

export interface PreviewMode {
    inPreview: boolean;
    initial: Partial<ThemeSettings> | null;
}

export interface ThemeOption {
    id: string;
    label: string;
}

export interface ThemeProviderProps {
    children?: React.ReactNode;
    initialOverride?: Partial<ThemeSettings> | null;
}
