/** Content shapes for the motion and rich-media options of the CMS blocks (issue 244). */

export interface BackgroundVideoData {
    /** MP4 address (cms asset key or URL). */
    src?: string;
    /** Optional WebM twin; browsers that play it take it instead of the MP4. */
    webmSrc?: string;
    /** Still frame: shown first, and instead of the video on phones, with reduced motion and with a data saver. */
    poster?: string;
    fit?: string;
    position?: string;
    overlay?: string;
    overlayColor?: string;
    /** 0 to 100. */
    overlayOpacity?: number;
}

export interface TourData {
    enabled?: boolean;
    /** The full product tour, played with controls in the modal. */
    src?: string;
    poster?: string;
    captionsSrc?: string;
    captionsLang?: string;
    /** Pill text, for example "Watch product tour". */
    label?: string;
    /** Pill suffix, for example "4 minutes". */
    duration?: string;
    /** Short muted loop shown as the block's visual, with the pill on top of it. */
    teaserSrc?: string;
    /** Where the pill sits on the teaser: in the frame's corner (default) or under it. */
    teaserPill?: 'corner' | 'below';
    alt?: string;
}
