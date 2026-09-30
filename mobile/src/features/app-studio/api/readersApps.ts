/**
 * Contract readers for the App Studio management payloads: app rows, the
 * owner's gallery, templates, the catalog, validation issues, the pre-flight
 * check and the version history. Every one is an allow-list over an untrusted
 * body (core/api/contract): a renamed field becomes a stated default here and
 * a red pin in serverContract.test.ts, never `undefined` in a prop.
 */

import { field, nullable, pick, shapeListOf, shapeOf, type FieldReader } from '@/core/api/contract';

import type { AppDefinition } from '../core/types';
import type {
    AppVersion,
    CanonicalRepair,
    CheckResult,
    DataInstallReport,
    MyStudioApp,
    OpenRecord,
    StudioAppDetail,
    StudioAppRow,
    StudioCatalog,
    StudioTemplate,
    StudioTemplateMeta,
    TemplateUpgradeInfo,
    ValidationIssue,
} from '../model/apiTypes';

/** A definition tree: only "is it an object" is checked; the editor tolerates gaps. */
export const readDefinition: FieldReader<AppDefinition | null> = (value) =>
    field.recordOrNull<AppDefinition>(value);

/** A list of objects, anything else dropped. */
export const readRecordList: FieldReader<OpenRecord[]> = (value) =>
    Array.isArray(value) ? value.filter((v): v is OpenRecord => field.recordOrNull(v) !== null) : [];

/** A map of numbers (the catalog's LIMITS); non-numbers dropped. */
function readNumberMap(value: unknown): Record<string, number> {
    const source = field.recordOrNull(value) ?? {};
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(source)) {
        if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    }
    return out;
}

const appRowSpec = {
    id: field.str(''),
    userId: field.str(''),
    organizationId: field.strOrNull,
    projectId: field.strOrNull,
    name: field.str(''),
    description: field.str(''),
    icon: field.strOrNull,
    accentColor: field.strOrNull,
    category: field.strOrNull,
    definitionVersion: field.num(1),
    publishedVersion: field.numOrNull,
    isPublished: field.bool(false),
    sharedGroups: field.strArray,
    templateId: field.strOrNull,
    templateVersion: field.numOrNull,
    nextcloudMenu: field.bool(false),
    publishedAt: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
};

export const readAppRow: (raw: unknown) => StudioAppRow = shapeOf(appRowSpec);

/** A list of app rows; a row without an id cannot be opened, so it is dropped. */
export function readAppRows(raw: unknown): StudioAppRow[] {
    return shapeListOf(appRowSpec)(pick(raw, 'apps')).filter((row) => row.id !== '');
}

const readUsage = nullable(shapeOf({ dbBytes: field.num(0), dbRatio: field.num(0) }));

const readUpgrade: (raw: unknown) => TemplateUpgradeInfo | null = nullable(
    shapeOf({ available: field.bool(false), fromVersion: field.numOrNull, toVersion: field.numOrNull }),
);

const readMineExtras = shapeOf({ usage: readUsage, templateUpgrade: readUpgrade });

/** `GET /mine`: the owner's rows with storage use and template-upgrade flags. */
export function readMyApps(raw: unknown): MyStudioApp[] {
    const rows = pick(raw, 'apps');
    if (!Array.isArray(rows)) return [];
    return rows
        .filter((row) => field.recordOrNull(row) !== null)
        .map((row) => ({ ...readAppRow(row), ...readMineExtras(row) }))
        .filter((row) => row.id !== '');
}

const readDetailTrees = shapeOf({ definition: readDefinition, publishedDefinition: readDefinition });

/** `GET /:id`. Null when the body has no app at all. */
export function readAppDetail(raw: unknown): StudioAppDetail | null {
    const app = field.recordOrNull(pick(raw, 'app'));
    if (!app) return null;
    return {
        app: { ...readAppRow(app), ...readDetailTrees(app) },
        readOnly: field.bool(true)(pick(raw, 'readOnly')),
    };
}

export const readDataInstall: (raw: unknown) => DataInstallReport | null = nullable(
    shapeOf({ ok: field.bool(false), error: field.strOrNull, dataModelVersion: field.numOrNull }),
);

// ── Templates and the catalog ────────────────────────────────────────

const templateMetaSpec = {
    id: field.str(''),
    version: field.num(1),
    title: field.str(''),
    description: field.str(''),
    category: field.str(''),
    icon: field.strOrNull,
    tags: field.strArray,
    source: field.oneOf(['builtin', 'captured'] as const, 'builtin'),
};

export function readTemplates(raw: unknown): StudioTemplateMeta[] {
    return shapeListOf(templateMetaSpec)(pick(raw, 'templates')).filter((t) => t.id !== '');
}

const readTemplateBody = shapeOf({
    ...templateMetaSpec,
    definition: field.record<AppDefinition>({ screens: [], actions: {} }),
    dataModel: field.recordOrNull<OpenRecord>,
});

export function readTemplate(raw: unknown): StudioTemplate | null {
    return nullable(readTemplateBody)(pick(raw, 'template'));
}

export const readCatalog: (raw: unknown) => StudioCatalog = shapeOf({
    schemaVersion: field.num(2),
    acceptedSchemaVersions: (value: unknown) =>
        Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [],
    limits: readNumberMap,
    theme: field.record<OpenRecord>({}),
    styleKnobs: field.record<OpenRecord>({}),
    colorRoles: (value: unknown) => field.arrayOrNull(value) ?? [],
    screen: field.record<OpenRecord>({}),
    section: field.record<OpenRecord>({}),
    components: field.record<Record<string, OpenRecord>>({}),
    events: field.strArray,
    actions: field.record<OpenRecord>({}),
    bindings: field.record<OpenRecord>({}),
    variables: field.record<OpenRecord>({}),
    mailboxTables: (value: unknown) => field.arrayOrNull(value) ?? [],
});

// ── Validation, check, versions ──────────────────────────────────────

const issueSpec = {
    code: field.str(''),
    severity: field.oneOf(['error', 'warning'] as const, 'error'),
    path: field.str(''),
    message: field.str(''),
    hint: field.strOrNull,
};

export const readIssue: (raw: unknown) => ValidationIssue = shapeOf(issueSpec);

export const readIssues: FieldReader<ValidationIssue[]> = shapeListOf(issueSpec);

export const readRepairs: FieldReader<CanonicalRepair[]> = shapeListOf({
    code: field.str(''),
    path: field.str(''),
    message: field.str(''),
});

const readStaticPass = shapeOf({ errors: readIssues, warnings: readIssues });

export function readCheck(raw: unknown): CheckResult {
    return {
        ok: field.bool(false)(pick(raw, 'ok')),
        static: readStaticPass(pick(raw, 'static')),
        bindings: readRecordList(pick(raw, 'bindings')),
        roleFindings: readRecordList(pick(raw, 'roleFindings')),
        actions: readRecordList(pick(raw, 'actions')),
        emptyTables: field.strArray(pick(raw, 'emptyTables')),
        hints: field.strArray(pick(raw, '_hints')),
    };
}

export function readVersions(raw: unknown): AppVersion[] {
    return shapeListOf({
        id: field.str(''),
        appId: field.str(''),
        summary: field.str(''),
        createdAt: field.strOrNull,
    })(pick(raw, 'versions')).filter((v) => v.id !== '');
}
