/**
 * Contract readers for who can see a page and what it is wired to — see
 * model/audienceTypes.ts for the server function behind each shape.
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { DataCards, PageCall, PageCalls, WebpageAudience, WebpageGrants } from '../model/audienceTypes';

const readInternal = shapeOf({
    mode: field.oneOf(['personal', 'org', 'groups'] as const, 'personal'),
    isPublished: field.bool(false),
    sharedGroups: field.strArray,
});

const readPublic = shapeOf({
    on: field.bool(false),
    // Absent reads as known: only an explicit false means "could not read".
    known: (value: unknown) => value !== false,
    accessMode: field.oneOf(['unlisted', 'password', 'email'] as const, 'unlisted'),
    hasPassword: field.bool(false),
    allowedEmails: field.strArray,
    expiresAt: field.strOrNull,
    viewCount: field.num(0),
    lastViewedAt: field.strOrNull,
});

const readGateTables = shapeListOf({
    datatableId: field.str(''),
    label: field.strOrNull,
    columns: field.strArray,
    publicColumns: field.strArray,
});

function readAddress(raw: unknown): WebpageAudience['address'] {
    const slug = field.strOrNull(pick(raw, 'slug'));
    if (!slug) return null;
    return {
        slug,
        path: field.str(`/w/${slug}`)(pick(raw, 'path')),
        url: field.strOrNull(pick(raw, 'url')),
    };
}

/** GET /:id/audience, and the same model back from PUT /:id/audience/public. */
export function readAudience(raw: unknown): WebpageAudience {
    const gate = pick(raw, 'columnGate');
    const tables = readGateTables(pick(gate, 'tables')).filter((t) => t.datatableId !== '');
    const known = pick(raw, 'shareCountKnown') !== false;
    return {
        internal: readInternal(pick(raw, 'internal')),
        public: readPublic(pick(raw, 'public')),
        address: readAddress(pick(raw, 'address')),
        columnGate: {
            tables,
            anyBound: tables.length > 0,
            sharingCount: tables.filter((t) => t.publicColumns.length > 0).length,
        },
        shareCount: known ? field.num(0)(pick(raw, 'shareCount')) : null,
    };
}

const readIntegrations = shapeListOf({
    tool: field.str(''),
    label: field.strOrNull,
    integrationLabel: field.strOrNull,
    available: (value: unknown) => (typeof value === 'boolean' ? value : null),
});

const readAutomations = shapeListOf({
    automationId: field.str(''),
    label: field.strOrNull,
});

/** GET /:id/grants (integrations/webpageGrants.js describeGrants). */
export function readGrants(raw: unknown): WebpageGrants {
    return {
        integrations: readIntegrations(pick(raw, 'integrations')).filter((g) => g.tool !== ''),
        automations: readAutomations(pick(raw, 'automations')).filter((g) => g.automationId !== ''),
        discoveryFailed: pick(raw, 'discoveryFailed') === true,
    };
}

const readCardTables = shapeListOf({
    datatableId: field.str(''),
    name: field.strOrNull,
    missing: field.bool(false),
    mode: field.oneOf(['read', 'readwrite'] as const, 'read'),
    rowCount: field.numOrNull,
    usedInCode: (value: unknown) => (typeof value === 'boolean' ? value : null),
    publicColumns: field.strArray,
});

const readCardAutomations = shapeListOf({
    automationId: field.str(''),
    title: field.strOrNull,
    tableName: field.strOrNull,
    writes: field.bool(false),
});

/** GET /:id/data-cards. */
export function readDataCards(raw: unknown): DataCards {
    return {
        tables: readCardTables(pick(raw, 'tables')).filter((t) => t.datatableId !== ''),
        automations: readCardAutomations(pick(raw, 'automations')).filter((a) => a.automationId !== ''),
    };
}

const readCall: (raw: unknown) => PageCall = shapeOf({
    kind: field.oneOf(['fetch', 'xhr'] as const, 'fetch'),
    method: field.strOrNull,
    url: field.str(''),
    host: field.str(''),
    source: field.str(''),
    line: field.numOrNull,
    occurrences: field.num(1),
});

/** GET /:id/bindings — only its `code` section: the calls the page makes itself. */
export function readPageCalls(raw: unknown): PageCalls {
    const code = pick(raw, 'code');
    const calls = pick(code, 'calls');
    return {
        scanned: pick(code, 'scanned') === true,
        calls: Array.isArray(calls) ? calls.map(readCall).filter((c) => c.url !== '') : [],
    };
}
