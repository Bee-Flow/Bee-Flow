import type { CmsLink, CmsPageOption } from '../fields';
import type { BlockEditorProps, TextStyle } from './blockEditorTypes';

export interface HeaderLogo {
    src?: string;
    url?: string;
    text?: string;
    titleFont?: string;
    titleSize?: number;
    textColor?: string;
    showDot?: boolean;
}

export interface HeaderCta {
    id?: string;
    label?: string;
    link?: CmsLink;
    style?: string;
    labelFont?: string;
    labelSize?: number;
    labelColor?: string;
}

export interface MegaItem {
    id?: string;
    label?: string;
    link?: CmsLink;
    description?: string;
    icon?: string;
    openInNewTab?: boolean;
}

export interface MegaColumn {
    id?: string;
    heading?: string;
    items?: MegaItem[];
}

export interface HeaderDropdown {
    layout?: string;
    columns?: MegaColumn[];
}

export interface HeaderChild {
    id?: string;
    label?: string;
    link?: CmsLink;
}

export interface HeaderNavItem {
    id?: string;
    label?: string;
    link?: CmsLink;
    dropdown?: HeaderDropdown;
    children?: HeaderChild[];
}

export interface HeaderData {
    nav?: HeaderNavItem[];
    logo?: HeaderLogo;
    logoText?: string;
    ctas?: HeaderCta[];
    navStyle?: TextStyle;
}

export type HeaderEditorProps = BlockEditorProps<HeaderData> & { pages?: CmsPageOption[] };
