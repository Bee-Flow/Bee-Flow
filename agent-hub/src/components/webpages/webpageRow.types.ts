/** A webpage as the list and the editor both hold it (what `webpagesApi` returns). */

export interface WebpageSettings {
    framework?: string;
    runtime?: string;
    [key: string]: unknown;
}

export interface WebpageRow {
    id: string;
    userId?: string;
    name?: string;
    isPublished?: boolean;
    sharedGroups?: string[];
    publishedVersionId?: string | null;
    settings?: WebpageSettings;
    bridgeGrants?: { automations?: unknown[]; integrations?: unknown[] } | null;
    [key: string]: unknown;
}
