/**
 * The shapes the Apps gallery reads off the studio-apps API. Only the fields
 * the gallery itself touches are named; the server sends more.
 */

/** An app card as GET /mine or GET /accessible returns it. */
export interface StudioApp {
    id: string;
    name?: string;
    description?: string;
    icon?: string;
    accentColor?: string | null;
    isPublished?: boolean;
    updatedAt?: string;
    /** Per-app storage use (owner cards only); dbRatio is 0–1 of the cap. */
    usage?: { dbRatio?: number };
    /** Computed server-side on GET /mine: a newer registry version for a pristine install. */
    templateUpgrade?: { available?: boolean; fromVersion?: number | string; toVersion?: number | string };
}

/** A card in the New-app modal's template gallery. */
export interface StudioTemplate {
    id: string;
    title: string;
    description?: string;
    category?: string;
    icon?: string;
    /** 'captured' = made from one of the organisation's own apps. */
    source?: string;
    version?: number;
}

/** Passed through onCreated → onOpen so a remix can focus the AI builder. */
export interface OpenOptions {
    remix: boolean;
    templateId: string;
    prompt: string;
}

/** What a picked template file or app archive says about itself (importExport.filePreview). */
export interface FilePreview {
    kind: 'app' | 'template';
    title: string;
    description: string;
    orgName: string | null;
    tables: number;
    screens: number;
    rows: number;
    files: number;
    bytes: number;
}
