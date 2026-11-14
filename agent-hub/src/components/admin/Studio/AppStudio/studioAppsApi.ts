/**
 * App Studio — client API for /api/studio-apps (see server/routes/studioApps.js
 * and server/routes/studioAppsRun.js). Thin fetch wrappers over the house
 * authFetch; every function throws an Error with .status and .body on non-2xx
 * EXCEPT saveDefinition, whose 409/422 are expected flows returned as values.
 */

import { createJsonResource } from '@/api/client';
import type { JsonResourceError } from '@/api/client';
import { errorBodyRecord, errorMessage, errorStatus } from '@/utils/caughtError';
import { apiUrl } from '@/api/typedRequest';
import { managedRefusalOf } from '@/utils/managedPart';
import { fromError } from '@/components/shared/managedPart';
import type { AppDefinition } from './inspector/appDefinition';

/** The fields a new app can start with. */
interface NewAppBody {
    name?: string;
    description?: string;
    icon?: string;
    accentColor?: string;
    templateId?: string;
}

// Some callers still hold an id that may be undefined (it then reads "undefined",
// as it always did), so the encoder is typed to take one.
const enc = encodeURIComponent as (part: string | number | boolean | null | undefined) => string;

// One request helper for every call: JSON in and out, and on a non-2xx an
// Error carrying the server's error text, status, code and body. A stage that
// manages the resource refused the write (409 managed_part) or the step
// (managed_part_not_deployed): `err.managed` is what the banner needs.
const request = createJsonResource('', {
    decorate: (err: JsonResourceError, body: Record<string, unknown> | null) => {
        const managed = fromError(body);
        if (managed) err.managed = managed;
    },
});

/**
 * The stage's refusal as a SAVE result. A 409 here is otherwise "someone else
 * saved a newer version" (a conflict dialog that offers to overwrite), which is
 * exactly the wrong answer to a part nobody may write: it is its own outcome,
 * with the banner info and the server's sentence, and the autosave treats it as
 * a failed save (never a retry, never an overwrite offer).
 */
function managedResult(err: unknown) {
    const managed = managedRefusalOf(err);
    return managed ? { ok: false, managed, error: errorMessage(err) } : null;
}

export const studioAppsApi = {
    // Catalog / templates
    getCatalog: () => request(apiUrl('GET /api/studio-apps/catalog')),
    listTemplates: () => request(apiUrl('GET /api/studio-apps/templates')),
    getTemplate: (templateId: string) => request(apiUrl('GET /api/studio-apps/templates/{templateId}', { params: { templateId } })),
    /**
     * Remove a template this organisation CAPTURED from one of its own apps
     * (source:'captured', id `utpl_…`). Built-in templates are code and 404
     * here — a gallery you can only ever add to is a gallery that fills up.
     */
    deleteTemplate: (templateId: string) => request(apiUrl('DELETE /api/studio-apps/templates/{templateId}', { params: { templateId } }), { method: 'DELETE' }),

    /**
     * One template written down as a portable file → { envelope, warnings,
     * filename }. The JSON body rather than the `?download=1` variant, because
     * the caller saves it with the browser's own download dance (a Blob and an
     * object URL) and wants the warnings alongside — a download tells you
     * nothing about the three automation references it just cleared.
     */
    exportTemplate: (templateId: string) => request(apiUrl('GET /api/studio-apps/templates/{templateId}/export', { params: { templateId } })),

    /**
     * A template file → this organisation's gallery, as a captured template.
     * → { template, report, warnings }. A file the server will not take comes
     * back 400 with .body.details naming each reason.
     */
    importTemplate: (envelope: unknown, { title }: { title?: string } = {}) =>
        request(apiUrl('POST /api/studio-apps/templates/import'), {
            method: 'POST',
            body: JSON.stringify({ envelope, ...(title ? { title } : {}) }),
        }),

    /**
     * An APP ARCHIVE file (`beeflow.app`) → a live app in this organisation,
     * with its rows and its documents already in it.
     * → { app, report, warnings }.
     *
     * The sibling of importTemplate and deliberately not the same call: that
     * one puts a blueprint in the gallery, this one stands up one particular
     * app. `report.installed` says how many rows and files actually landed, and
     * `warnings` names each one that did not — an archive installs
     * best-effort, so a silent success would hide a refused drawing.
     *
     * There is no `exportApp`. The product can open an archive and can never
     * write one; they are built by a script on the server. See
     * server/appStudio/appPortability.js.
     */
    importApp: (envelope: unknown, { name }: { name?: string } = {}) =>
        request(apiUrl('POST /api/studio-apps/import'), {
            method: 'POST',
            body: JSON.stringify({ envelope, ...(name ? { name } : {}) }),
        }),

    // Apps
    listAccessible: () => request(apiUrl('GET /api/studio-apps')),
    listMine: () => request(apiUrl('GET /api/studio-apps/mine')),
    /** body: { name?, description?, icon?, accentColor?, templateId? } */
    createApp: (body: NewAppBody = {}) => request(apiUrl('POST /api/studio-apps'), { method: 'POST', body: JSON.stringify(body) }),
    /**
     * The row, with the `managed` the route sends BESIDE it ({ app, readOnly,
     * managed }) carried onto it, so every holder of the row (the shell, the
     * header, the publish modal) can tell a Solution stage's app from its own.
     */
    getApp: async (id: string) => {
        const res = await request(apiUrl('GET /api/studio-apps/{id}', { params: { id } }));
        if (res && res.app && res.managed !== undefined) res.app = { ...res.app, managed: res.managed };
        return res;
    },
    updateApp: (id: string, meta: Record<string, unknown>) => request(apiUrl('PUT /api/studio-apps/{id}', { params: { id } }), { method: 'PUT', body: JSON.stringify(meta) }),
    deleteApp: (id: string) => request(apiUrl('DELETE /api/studio-apps/{id}', { params: { id } }), { method: 'DELETE' }),

    /**
     * Autosave the working draft. Returns (never throws for these flows):
     *   { ok:true, version, warnings, repairs }
     *   { ok:false, managed, error }                              // 409 managed_part
     *   { ok:false, conflict:true, currentVersion, definition }   // 409
     *   { ok:false, invalid:true, errors, warnings }              // 422
     * Other statuses throw (incl. 413 definition_too_large).
     */
    saveDefinition: async (id: string | undefined, definition: AppDefinition | null, baseVersion: number | string | null | undefined) => {
        try {
            const body = await request(apiUrl('PUT /api/studio-apps/{id}/definition', { params: { id: String(id) } }), {
                method: 'PUT',
                body: JSON.stringify({ definition, baseVersion }),
            });
            return { ok: true, ...body };
        } catch (err) {
            const refused = managedResult(err);
            if (refused) return refused;
            if (errorStatus(err) === 409) return { ok: false, conflict: true, ...(errorBodyRecord(err) ?? {}) };
            if (errorStatus(err) === 422) return { ok: false, invalid: true, ...(errorBodyRecord(err) ?? {}) };
            throw err;
        }
    },

    /** body: { isPublished, sharedGroups? } */
    publish: (id: string, body: { isPublished: boolean; sharedGroups?: string[] }) => request(apiUrl('PATCH /api/studio-apps/{id}/publish', { params: { id } }), { method: 'PATCH', body: JSON.stringify(body) }),

    /**
     * Upgrade a pristine created-from-template app to the registry template's
     * newer version. → { ok, fromVersion, toVersion, version, dataInstall? }.
     * 409s (not_pristine / no_newer_version / not_from_template) throw with
     * .status/.code like every other wrapper here.
     */
    templateUpgrade: (id: string) => request(apiUrl('POST /api/studio-apps/{id}/template-upgrade', { params: { id } }), { method: 'POST' }),

    /**
     * Toggle the app's entry in the organisation's Nextcloud app menu.
     * → { success, nextcloudMenu, ncConnected, ncSync } — ncConnected=false
     * means the flag is stored but no Nextcloud is paired with the org;
     * ncSync='synced' means the connector registered/removed the icon before
     * answering (a reload of Nextcloud shows it), anything else means the
     * connector's periodic check will pick it up.
     */
    setNextcloudMenu: (id: string, enabled: boolean) =>
        request(apiUrl('PATCH /api/studio-apps/{id}/nextcloud-menu', { params: { id } }), { method: 'PATCH', body: JSON.stringify({ enabled }) }),

    /**
     * Pre-flight the saved draft, read-only (server: appDryRun). Owner-only.
     * → { ok, static:{errors,warnings}, bindings, roleFindings, actions,
     *     emptyTables, _hints }
     * opts: { screenId?, asRole? } — omit both to check the whole app.
     */
    checkApp: (id: string, opts: { screenId?: string; asRole?: string } = {}) =>
        request(apiUrl('POST /api/studio-apps/{id}/check', { params: { id } }), { method: 'POST', body: JSON.stringify(opts) }),

    /**
     * Public pages (server: routes/studioApps/publicPages.js). Owner-only, all
     * three; minting and revoking also need manage_apps.
     * list → { pages: [{ token, url, createdAt, lastSeenAt, visits }], publicAccess, blockers }
     * create → 201 { page, blockers }; 409 once the app has its maximum of URLs.
     */
    listPublicPages: (id: string) => request(apiUrl('GET /api/studio-apps/{id}/public-pages', { params: { id } })),
    createPublicPage: (id: string) => request(apiUrl('POST /api/studio-apps/{id}/public-pages', { params: { id } }), { method: 'POST' }),
    revokePublicPage: (id: string, token: string) => request(apiUrl('DELETE /api/studio-apps/{id}/public-pages/{token}', { params: { id, token } }), { method: 'DELETE' }),

    // Versions
    listVersions: (id: string) => request(apiUrl('GET /api/studio-apps/{id}/versions', { params: { id } })),
    restoreVersion: (id: string, versionId: string | number | undefined) =>
        request(apiUrl('POST /api/studio-apps/{id}/versions/{versionId}/restore', { params: { id: String(id), versionId: String(versionId) } }), { method: 'POST' }),

    // Run view payload ({ id, name, icon, accentColor, definition, draft? })
    getRuntime: (id: string | null, { draft = false }: { draft?: boolean } = {}) =>
        request(`${apiUrl('GET /api/studio-apps/{id}/runtime', { params: { id: String(id) } })}${draft ? '?draft=1' : ''}`),

    // Actions (the run bridge; useActionRunner drives these in run mode)
    runAction: (appId: string, actionId: string, { formValues = {}, draft = false }: { formValues?: Record<string, unknown>; draft?: boolean } = {}) =>
        request(`${apiUrl('POST /api/studio-apps/{id}/actions/{actionId}/run', { params: { id: appId, actionId } })}${draft ? '?draft=1' : ''}`, {
            method: 'POST',
            body: JSON.stringify({ formValues, wait: true }),
        }),
    getActionRun: (appId: string, runId: string) => request(apiUrl('GET /api/studio-apps/{id}/actions/runs/{runId}', { params: { id: appId, runId } })),

    // AI builder — rehydrates the persisted chat session after a refresh.
    getBuilderSession: (appId: string) => request(apiUrl('GET /api/studio-apps/builder/session/{appId}', { params: { appId } })),

    // Data model (owner-only). getSchema → { model, modelVersion }.
    getSchema: (id: string) => request(apiUrl('GET /api/studio-apps/{id}/schema', { params: { id } })),
    /**
     * Persist the data model. Returns (never throws for these flows):
     *   { ok:true, version }
     *   { ok:false, managed, error }                           // 409 managed_part
     *   { ok:false, conflict:true, currentVersion, model }     // 409
     *   { ok:false, invalid:true, errors }                     // 422
     *   { ok:false, conversionRefused:true, conversions }      // 422 conversion_refused
     *   { ok:false, migrationFailed:true, failure }            // 422 migration_failed
     * A saved field whose type changes is converted in place (safe pairs);
     * `onUnconvertible: 'clear'` empties the values that cannot convert.
     */
    saveSchema: async (id: string, model: Record<string, unknown>, expectedVersion: number | string | null | undefined, opts: { onUnconvertible?: 'refuse' | 'clear' } = {}) => {
        try {
            const body = await request(apiUrl('PUT /api/studio-apps/{id}/schema', { params: { id } }), {
                method: 'PUT',
                body: JSON.stringify({ model, expectedVersion, ...(opts.onUnconvertible ? { onUnconvertible: opts.onUnconvertible } : {}) }),
            });
            return { ok: true, ...body };
        } catch (err) {
            const refused = managedResult(err);
            if (refused) return refused;
            if (errorStatus(err) === 409) return { ok: false, conflict: true, ...(errorBodyRecord(err) ?? {}) };
            if (errorStatus(err) === 422) {
                const rec = errorBodyRecord(err) ?? {};
                if (rec.code === 'conversion_refused') return { ok: false, conversionRefused: true, ...rec };
                if (rec.code === 'migration_failed') return { ok: false, migrationFailed: true, ...rec };
                return { ok: false, invalid: true, ...rec };
            }
            throw err;
        }
    },
    /** Dry run of saveSchema: { dryRun, currentVersion, report } — nothing is saved. */
    previewSchema: (id: string, model: Record<string, unknown>, opts: { onUnconvertible?: 'refuse' | 'clear' } = {}) => request(apiUrl('PUT /api/studio-apps/{id}/schema', { params: { id } }), {
        method: 'PUT',
        body: JSON.stringify({ model, dryRun: true, ...(opts.onUnconvertible ? { onUnconvertible: opts.onUnconvertible } : {}) }),
    }),
};

