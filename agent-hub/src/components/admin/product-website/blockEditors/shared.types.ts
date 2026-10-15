// Stored-shape types for the helpers in ./shared.tsx (block content blobs).
import type { CmsLink } from '../fields';

export interface StyleBlob {
    fontFamily?: string;
    fontSize?: number;
    color?: string | null;
}

export interface SectionHeaderData {
    eyebrow?: string;
    eyebrowAlign?: string;
    eyebrowStyle?: StyleBlob;
    title?: string;
    titleAlign?: string;
    titleStyle?: StyleBlob;
    lead?: string;
    leadAlign?: string;
    leadStyle?: StyleBlob;
    align?: string;
    [key: string]: unknown;
}

export interface CtaButtonValue {
    label?: string;
    link?: CmsLink;
    style?: string;
}

export type GroupRecord = Record<string, unknown>;

export interface CardActionItem {
    cardAction?: string;
    cardUrl?: string;
    popupEmbed?: string;
    [key: string]: unknown;
}
