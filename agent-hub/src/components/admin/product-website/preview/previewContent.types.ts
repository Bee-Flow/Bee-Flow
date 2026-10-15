// Link, chrome and page shapes read by previewContent.ts (the SiteDoc slice
// the marketing preview renders). Kept apart so the content-shaping module
// stays within the file-size budget.

export interface PreviewLink {
    kind?: string;
    anchor?: string;
    path?: string;
    url?: string;
    pageId?: string;
    newTab?: boolean;
    [key: string]: unknown;
}

export interface PreviewPageRef {
    id?: string;
    slug?: string;
    isHomepage?: boolean;
}

export interface PreviewCta {
    id?: string;
    label?: string;
    link?: PreviewLink;
    style?: string;
    labelFont?: string;
    labelSize?: unknown;
    labelColor?: string;
}

export interface PreviewMenuItem {
    label?: string;
    link?: PreviewLink;
    description?: string;
    icon?: string;
    openInNewTab?: boolean;
}

export interface PreviewNavItem {
    label?: string;
    link?: PreviewLink;
    children?: { label?: string; link?: PreviewLink }[];
    dropdown?: {
        layout?: string;
        columns?: { heading?: string; items?: PreviewMenuItem[] }[];
    };
}

export interface PreviewHeader {
    enabled?: boolean;
    logoText?: string;
    logo?: unknown;
    loginLabel?: string;
    ctas?: PreviewCta[];
    navStyle?: unknown;
    nav?: PreviewNavItem[];
}

export interface PreviewFooter {
    enabled?: boolean;
    themeSwitcher?: { enabled?: boolean };
    brandText?: string;
    blurb?: string;
    showBrandDot?: boolean;
    linkStyle?: unknown;
    columns?: { heading?: string; links?: { label?: string; link?: PreviewLink }[] }[];
    socials?: { platform?: string; link?: PreviewLink }[];
    copyright?: string;
    accountability?: unknown;
    showLanguageSwitcher?: boolean;
}
