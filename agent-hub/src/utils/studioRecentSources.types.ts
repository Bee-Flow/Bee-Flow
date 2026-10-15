import type { RecentStatusCode } from './studioRecentSources';

/** The fields of a raw list row that any section's accessors read. */
export interface RawRow {
    id: string;
    name?: string;
    title?: string;
    fileName?: string;
    description?: string;
    tagline?: string;
    recipeLabel?: string;
    recipeId?: string;
    summarySnippet?: string;
    updated_at?: string;
    updatedAt?: string;
    isPublished?: boolean | string | null;
    is_published?: boolean | string | null;
    publishedVersion?: number | string | null;
    published_version?: number | string | null;
    definitionVersion?: number | string | null;
    isDraft?: boolean;
    isActive?: boolean | null;
    lastStatus?: string;
    status?: string;
    phases?: { status?: string }[];
}

/** The envelopes the list endpoints wrap their rows in (some answer a bare array instead). */
export interface RecentEnvelope {
    automations?: unknown[];
    webpages?: unknown[];
    apps?: unknown[];
    datatables?: unknown[];
    transcriptions?: unknown[];
    playbooks?: unknown[];
    projects?: unknown[];
}

/** A row once a section's `map` has normalised it. */
export interface RecentItem {
    id: string;
    name?: string;
    description?: string | null;
    updatedAt?: string;
}

/** What an endpoint answers: an envelope, a bare array, or nothing. */
export type RecentPayload = RecentEnvelope | unknown[] | null;

/** One section's declarative source. */
export interface RecentSource {
    url: string;
    pick(d?: RecentPayload): unknown;
    map: (row: RawRow) => RecentItem;
    status?: (row: RawRow) => RecentStatusCode;
}
