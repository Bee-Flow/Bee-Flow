import type { SectionDataBase, TextStyleBlob } from './sectionData.types';

export interface FooterLink {
    label?: string;
    href?: string;
    target?: string;
    rel?: string;
}

export interface FooterColumn {
    heading?: string;
    links?: FooterLink[];
}

export interface FooterSocial {
    platform?: string;
    href?: string;
    target?: string;
    rel?: string;
}

export interface FooterAccountability {
    address?: string;
    registration?: string;
    vat?: string;
    links?: FooterLink[];
}

export interface FooterData extends Pick<SectionDataBase, 'enabled'> {
    brand?: { logoText?: string; blurb?: string; showDot?: boolean };
    columns?: FooterColumn[];
    socials?: FooterSocial[];
    copyright?: string;
    accountability?: FooterAccountability;
    showLanguageSwitcher?: boolean;
    themeSwitcher?: { enabled?: boolean };
    linkStyle?: TextStyleBlob;
}

export interface FooterProps {
    data?: FooterData | null;
    isDark?: boolean;
    onToggleTheme?: () => void;
}
