/**
 * Who can see a page and what it is wired to. Written from the server:
 *
 *   WebpageAudience  core/webpages/webpagePublicAudience.js → buildAudienceModel
 *                    (GET /:id/audience, PUT /:id/audience/public)
 *   WebpageGrants    integrations/webpageGrants.js → describeGrants (GET /:id/grants)
 *   DataCards        core/webpages/webpageDataCards.js → buildDataCards
 *   PageCalls        core/webpages/webpageBindings.js → describePageActions `code`
 *
 * Every one of these is owner-only on the server (404 for anybody else).
 */

export type AudienceMode = 'personal' | 'org' | 'groups';
export type PublicAccessMode = 'unlisted' | 'password' | 'email';

/** A table the page reads, and which of its columns may leave the building. */
export interface ColumnGateTable {
    datatableId: string;
    /** The table's name; null when the owner can no longer read it. */
    label: string | null;
    columns: string[];
    publicColumns: string[];
}

export interface WebpageAudience {
    internal: { mode: AudienceMode; isPublished: boolean; sharedGroups: string[] };
    public: {
        on: boolean;
        /** False when the current public link could not be read — not "off". */
        known: boolean;
        accessMode: PublicAccessMode;
        hasPassword: boolean;
        allowedEmails: string[];
        expiresAt: string | null;
        viewCount: number;
        lastViewedAt: string | null;
    };
    /** `/w/<slug>`; `url` is null when the server has no public base address. */
    address: { slug: string; path: string; url: string | null } | null;
    columnGate: { tables: ColumnGateTable[]; anyBound: boolean; sharingCount: number };
    /** Live links of every kind; null when they could not be counted. */
    shareCount: number | null;
}

/** What PUT /:id/audience/public takes. */
export interface PublicChoice {
    on: boolean;
    publicColumns: Record<string, string[]>;
    accessMode: PublicAccessMode;
    password?: string;
    allowedEmails?: string[];
    expiresAt?: string | null;
}

export interface IntegrationGrant {
    tool: string;
    label: string | null;
    integrationLabel: string | null;
    /** True connected, false needs reconnecting, null unknown. */
    available: boolean | null;
}

export interface AutomationGrant {
    automationId: string;
    label: string | null;
}

export interface WebpageGrants {
    integrations: IntegrationGrant[];
    automations: AutomationGrant[];
    /** The connection check failed, so every `available` is null. */
    discoveryFailed: boolean;
}

export interface DataCardTable {
    datatableId: string;
    name: string | null;
    missing: boolean;
    mode: 'read' | 'readwrite';
    rowCount: number | null;
    /** Null when the page's code could not be read. */
    usedInCode: boolean | null;
    publicColumns: string[];
}

export interface DataCardAutomation {
    automationId: string;
    title: string | null;
    tableName: string | null;
    writes: boolean;
}

export interface DataCards {
    tables: DataCardTable[];
    automations: DataCardAutomation[];
}

/** One `fetch()` or XMLHttpRequest the page makes from its own code. */
export interface PageCall {
    kind: 'fetch' | 'xhr';
    method: string | null;
    url: string;
    host: string;
    source: string;
    line: number | null;
    occurrences: number;
}

export interface PageCalls {
    /** False when the code could not be read — which is not "no calls". */
    scanned: boolean;
    calls: PageCall[];
}
