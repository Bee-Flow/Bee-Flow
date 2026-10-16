/**
 * Shapes shared by the marketing section renderers. A section's `data` is the
 * CMS block content the server stores, so every field is optional: an old page
 * simply lacks the keys a newer editor writes.
 */

import type { TextStyleInput } from './textStyle';
import type { ClipMedia } from '../components/ClipVideo';

/** `{ fontFamily?, fontSize?, color? }` from the editor's StyleTriplet. */
export type TextStyleBlob = TextStyleInput;

/** The header fields (eyebrow, title, lead and their styling) most sections carry. */
export interface SectionHeaderFields {
    eyebrow?: string;
    title?: string;
    lead?: string;
    eyebrowStyle?: TextStyleBlob;
    titleStyle?: TextStyleBlob;
    leadStyle?: TextStyleBlob;
    eyebrowAlign?: string;
    titleAlign?: string;
    leadAlign?: string;
    align?: string;
}

/** What every section's `data` has in common. */
export interface SectionDataBase extends SectionHeaderFields {
    enabled?: boolean;
    backgroundVariant?: string;
}

/** A link target as the CMS stores it. */
export interface CmsHref {
    href?: string;
}

/** The media slot shape FramedMedia renders (image, silent video, or clip with sound). */
export interface MediaSlot extends ClipMedia {
    srcDark?: string;
    frame?: string;
    kind?: string;
    width?: number;
    height?: number;
    /** Scroll-linked motion on the frame: 'parallax' | 'scale' (CSS only, off with reduced motion). */
    motion?: string;
}
