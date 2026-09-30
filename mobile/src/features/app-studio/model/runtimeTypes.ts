/**
 * What the App Studio publish, runtime and data routes answer.
 *
 * Sources: server/routes/studioApps.js (publish, public pages, runtime),
 * server/routes/studioAppsRun.js (action run/step/poll), server/routes/
 * studioAppData.js + server/appStudio/dataReadRunner.js (tables, records,
 * queries, batch, schema, datasets, members) and server/routes/auth for the
 * groups a publish may target.
 */

import type { OpenRecord, ValidationIssue } from './apiTypes';
import type { AppDefinition } from '../core/types';

// ── Publish ──────────────────────────────────────────────────────────

export interface PublishInput {
    isPublished: boolean;
    /** Omit to keep the stored audience; `[]` = the whole organisation. */
    sharedGroups?: string[];
}

/**
 * `PATCH /:id/publish`. A 422 (the draft does not validate) is an answer the
 * publish sheet renders, so it comes back as `outcome: 'invalid'`.
 */
export type PublishResult =
    | { outcome: 'published'; isPublished: boolean; sharedGroups: string[]; publishedVersion: number | null }
    | { outcome: 'invalid'; errors: ValidationIssue[]; warnings: ValidationIssue[] };

/** A group the audience picker may offer (`GET /auth/groups`). */
export interface PublishGroup {
    id: string;
    name: string;
    description: string | null;
    organizationId: string | null;
}

/** Why a public page can be minted but is not live yet. */
export interface PublicPageBlocker {
    code: string;
    message: string;
}

export interface PublicPage {
    token: string;
    url: string;
    createdAt: string | null;
    lastSeenAt: string | null;
    visits: number;
}

/** `GET /:id/public-pages`. */
export interface PublicPagesState {
    pages: PublicPage[];
    publicAccess: OpenRecord | null;
    blockers: PublicPageBlocker[];
}

/** `POST /:id/public-pages`. */
export interface CreatedPublicPage {
    page: PublicPage | null;
    blockers: PublicPageBlocker[];
}

// ── Runtime ──────────────────────────────────────────────────────────

/** The caller's own identity inside the run view (formula `currentUser`). */
export interface RuntimeViewer {
    id: string;
    name: string | null;
    email: string | null;
    isOwner: boolean;
    /** The resolved app role; 'owner' for the owner, null when none applies. */
    roleKey: string | null;
}

/** `GET /:id/runtime[?draft=1]`. */
export interface AppRuntime {
    id: string;
    name: string;
    icon: string | null;
    accentColor: string | null;
    definition: AppDefinition;
    viewer: RuntimeViewer;
    /** True only for the owner's draft preview. */
    draft: boolean;
    /** The generation this session runs; compare with data answers. */
    appVersion: number | null;
}

/** Form values and variables, as the runtime sends them. */
export type ValueBag = Record<string, unknown>;

/**
 * `POST …/actions/:aid/run` and `GET …/actions/runs/:runId`: one contract.
 * A 202 is `{ runId, status: 'pending' }`; an already-running routine answers
 * `{ status: 'skipped', message }`.
 */
export interface ActionRunResult {
    runId: string | null;
    status: string | null;
    output: unknown;
    /** `return_to_app` instructions — a sibling of `output`, never inside it. */
    _appEffects: unknown;
    /** The step read failed, so whether effects exist is unknown. */
    _appEffectsUnknown: boolean;
    error: string | null;
    message: string | null;
    approvalId: string | null;
}

export interface RunActionInput {
    formValues?: ValueBag;
    /** false = answer 202 at once instead of waiting up to 60 s. */
    wait?: boolean;
    draft?: boolean;
}

/** `POST …/actions/:aid/step` — one server step of a sequence action. */
export interface StepInput {
    stepIndex: number;
    formValues?: ValueBag;
    vars?: ValueBag;
    item?: unknown;
    index?: number;
    value?: unknown;
    draft?: boolean;
}

export interface StepResult {
    ok: boolean;
    result: unknown;
    error: string | null;
    /** e.g. `quota_exceeded`, with `limit`/`used`. */
    code: string | null;
    limit: number | null;
    used: number | null;
}

// ── Data ─────────────────────────────────────────────────────────────

export interface DataField {
    id: string;
    key: string;
    name: string;
    type: string;
    subtype: string | null;
    required: boolean;
    unique: boolean;
    options: unknown[] | null;
    relation: { table: string } | null;
}

/** `GET /:id/data/tables` — tables the viewer may read. */
export interface DataTable {
    id: string;
    key: string;
    name: string;
    icon: string | null;
    fields: DataField[];
    linked: boolean;
    readOnly: boolean;
}

export type DataRecord = Record<string, unknown>;

export interface RecordsQuery {
    filter?: unknown;
    sort?: unknown;
    cursor?: string;
    limit?: number;
    sample?: boolean;
}

export interface RecordPage {
    records: DataRecord[];
    nextCursor: string | null;
    appVersion: number | null;
}

/** A record write: the record as re-read under the viewer's access. */
export interface RecordWrite {
    id: string | null;
    record: DataRecord | null;
}

/**
 * A PATCH with `expectedUpdatedAt`: 409 `record_conflict` hands back the row
 * as it now stands (someone else wrote first), which the form shows or merges.
 */
export type RecordUpdateResult =
    | { outcome: 'saved'; record: DataRecord | null }
    | { outcome: 'conflict'; record: DataRecord | null };

/** One read of a `POST /:id/data/batch`. */
export interface BatchRead {
    id: string;
    kind: 'records' | 'aggregate' | 'dataset';
    [key: string]: unknown;
}

export interface BatchReadResult {
    id: string | null;
    ok: boolean;
    status: number | null;
    error: string | null;
    data: unknown;
}

/**
 * `supported: false` = the route is not there (older server, a proxy, a
 * fail-closed transport): replay the reads one by one. Never "no data".
 */
export type BatchResult =
    | { supported: true; results: BatchReadResult[]; appVersion: number | null }
    | { supported: false };

/** `POST /:id/data/query` — a saved dataset or an inline aggregate. */
export interface QueryResult {
    rows: DataRecord[];
    columns: unknown[] | null;
    truncated: boolean;
    cached: boolean;
    /** The runtime binding contract: same rows as `rows` for a dataset. */
    result: unknown;
}

/** `GET /:id/schema`. `model` is null until the app has a data model. */
export interface AppSchema {
    model: OpenRecord | null;
    modelVersion: number;
}

export type SaveSchemaResult =
    | { outcome: 'saved'; version: number }
    | { outcome: 'conflict'; currentVersion: number | null; model: OpenRecord | null }
    | { outcome: 'invalid'; errors: string[] };

export interface AppDataset {
    id: string;
    name: string;
    tableId: string | null;
    source: OpenRecord;
    descriptor: OpenRecord;
    cacheTtlSeconds: number;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface AppMember {
    userId: string;
    roleKey: string;
    createdAt: string | null;
}
