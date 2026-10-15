import type { Align, CmsLink } from '../fields';

/** The per-element style sub-object the section header writes (`eyebrowStyle`, `titleStyle`, `leadStyle`). */
export interface TextStyle {
    fontFamily?: string;
    fontSize?: number;
    color?: string;
}

/** The eyebrow / title / lead group every list-section block shares. */
export interface SectionHeaderData {
    align?: Align;
    eyebrow?: string;
    eyebrowAlign?: Align;
    eyebrowStyle?: TextStyle;
    title?: string;
    titleAlign?: Align;
    titleStyle?: TextStyle;
    lead?: string;
    leadAlign?: Align;
    leadStyle?: TextStyle;
}

/** The background variant written by BackgroundCard / BackgroundVariantSelect. */
export interface BackgroundData {
    backgroundVariant?: string;
}

/** A CTA button value (primary or secondary). */
export interface CtaButton {
    label?: string;
    link?: CmsLink;
    style?: string;
}

/** The props every block editor takes. */
export interface BlockEditorProps<T> {
    data?: T;
    onChange: (next: T) => void;
}
