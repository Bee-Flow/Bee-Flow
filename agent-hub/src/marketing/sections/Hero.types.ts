import type { MediaSlot, SectionDataBase } from './sectionData.types';
import type { TextStyleBlob } from './sectionData.types';

export interface HeroCta {
    enabled?: boolean;
    label?: string;
    style?: string;
    href?: string;
    link?: { href?: string; newTab?: boolean };
    openInNewTab?: boolean;
}

export interface HeroBubble {
    role?: string;
    text?: string;
}

export interface HeroTitlePart {
    text?: string;
    gradient?: boolean;
}

export interface HeroData extends SectionDataBase {
    badge?: { enabled?: boolean; text?: string; icon?: string };
    badgeStyle?: TextStyleBlob;
    badgeAlign?: string;
    titleParts?: HeroTitlePart[];
    leadEnabled?: boolean;
    primaryCta?: HeroCta;
    secondaryCta?: HeroCta;
    mockup?: { enabled?: boolean; chatBubbles?: HeroBubble[] };
    variant?: string;
    media?: MediaSlot;
}

