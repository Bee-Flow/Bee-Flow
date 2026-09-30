/**
 * Webpage shapes, written from the server's own mappers rather than from the
 * web client, which hand-picks fields per component:
 *
 *   Webpage        server/stores/webpage/shared.js  → mapWebpageRow
 *   WebpageShare   server/stores/webpagePublicShareStore.js → mapRow
 *
 * Fields the phone never reads are left out on purpose — every one of them is
 * a promise about a payload, and an unused promise is one nobody checks.
 */

export interface Webpage {
    id: string;
    /** The owner. `readOnly` on the detail response is derived from this. */
    userId: string;
    name: string;
    description: string;
    tagline: string;
    icon: string;
    accentColor: string;
    /** Visible to the owner's organisation (or to `sharedGroups` within it). */
    isPublished: boolean;
    sharedGroups: string[];
    organizationId: string | null;
    projectId: string | null;
    /** Byte sizes of the three content slots; all zero means nothing built yet. */
    htmlSize: number;
    cssSize: number;
    jsSize: number;
    sourceCount: number;
    createdAt: string | null;
    updatedAt: string | null;
    /** The brief the builder reads on every turn. */
    instructions: string;
    /** The first entry is the page's own knowledge base once it has sources. */
    knowledgeBaseIds: string[];
    /** How the page is built and previewed (resolveFramework / resolveRuntime). */
    framework: WebpageFramework;
    runtime: WebpageRuntime;
    /** `/w/<slug>`, once the page has been made public. It stays when public is switched off. */
    slug: string | null;
    /** The share serving the public address; null when the page is not public (now). */
    publicShareId: string | null;
    /** Live external links; null when the server could not count them. */
    publicShareCount: number | null;
}

export type WebpageFramework = 'vanilla' | 'react-mui';
export type WebpageRuntime = 'light' | 'full';

/** A project file beside the three slots (`src/App.jsx`, an image). */
export interface WebpageExtraFile {
    path: string;
    mimeType: string;
    isText: boolean;
    size: number;
}

/**
 * GET /api/webpages/:id, minus the file bodies (see readWebpageDetail).
 * `readOnly` is true for an org viewer, not the owner.
 */
export interface WebpageDetail {
    webpage: Webpage;
    readOnly: boolean;
    extraFiles: WebpageExtraFile[];
    /** The builder chat as the server stores it: the web's message rows, untouched. */
    chatMessages: Record<string, unknown>[];
}

/**
 * One external share link.
 *
 * `url` is null whenever the raw token is no longer recoverable — revoked,
 * expired, or a legacy row stored before tokens were encrypted at rest
 * (server/routes/webpageShareUrls.js attachShareUrls). That is not an error
 * state to retry: the link genuinely cannot be shown again, and the fix is a
 * new one.
 *
 * `allowedEmails` is stripped for anyone who is not the share's creator, so it
 * is optional here rather than nullable.
 */
export interface WebpageShare {
    id: string;
    webpageId: string;
    createdBy: string;
    accessMode: 'unlisted' | 'password' | 'email';
    hasPassword: boolean;
    allowedEmails?: string[] | null;
    expiresAt: string | null;
    revokedAt: string | null;
    title: string;
    viewCount: number;
    lastViewedAt: string | null;
    createdAt: string | null;
    url: string | null;
}

/** POST /api/webpages/:id/public-shares — the only time `url` is guaranteed. */
export interface CreatedWebpageShare {
    share: WebpageShare;
    url: string;
}
