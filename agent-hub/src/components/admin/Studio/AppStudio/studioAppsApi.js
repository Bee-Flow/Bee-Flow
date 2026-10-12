/**
 * App Studio — client API for /api/studio-apps (see server/routes/studioApps.js
 * and server/routes/studioAppsRun.js). Thin fetch wrappers over the house
 * authFetch; every function throws an Error with .status and .body on non-2xx
 * EXCEPT saveDefinition, whose 409/422 are expected flows returned as values.
 */

import { API_BASE, authFetch } from '../../../../utils/helpers';
import { fromError } from '../../../shared/managedPart';

const base = `${API_BASE}/api/studio-apps`;
const enc = encodeURIComponent;

async function request(url, options = {}) {
    const res = await authFetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty/non-JSON body */ }
    if (!res.ok) {
        // Prefer the server's structured error/code (e.g. the 409 quota body
        // { error, code:'quota_exceeded', limit, used }) over the generic text.
        const err = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = body?.code || null;
        err.body = body;
        // The stage that manages this app refused the write (409 managed_part)
        // or the step (managed_part_not_deployed): what the banner needs.
        const managed = fromError(body);
        if (managed) err.managed = managed;
        throw err;
    }
    return body;
}

/**
 * The stage's refusal as a SAVE result. A 409 here is otherwise "someone else
 * saved a newer version" (a conflict dialog that offers to overwrite), which is
 * exactly the wrong answer to a part nobody may write: it is its own outcome,
 * with the banner info and the server's sentence, and the autosave treats it as
 * a failed save (never a retry, never an overwrite offer).
 */
function managedResult(err) {
    return err?.managed ? { ok: false, managed: err.managed, error: err.message } : null;
}

export const studioAppsApi = {
    // Catalog / templates
    getCatalog: () => request(`${base}/catalog`),
    listTemplates: () => request(`${base}/templates`),
    getTemplate: (templateId) => request(`${base}/templates/${enc(templateId)}`),
    /**
     * Remove a template this organisation CAPTURED from one of its own apps
     * (source:'captured', id `utpl_…`). Built-in templates are code and 404
     * here — a gallery you can only ever add to is a gallery that fills up.
     */
    deleteTemplate: (templateId) => request(`${base}/templates/${enc(templateId)}`, { method: 'DELETE' }),

    /**
     * One template written down as a portable file → { envelope, warnings,
     * filename }. The JSON body rather than the `?download=1` variant, because
     * the caller saves it with the browser's own download dance (a Blob and an
     * object URL) and wants the warnings alongside — a download tells you
     * nothing about the three automation references it just cleared.
     */
    exportTemplate: (templateId) => request(`${base}/templates/${enc(templateId)}/export`),

    /**
     * A template file → this organisation's gallery, as a captured template.
     * → { template, report, warnings }. A file the server will not take comes
     * back 400 with .body.details naming each reason.
     */
    importTemplate: (envelope, { title } = {}) =>
        request(`${base}/templates/import`, {
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
    importApp: (envelope, { name } = {}) =>
        request(`${base}/import`, {
            method: 'POST',
            body: JSON.stringify({ envelope, ...(name ? { name } : {}) }),
        }),

    // Apps
    listAccessible: () => request(base),
    listMine: () => request(`${base}/mine`),
    /** body: { name?, description?, icon?, accentColor?, templateId? } */
    createApp: (body = {}) => request(base, { method: 'POST', body: JSON.stringify(body) }),
    /**
     * The row, with the `managed` the route sends BESIDE it ({ app, readOnly,
     * managed }) carried onto it, so every holder of the row (the shell, the
     * header, the publish modal) can tell a Solution stage's app from its own.
     */
    getApp: async (id) => {
        const res = await request(`${base}/${enc(id)}`);
        if (res && res.app && res.managed !== undefined) res.app = { ...res.app, managed: res.managed };
        return res;
    },
    updateApp: (id, meta) => request(`${base}/${enc(id)}`, { method: 'PUT', body: JSON.stringify(meta) }),
    deleteApp: (id) => request(`${base}/${enc(id)}`, { method: 'DELETE' }),

    /**
     * Autosave the working draft. Returns (never throws for these flows):
     *   { ok:true, version, warnings, repairs }
     *   { ok:false, managed, error }                              // 409 managed_part
     *   { ok:false, conflict:true, currentVersion, definition }   // 409
     *   { ok:false, invalid:true, errors, warnings }              // 422
     * Other statuses throw (incl. 413 definition_too_large).
     */
    saveDefinition: async (id, definition, baseVersion) => {
        try {
            const body = await request(`${base}/${enc(id)}/definition`, {
                method: 'PUT',
                body: JSON.stringify({ definition, baseVersion }),
            });
            return { ok: true, ...body };
        } catch (err) {
            const refused = managedResult(err);
            if (refused) return refused;
            if (err.status === 409) return { ok: false, conflict: true, ...(err.body || {}) };
            if (err.status === 422) return { ok: false, invalid: true, ...(err.body || {}) };
            throw err;
        }
    },

    /** body: { isPublished, sharedGroups? } */
    publish: (id, body) => request(`${base}/${enc(id)}/publish`, { method: 'PATCH', body: JSON.stringify(body) }),

    /**
     * Upgrade a pristine created-from-template app to the registry template's
     * newer version. → { ok, fromVersion, toVersion, version, dataInstall? }.
     * 409s (not_pristine / no_newer_version / not_from_template) throw with
     * .status/.code like every other wrapper here.
     */
    templateUpgrade: (id) => request(`${base}/${enc(id)}/template-upgrade`, { method: 'POST' }),

    /**
     * Toggle the app's entry in the organisation's Nextcloud app menu.
     * → { success, nextcloudMenu, ncConnected, ncSync } — ncConnected=false
     * means the flag is stored but no Nextcloud is paired with the org;
     * ncSync='synced' means the connector registered/removed the icon before
     * answering (a reload of Nextcloud shows it), anything else means the
     * connector's periodic check will pick it up.
     */
    setNextcloudMenu: (id, enabled) =>
        request(`${base}/${enc(id)}/nextcloud-menu`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),

    /**
     * Pre-flight the saved draft, read-only (server: appDryRun). Owner-only.
     * → { ok, static:{errors,warnings}, bindings, roleFindings, actions,
     *     emptyTables, _hints }
     * opts: { screenId?, asRole? } — omit both to check the whole app.
     */
    checkApp: (id, opts = {}) =>
        request(`${base}/${enc(id)}/check`, { method: 'POST', body: JSON.stringify(opts) }),

    // Versions
    listVersions: (id) => request(`${base}/${enc(id)}/versions`),
    restoreVersion: (id, versionId) =>
        request(`${base}/${enc(id)}/versions/${enc(versionId)}/restore`, { method: 'POST' }),

    // Run view payload ({ id, name, icon, accentColor, definition, draft? })
    getRuntime: (id, { draft = false } = {}) =>
        request(`${base}/${enc(id)}/runtime${draft ? '?draft=1' : ''}`),

    // Actions (the run bridge; useActionRunner drives these in run mode)
    runAction: (appId, actionId, { formValues = {}, draft = false } = {}) =>
        request(`${base}/${enc(appId)}/actions/${enc(actionId)}/run${draft ? '?draft=1' : ''}`, {
            method: 'POST',
            body: JSON.stringify({ formValues, wait: true }),
        }),
    getActionRun: (appId, runId) => request(`${base}/${enc(appId)}/actions/runs/${enc(runId)}`),

    // AI builder — rehydrates the persisted chat session after a refresh.
    getBuilderSession: (appId) => request(`${base}/builder/session/${enc(appId)}`),

    // Data model (owner-only). getSchema → { model, modelVersion }.
    getSchema: (id) => request(`${base}/${enc(id)}/schema`),
    /**
     * Persist the data model. Returns (never throws for these flows):
     *   { ok:true, version }
     *   { ok:false, managed, error }                           // 409 managed_part
     *   { ok:false, conflict:true, currentVersion, model }     // 409
     *   { ok:false, invalid:true, errors }                     // 422
     */
    saveSchema: async (id, model, expectedVersion) => {
        try {
            const body = await request(`${base}/${enc(id)}/schema`, {
                method: 'PUT',
                body: JSON.stringify({ model, expectedVersion }),
            });
            return { ok: true, ...body };
        } catch (err) {
            const refused = managedResult(err);
            if (refused) return refused;
            if (err.status === 409) return { ok: false, conflict: true, ...(err.body || {}) };
            if (err.status === 422) return { ok: false, invalid: true, ...(err.body || {}) };
            throw err;
        }
    },
};

export default studioAppsApi;
