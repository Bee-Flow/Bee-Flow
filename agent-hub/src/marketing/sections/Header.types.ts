import type { SectionDataBase, TextStyleBlob } from './sectionData.types';
import type { NavLinkData } from './navShared';

interface HeaderLogo {
    url?: string;
    src?: string;
    text?: string;
    showDot?: boolean;
    textColor?: string;
    titleFont?: string;
    titleSize?: number;
    fontSize?: string;
}

export interface HeaderCta {
    id?: string;
    label?: string;
    href?: string;
    target?: string;
    rel?: string;
    style?: string;
    labelFont?: string;
    labelSize?: number;
    labelColor?: string;
    /** 'link' (default) or 'github': a GitHub button with the cached star count. */
    kind?: string;
    repoUrl?: string;
    /** Shown when the server has no cached count yet, or its count is for another repository. */
    starsFallback?: number;
    /** Screen-reader text of the GitHub button: the word after the count, and the new-tab note. */
    starsText?: string;
    newTabText?: string;
}

export interface HeaderData extends Pick<SectionDataBase, 'enabled'> {
    logo?: HeaderLogo;
    logoText?: string;
    navLinks?: NavLinkData[];
    activeSlug?: string;
    navStyle?: TextStyleBlob;
    ctas?: HeaderCta[];
}

export interface HeaderProps {
    data?: HeaderData;
    showLanguageSwitcher?: boolean;
}
