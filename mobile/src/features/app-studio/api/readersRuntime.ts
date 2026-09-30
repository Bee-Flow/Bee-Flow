/**
 * Contract readers for publishing (publish, groups, public pages) and for the
 * run view (runtime payload, action runs, server steps).
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import { readIssues } from './readersApps';
import type { AppDefinition } from '../core/types';
import type { OpenRecord, ValidationIssue } from '../model/apiTypes';
import type {
    ActionRunResult,
    AppRuntime,
    CreatedPublicPage,
    PublicPage,
    PublicPagesState,
    PublishGroup,
    PublishResult,
    RuntimeViewer,
    StepResult,
} from '../model/runtimeTypes';

/** `PATCH /:id/publish` 200. */
export function readPublished(raw: unknown): PublishResult {
    return {
        outcome: 'published',
        isPublished: field.bool(false)(pick(raw, 'isPublished')),
        sharedGroups: field.strArray(pick(raw, 'sharedGroups')),
        publishedVersion: field.numOrNull(pick(raw, 'publishedVersion')),
    };
}

/** A 422 body from publish or the definition save: `{ error, errors, warnings }`. */
export function readInvalid(raw: unknown): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
    return { errors: readIssues(pick(raw, 'errors')), warnings: readIssues(pick(raw, 'warnings')) };
}

/** `GET /auth/groups` is a bare array. Rows without an id are unpickable. */
export function readPublishGroups(raw: unknown): PublishGroup[] {
    return shapeListOf({
        id: field.str(''),
        name: field.str(''),
        description: field.strOrNull,
        organizationId: field.strOrNull,
    })(raw).filter((g) => g.id !== '');
}

const readPublicPage: (raw: unknown) => PublicPage = shapeOf({
    token: field.str(''),
    url: field.str(''),
    createdAt: field.strOrNull,
    lastSeenAt: field.strOrNull,
    visits: field.num(0),
});

const readBlockers = shapeListOf({ code: field.str(''), message: field.str('') });

export function readPublicPages(raw: unknown): PublicPagesState {
    return {
        pages: field.list(readPublicPage)(pick(raw, 'pages')).filter((p) => p.token !== ''),
        publicAccess: field.recordOrNull<OpenRecord>(pick(raw, 'publicAccess')),
        blockers: readBlockers(pick(raw, 'blockers')),
    };
}

export function readCreatedPublicPage(raw: unknown): CreatedPublicPage {
    return {
        page: nullable(readPublicPage)(pick(raw, 'page')),
        blockers: readBlockers(pick(raw, 'blockers')),
    };
}

// ── Runtime ──────────────────────────────────────────────────────────

const readViewer: (raw: unknown) => RuntimeViewer = shapeOf({
    id: field.str(''),
    name: field.strOrNull,
    email: field.strOrNull,
    isOwner: field.bool(false),
    roleKey: field.strOrNull,
});

export const readRuntime: (raw: unknown) => AppRuntime = shapeOf({
    id: field.str(''),
    name: field.str(''),
    icon: field.strOrNull,
    accentColor: field.strOrNull,
    definition: field.record<AppDefinition>({ screens: [], actions: {} }),
    viewer: readViewer,
    draft: field.bool(false),
    appVersion: field.numOrNull,
});

export const readActionRun: (raw: unknown) => ActionRunResult = shapeOf({
    runId: field.strOrNull,
    status: field.strOrNull,
    output: field.raw,
    _appEffects: field.raw,
    _appEffectsUnknown: field.bool(false),
    error: field.strOrNull,
    message: field.strOrNull,
    approvalId: field.strOrNull,
});

export const readStep: (raw: unknown) => StepResult = shapeOf({
    ok: field.bool(false),
    result: field.raw,
    error: field.strOrNull,
    code: field.strOrNull,
    limit: field.numOrNull,
    used: field.numOrNull,
});
