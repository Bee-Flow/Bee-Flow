import type { ContentData, ContentElement as ContentElementData } from './contentMigration';
import type { SectionDataBase, TextStyleBlob } from './sectionData.types';

/** A link as the public site leaves it (resolveLinksInTree) or the admin preview does (legacyifyLinks). */
export interface RenderedLink {
    href?: string;
    target?: string;
    rel?: string;
}

/** An element as the renderer reads it: the migrated shape plus the optional per-kind fields. */
export interface RenderElement extends Omit<ContentElementData, 'link' | 'height'> {
    /* Published blocks carry the intrinsic size (server/core/cms/mediaDims.js);
       older ones have neither, and `undefined > 0` is false, which is how the
       renderer reads them. Typed as numbers for that comparison. */
    width: number;
    height: number;
    headingStyle?: TextStyleBlob;
    subheadingStyle?: TextStyleBlob;
    bodyStyle?: TextStyleBlob;
    headingAlign?: string;
    subheadingAlign?: string;
    bodyAlign?: string;
    frame?: string;
    fullBleed?: boolean;
    lightbox?: boolean;
    source?: string;
    href?: string;
    target?: string;
    rel?: string;
    link?: RenderedLink;
}

export type ContentBlockData = SectionDataBase & ContentData;
