/**
 * What the App Studio management routes answer, as the phone reads them.
 *
 * Written from the server's own serialisers: `mapAppMetaRow`/`mapAppRow` in
 * server/stores/studioAppStore.js, the handlers in server/routes/studioApps.js,
 * the template registry (server/appStudio/templateRegistry.js) and the
 * validator's issue shape (server/appStudio/validate.js). Every reader in
 * api/readers/ produces exactly these, so a screen never meets `undefined`.
 */

import type { AppDefinition } from '../core/types';

/** An open object the phone carries without looking inside. */
export type OpenRecord = Record<string, unknown>;

/** One row of `GET /api/studio-apps` and `/mine`: meta only, never the tree. */
export interface StudioAppRow {
    id: string;
    userId: string;
    organizationId: string | null;
    projectId: string | null;
    name: string;
    description: string;
    icon: string | null;
    accentColor: string | null;
    category: string | null;
    definitionVersion: number;
    /** The draft version that is live; null = never published (or unknown). */
    publishedVersion: number | null;
    isPublished: boolean;
    /** Empty = the whole organisation (when published). */
    sharedGroups: string[];
    templateId: string | null;
    templateVersion: number | null;
    nextcloudMenu: boolean;
    publishedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

/** The per-app storage figure `/mine` attaches; `dbRatio` is 0..1 of the cap. */
export interface StudioAppUsage {
    dbBytes: number;
    dbRatio: number;
}

/** `/mine`'s "a newer template version can be installed" flag. */
export interface TemplateUpgradeInfo {
    available: boolean;
    fromVersion: number | null;
    toVersion: number | null;
}

export interface MyStudioApp extends StudioAppRow {
    usage: StudioAppUsage | null;
    templateUpgrade: TemplateUpgradeInfo | null;
}

/**
 * `GET /:id`. The owner gets the working draft (`definition`); a reader gets
 * only the frozen published copy, and `definition` is null for them.
 */
export interface StudioAppDetail {
    app: StudioAppRow & {
        definition: AppDefinition | null;
        publishedDefinition: AppDefinition | null;
    };
    readOnly: boolean;
}

/** Best-effort data install of a data-backed template (create, upgrade). */
export interface DataInstallReport {
    ok: boolean;
    error: string | null;
    dataModelVersion: number | null;
}

/** `POST /` — create blank or from a template. */
export interface CreateAppInput {
    name?: string;
    description?: string;
    icon?: string;
    accentColor?: string;
    templateId?: string;
}

export interface CreateAppResult {
    app: StudioAppRow;
    dataInstall: DataInstallReport | null;
}

/** `POST /import` — an app archive file (`beeflow.app`) stood up as a live app. */
export interface ImportAppResult {
    app: StudioAppRow;
    /** The server's install report (counts per kind); carried, not interpreted. */
    report: OpenRecord;
    warnings: string[];
}

/** `PUT /:id` — metadata only. `null` clears a nullable field. */
export interface UpdateAppInput {
    name?: string;
    description?: string | null;
    icon?: string | null;
    accentColor?: string | null;
    category?: string | null;
}

/** `POST /:id/template-upgrade`. */
export interface TemplateUpgradeResult {
    fromVersion: number | null;
    toVersion: number | null;
    version: number;
    dataInstall: DataInstallReport | null;
}

// ── Templates and the catalog ────────────────────────────────────────

export interface StudioTemplateMeta {
    id: string;
    version: number;
    title: string;
    description: string;
    category: string;
    icon: string | null;
    tags: string[];
    /** `builtin` ships with the server; `captured` was saved from an org's own app. */
    source: 'builtin' | 'captured';
}

export interface StudioTemplate extends StudioTemplateMeta {
    definition: AppDefinition;
    dataModel: OpenRecord | null;
}

/**
 * `GET /catalog` (server/appStudio/componentSpecs.js buildCatalog). Static per
 * server build. The sub-specs stay open records: the catalog is what the
 * editor reads to learn the vocabulary, so the phone must not pretend to know
 * it in advance.
 */
export interface StudioCatalog {
    schemaVersion: number;
    acceptedSchemaVersions: number[];
    limits: Record<string, number>;
    theme: OpenRecord;
    styleKnobs: OpenRecord;
    colorRoles: unknown[];
    screen: OpenRecord;
    section: OpenRecord;
    /** Keyed by component type. */
    components: Record<string, OpenRecord>;
    events: string[];
    actions: OpenRecord;
    bindings: OpenRecord;
    variables: OpenRecord;
    mailboxTables: unknown[];
}

// ── Validation, check, versions ──────────────────────────────────────

/** One finding of the definition validator. */
export interface ValidationIssue {
    code: string;
    severity: 'error' | 'warning';
    /** Dotted path into the definition ('' for the whole thing). */
    path: string;
    message: string;
    hint: string | null;
}

/** A change canonicalize made to a saved definition. */
export interface CanonicalRepair {
    code: string;
    path: string;
    message: string;
}

/**
 * `PUT /:id/definition`, as the autosave reads it. The two expected refusals
 * are ANSWERS, not errors: 409 hands back the server's copy to reconcile with,
 * 422 the issue list. Anything else still throws.
 */
export type SaveDefinitionResult =
    | { outcome: 'saved'; version: number; warnings: ValidationIssue[]; repairs: CanonicalRepair[] }
    | { outcome: 'conflict'; currentVersion: number | null; definition: AppDefinition | null }
    | { outcome: 'invalid'; errors: ValidationIssue[]; warnings: ValidationIssue[] };

/** `POST /:id/check` (appDryRun + the publish gate's static pass). */
export interface CheckResult {
    ok: boolean;
    static: { errors: ValidationIssue[]; warnings: ValidationIssue[] };
    bindings: OpenRecord[];
    roleFindings: OpenRecord[];
    actions: OpenRecord[];
    /** Table ids/keys an owner binding read zero rows from. */
    emptyTables: string[];
    hints: string[];
}

export interface CheckInput {
    screenId?: string;
    asRole?: string;
}

/** A publish snapshot (`GET /:id/versions`). */
export interface AppVersion {
    id: string;
    appId: string;
    summary: string;
    createdAt: string | null;
}
