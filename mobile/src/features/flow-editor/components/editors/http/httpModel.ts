/**
 * The HTTP request step, the pure half of the web's HttpRequestFields,
 * HttpAuthPicker and CacheIntoRow (actionEditors/httpRequestFields.jsx,
 * HttpAuthPicker.jsx, actionEditors/cacheIntoRow.jsx): the methods, the
 * header edits, the credential kinds, and when the two "don't call twice"
 * ticks may be used. Pinned by http.lockstep.test.ts.
 */

import type { CatalogDatatable } from '@/features/flow-editor/api';
import type { FormDraft } from '@/features/flow-editor/formState';

import { msg, type Msg } from '../declarative/spec';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
export const HTTP_WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const methodOf = (draft: FormDraft): string => String(draft.method || 'GET').toUpperCase();

/**
 * The two ticks' states. The SSRF toggle is a REFUSAL — with private targets
 * allowed a cache hit would launder an answer past a control a reviewer later
 * switches back on. A write method is only a caution: the author alone knows
 * whether their POST searches or creates.
 */
export function reuseAvailability(draft: FormDraft): { askOnce: { disabled: boolean; reason: Msg | null }; cacheInto: { disabled: boolean; reason: Msg | null } } {
    const method = methodOf(draft);
    const caution = HTTP_WRITE_METHODS.has(method)
        ? msg('mobile.flow.http.write_caution', 'A {method} is not promised to be a look-up — if this call creates or changes something, reusing the answer skips it.', { method })
        : null;
    if (draft.blockPrivateTargets === false) {
        return {
            askOnce: { disabled: true, reason: msg('mobile.flow.http.ask_once_private', 'Not while private targets are allowed.') },
            cacheInto: { disabled: true, reason: msg('mobile.flow.http.cache_private', 'Nothing is kept while private targets are allowed.') },
        };
    }
    return { askOnce: { disabled: false, reason: caution }, cacheInto: { disabled: false, reason: caution } };
}

// ── Headers ────────────────────────────────────────────────────────────

type Headers = Record<string, unknown>;

/** Renamed in place (the order is kept); an empty or unchanged name is no change. */
export function renameHeader(headers: Headers, oldKey: string, newKey: string): Headers | null {
    if (!newKey || newKey === oldKey) return null;
    const next: Headers = {};
    for (const [k, v] of Object.entries(headers)) next[k === oldKey ? newKey : k] = v;
    return next;
}

export function removeHeader(headers: Headers, key: string): Headers {
    const next = { ...headers };
    delete next[key];
    return next;
}

/** A new header named `Header`, or `Header-1`, `Header-2`, … past the ones in use. */
export function addHeader(headers: Headers): Headers {
    let name = 'Header';
    let i = 1;
    while (Object.prototype.hasOwnProperty.call(headers, name)) name = `Header-${i++}`;
    return { ...headers, [name]: '' };
}

// ── Credentials ────────────────────────────────────────────────────────

/** The credential kinds' names — the connections page's own words. */
export const HTTP_KIND_NAMES: Readonly<Record<string, Msg>> = {
    bearer: msg('connections.http_bearer', 'Bearer token'),
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- the api_key credential kind mapped to an i18n key and its English name, not an API key
    api_key: msg('connections.http_api_key', 'API key (custom header)'),
    basic: msg('connections.http_basic', 'Basic auth'),
    oauth2_cc: msg('connections.http_oauth2_cc', 'OAuth2 (client credentials)'),
};

// ── Remember answers in a table ────────────────────────────────────────

/** Only tables provisioned for this: their columns are fixed and the runner writes them by name. */
export const answerTables = (tables: readonly CatalogDatatable[]): CatalogDatatable[] => tables.filter((t) => t && t.managedKind === 'http_cache' && t.canWrite !== false);

/** Who else can read a table, in the datatables list's words. */
export const TABLE_AUDIENCE: Readonly<Record<string, Msg>> = {
    personal: msg('mobile.flow.http.audience_personal', 'only you'),
    org: msg('mobile.flow.http.audience_org', 'everyone in the organisation'),
    groups: msg('mobile.flow.http.audience_groups', 'the groups it is shared with'),
};

export const AUDIENCE_ANY: Msg = msg('mobile.flow.http.audience_any', 'everyone with access');

export type CacheInto = { datatableId: string; maxAgeDays?: number } | null;

export const cacheIntoOf = (draft: FormDraft): CacheInto => {
    const c = draft.cacheInto as CacheInto | undefined;
    return c && typeof c === 'object' ? c : null;
};

/** How many days an answer is reused: the stored number, or 30. */
export const cacheDays = (current: CacheInto): number => (Number.isFinite(Number(current?.maxAgeDays)) ? Number(current?.maxAgeDays) : 30);

/** Pointing at a table (or none: the tick off); the days ride along. */
export const cacheTable = (current: CacheInto, datatableId: string): CacheInto | undefined => (datatableId ? { datatableId, maxAgeDays: cacheDays(current) } : undefined);

export function cacheForDays(current: CacheInto, value: unknown): CacheInto | null {
    if (!current?.datatableId) return null;
    const n = Math.round(Number(value));
    return { datatableId: current.datatableId, ...(Number.isFinite(n) ? { maxAgeDays: n } : {}) };
}
