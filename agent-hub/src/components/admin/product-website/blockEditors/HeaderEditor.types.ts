import type { CmsLink } from '../fields';
import type { StyleBlob } from '../primitives.types';

// Shapes of the header block's content blob that HeaderEditor reads.

export type HeaderLogo = {
    src?: string;
    url?: string;
    text?: string;
    titleFont?: string;
    titleSize?: number;
    textColor?: string;
    showDot?: boolean;
};
export type HeaderCta = {
    id?: string;
    label?: string;
    link?: CmsLink;
    style?: string;
    labelFont?: string;
    labelSize?: number;
    labelColor?: string;
    kind?: string;
    repoUrl?: string;
    starsFallback?: number;
    starsText?: string;
    newTabText?: string;
};
export type MegaItem = {
    id?: string;
    label?: string;
    link?: CmsLink;
    description?: string;
    icon?: string;
    openInNewTab?: boolean;
};
export type NavColumn = { id?: string; heading?: string; items?: MegaItem[] };
export type NavChild = { id?: string; label?: string; link?: CmsLink };
export type NavLink = {
    id?: string;
    label?: string;
    link?: CmsLink;
    children?: NavChild[];
    dropdown?: { layout?: string; columns?: NavColumn[] };
};
export type HeaderData = {
    nav?: NavLink[];
    logo?: HeaderLogo;
    /** Legacy brand text, used while `logo.text` is unset. */
    logoText?: string;
    ctas?: HeaderCta[];
    navStyle?: StyleBlob;
};
