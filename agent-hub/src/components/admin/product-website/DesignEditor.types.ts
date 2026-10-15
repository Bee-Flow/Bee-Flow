/** The site design as the Design tab reads and writes it (site.design). */

export interface DesignColors {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    textPrimary: string;
    textSecondary: string;
}

export interface DesignDarkColors {
    background?: string;
    surface?: string;
    textPrimary?: string;
    textSecondary?: string;
    primary?: string;
    accent?: string;
}

export interface DesignFonts {
    heading: string;
    body: string;
    mono?: string;
}

export interface DesignTypography {
    displaySize?: string;
    headingWeight?: number;
    bodySize?: number;
}

export interface DesignComponents {
    buttonShape?: string;
    buttonSize?: string;
    buttonTextColor?: string;
    navStyle?: string;
    navHeight?: string;
    logoSize?: string;
    cardStyle?: string;
    cardPadding?: string;
    shadow?: string;
}

export interface DesignLayout {
    containerWidth?: string;
    sectionRhythm?: string;
}

export interface CmsDesign {
    colors: DesignColors;
    darkColors?: DesignDarkColors;
    fonts: DesignFonts;
    logo?: string;
    favicon?: string;
    radius?: number;
    theme?: string;
    gradient?: boolean;
    preset?: string;
    typography?: DesignTypography;
    motion?: string;
    grain?: boolean;
    components?: DesignComponents;
    layout?: DesignLayout;
}

/** A theme preset as the gallery shows it: its label, blurb and the design it applies. */
export interface ThemePresetLike {
    id: string;
    label: string;
    description?: string;
    design: CmsDesign & { darkColors: DesignDarkColors; typography: DesignTypography };
}
