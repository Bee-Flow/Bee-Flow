import type { MediaSlot, SectionDataBase } from './sectionData.types';
import type { TextStyleBlob } from './sectionData.types';
import type { BackgroundVideoData, TourData } from '../motion/motion.types';

interface HeroCta {
    enabled?: boolean;
    label?: string;
    style?: string;
    href?: string;
    link?: { href?: string; newTab?: boolean };
    openInNewTab?: boolean;
}

interface HeroBubble {
    role?: string;
    text?: string;
}

interface HeroTitlePart {
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
    backgroundVideo?: BackgroundVideoData;
    tour?: TourData;
}

