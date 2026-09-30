/** What the Settings hub's own screens read: the workspace's locales and the changelog. */

/** `GET /api/languages/user/locales`. */
export interface Locale {
    code: string;
    name: string;
    isOrgDefault?: boolean;
    enabled?: boolean;
}

/** `GET /api/release-notes/public` — published entries only. */
export interface ReleaseNote {
    id: string;
    version: string | null;
    title: string;
    lead: string;
    items: string[];
    publishedAt: string;
}
