/**
 * The shapes behind building a page: its knowledge sources, its version
 * history and its three file slots. Written from the server's own mappers:
 *
 *   WebpageSource   server/stores/webpage/sources.js      → mapSourceRow
 *   WebpageVersion  server/stores/webpage/versions.js     → getVersions,
 *                   decorated by routes/webpages/versionListing.js
 *   VersionPage     routes/webpages/versions.js           GET /:id/versions
 *   DraftDocument   routes/webpages/draftDocument.js      GET /:id/draft-document
 */

/** The three slots every page has, in the order the web's editor tabs show them. */
export const SLOTS = ['html', 'css', 'js'] as const;
export type Slot = (typeof SLOTS)[number];

export type WebpageFiles = Record<Slot, string>;

export type SourceType = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text' | 'url' | 'file' | 'gdrive' | 'onedrive';
export type SourceStatus = 'processing' | 'ready' | 'error';

export interface WebpageSource {
    id: string;
    type: SourceType;
    name: string;
    status: SourceStatus;
    error: string | null;
    wordCount: number;
    /** Set for an uploaded file; without it (or a URL) a failed source cannot be retried. */
    storageKey: string | null;
    /** The address of a `url` source. */
    url: string | null;
    createdAt: string | null;
}

/** Who wrote a snapshot. `null` means the server could not say, not "you". */
export interface VersionActor {
    name: string | null;
    isYou: boolean;
}

export type VersionSource = 'manual' | 'ai' | 'published' | 'restore';

export interface WebpageVersion {
    id: string;
    seq: number | null;
    summary: string;
    source: VersionSource;
    contentLength: number;
    createdAt: string | null;
    actor: VersionActor | null;
    /** Net lines added (+) or removed (−) by the edit; null when not measured. */
    lineDelta: number | null;
    /** The snapshot the page's audience reads. */
    isPublished: boolean;
}

export interface VersionPage {
    versions: WebpageVersion[];
    hasMore: boolean;
    /** Which version is published, when one is pinned. */
    published: { versionId: string; seq: number | null } | null;
    /**
     * False on a React + Material UI page: its app lives in extra files, which
     * a snapshot does not cover (versionListing.versionCoverage).
     */
    coversProject: boolean;
}

/**
 * What GET /:id/draft-document built: the page as one document the preview
 * frame runs, or why there is none.
 *
 *   ready        `html` is the page, live bridges and a preview token baked in;
 *   empty        a React page with no entry file yet;
 *   stranded     React source in a page set to plain HTML;
 *   build_error  the React bundle failed, `buildError` says how.
 */
export type DraftStatus = 'ready' | 'empty' | 'stranded' | 'build_error';

export interface DraftDocument {
    status: DraftStatus;
    html: string | null;
    buildError: string | null;
    /** When the baked preview token stops working (ms since epoch); null without a document. */
    expiresAt: number | null;
}
