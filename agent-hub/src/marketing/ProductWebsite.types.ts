import type { ComponentProps, ComponentType } from 'react';
import type { AnnouncementText } from './components/AnnouncementBar';
import type { TrackerOptions } from './components/AnalyticsTracker';
import type { CmsSeo } from './useCmsHead';
import type { BlogPayload } from './blog/blogFormat';
import type { HeaderData } from './sections/Header.types';
import type { FooterData } from './sections/Footer.types';
import type { TextStyleBlob } from './sections/sectionData.types';
import type Hero from './sections/Hero';
import type SocialProof from './sections/SocialProof';
import type Features from './sections/Features';
import type Steps from './sections/Steps';
import type Security from './sections/Security';
import type Integrations from './sections/Integrations';
import type Architecture from './sections/Architecture';
import type TechStats from './sections/TechStats';
import type CTA from './sections/CTA';

/** A registered section renderer: every block type receives its CMS content as `data`. */
export type SectionComponent = ComponentType<{ data: Record<string, unknown>; sectionId?: string }>;

/** Colour tokens of one theme (site.design.colors / darkColors). */
export interface DesignColors {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    surface?: string;
    textPrimary?: string;
    textSecondary?: string;
    /** Colour roles; '' (or absent) follows `primary`. */
    cta?: string;
    link?: string;
    highlight?: string;
    tile?: string;
}

export interface DesignTypography {
    displaySize?: string;
    headingWeight?: number;
    displayTracking?: string;
    bodySize?: number;
}

/** What the Design tab edits: a design whose colors and fonts are always present. */
export type EditableDesign = SiteDesign & {
    colors: DesignColors;
    fonts: { heading: string; body: string; mono?: string };
};

export interface DesignComponents {
    buttonShape?: string;
    buttonSize?: string;
    buttonTextColor?: string;
    navHeight?: string;
    navStyle?: string;
    logoSize?: string;
    cardPadding?: string;
    cardStyle?: string;
    shadow?: string;
    tileShape?: string;
    tileFill?: string;
    tileSize?: string;
    tileIconColor?: string;
    labelStyle?: string;
}

export interface DesignLayout {
    containerWidth?: string;
    sectionRhythm?: string;
}

/** The user-customizable design system (site.design). Every field is optional. */
export interface SiteDesign {
    theme?: string;
    colors?: DesignColors;
    darkColors?: DesignColors;
    fonts?: { heading?: string; body?: string; mono?: string };
    radius?: number;
    typography?: DesignTypography;
    components?: DesignComponents;
    layout?: DesignLayout;
    gradient?: boolean;
    grain?: boolean;
    motion?: string;
    darkBand?: string;
    preset?: string;
    logo?: string;
    favicon?: string;
}

/** Per-block colour overrides (block.style.colorOverrides). */
export interface BlockColorOverrides {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    surface?: string;
    text?: string;
    textSecondary?: string;
}

/** Per-block wrapper styling (block.style). */
export interface BlockStyle {
    maxWidth?: string;
    align?: string;
    backgroundImage?: string;
    backgroundOverlay?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
    backgroundHideMobile?: boolean;
    motif?: string;
    motifSide?: string;
    motifTiles?: boolean;
    decor?: string;
    cardFill?: string;
    labelStyle?: string;
    band?: string;
    rhythm?: string;
    glow?: boolean;
    reveal?: string;
    anchor?: string;
    cssClass?: string;
    columns?: number | string;
    spacing?: { paddingTop?: string; paddingBottom?: string };
    colorOverrides?: BlockColorOverrides;
}

/** Block content: the font fields the page walks, anything else passes through to the section. */
export interface BlockContent {
    badgeStyle?: TextStyleBlob;
    titleStyle?: TextStyleBlob;
    leadStyle?: TextStyleBlob;
    eyebrowStyle?: TextStyleBlob;
    [key: string]: unknown;
}

export interface CmsBlock {
    id: string;
    type: string;
    enabled?: boolean;
    content?: BlockContent;
    style?: BlockStyle;
}

/** The CMS content tree (the `content` prop, or a `cms-preview` payload). */
export interface SiteContent {
    blocks?: CmsBlock[];
    design?: SiteDesign | null;
    pageTitle?: string;
    seo?: CmsSeo;
    hideHeader?: boolean;
    hideFooter?: boolean;
    blog?: BlogPayload | null;
    header?: HeaderData;
    footer?: FooterData | null;
    announcement?: {
        enabled?: boolean;
        dismissible?: boolean;
        variant?: string;
        text?: AnnouncementText;
    };
    cookieBanner?: {
        enabled?: boolean;
        /** card (default) | bar | corner */
        layout?: string;
        text?: Record<string, Record<string, string> | undefined>;
    };
    // Legacy keyed shape, rendered by the public site at "/" when there is no blocks[].
    hero?: ComponentProps<typeof Hero>['data'];
    socialProof?: ComponentProps<typeof SocialProof>['data'];
    features?: ComponentProps<typeof Features>['data'];
    steps?: ComponentProps<typeof Steps>['data'];
    security?: ComponentProps<typeof Security>['data'];
    integrations?: ComponentProps<typeof Integrations>['data'];
    architecture?: ComponentProps<typeof Architecture>['data'];
    techStats?: ComponentProps<typeof TechStats>['data'];
    cta?: ComponentProps<typeof CTA>['data'];
}

/** The usage-tracker config the server passes next to the content. */
export interface AnalyticsConfig {
    disabledForPage?: boolean;
    websiteId?: string;
    scriptUrl?: string | null;
    consentMode?: string | null;
    trackerOptions?: TrackerOptions | null;
    recorderUrl?: string | null;
    ga?: { measurementId?: string | null };
}

/** The postMessages the admin panel sends into the preview iframe. */
export interface PreviewMessage {
    type?: string;
    content?: SiteContent;
    design?: SiteDesign | null;
    previewMode?: string | null;
    blockId?: unknown;
    locked?: unknown;
    labels?: Record<string, string>;
}

export interface CmsActiveState {
    blockId: string | null;
    locked: boolean;
    labels: Record<string, string>;
}

export interface ProductWebsiteProps {
    content?: SiteContent;
    analytics?: AnalyticsConfig | null;
}
