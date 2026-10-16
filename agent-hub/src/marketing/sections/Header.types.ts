import type { SectionDataBase, TextStyleBlob } from './sectionData.types';
import type { NavLinkData } from './navShared';

export interface HeaderLogo {
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
}

export interface HeaderData extends Pick<SectionDataBase, 'enabled'> {
    logo?: HeaderLogo;
    logoText?: string;
    navLinks?: NavLinkData[];
    activeSlug?: string;
    navStyle?: TextStyleBlob;
    ctas?: HeaderCta[];
}
