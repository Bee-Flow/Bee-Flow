/**
 * App Studio — the ONE place templates are looked up.
 *
 * Templates now come from two places and must never look like two features:
 *
 *   • BUILT-IN — the modules in appStudio/templates/, listed by templates.js.
 *     Reviewed code, shipped with the image, identical on every instance.
 *   • CAPTURED — rows in studio_app_templates, made from a live app by
 *     templateCapture.js. Instance-local, org-scoped, no release required.
 *
 * Everything downstream (the gallery route, create-from-template, the builder's
 * app_list_templates / app_apply_template) goes through here, so a captured
 * template installs by exactly the same path as a built-in one:
 * studioApps.js clones `definition`, templateInstall.js does the data side.
 *
 * Ids discriminate: captured ids start with `utpl_`, built-in ids do not. That
 * is why resolveTemplate can be a single function rather than a caller-side
 * if/else that someone will eventually forget in one of the four call sites.
 *
 * SYNC vs ASYNC. The built-in registry is synchronous and stays that way —
 * templateUpgrade.js and the tests lean on it. This module is async because a
 * captured template is a database row. Callers that only ever want a built-in
 * (none, currently) can still use templates.js directly.
 *
 * VISIBILITY is passed in, never inferred: { userId, orgIds }. A store that
 * decides for itself who may read a row is a store whose rules live in two
 * places, and the org resolution already exists in the route layer.
 */

'use strict';

const builtIn = require('./templates');
const log = require('../telemetry/log');

/** Lazy — the store opens a DB pool, and the built-in path must not need one. */
function captureStore() {
    return require('../stores/studioAppTemplateStore');
}

/** Built-in gallery rows, tagged with their provenance. */
function listBuiltIn() {
    return builtIn.listTemplates().map((t) => ({ ...t, source: 'builtin' }));
}

/**
 * The full gallery for one viewer: built-ins first (they are the curated set),
 * then the org's own captures, newest first.
 *
 * A store failure degrades to the built-in list rather than an error page. The
 * gallery is how someone starts an app; losing the captured half is a smaller
 * harm than losing all of it.
 */
async function listAvailableTemplates({ userId, orgIds = [] } = {}) {
    const rows = listBuiltIn();
    try {
        const captured = await captureStore().listTemplatesFor({ userId, orgIds });
        return [...rows, ...captured];
    } catch (e) {
        log.warn(`[templateRegistry] captured-template listing failed: ${e && e.message ? e.message : e}`);
        return rows;
    }
}

/**
 * One template WITH its definition/dataModel/seed, or null when it does not
 * exist or this viewer may not see it.
 *
 * Returns null rather than throwing on a store error, for the same reason
 * getTemplate(unknownId) returns null: every caller already handles "no such
 * template" and none of them handles an exception.
 */
async function resolveTemplate(id, { userId, orgIds = [] } = {}) {
    if (typeof id !== 'string' || !id) return null;
    const store = captureStore();
    if (!store.isCapturedTemplateId(id)) {
        const t = builtIn.getTemplate(id);
        return t ? { ...t, source: 'builtin' } : null;
    }
    try {
        const t = await store.getTemplateById(id);
        if (!t || !store.canRead(t, { userId, orgIds })) return null;
        return t;
    } catch (e) {
        log.warn(`[templateRegistry] captured-template read failed for ${id}: ${e && e.message ? e.message : e}`);
        return null;
    }
}

/**
 * The `getTemplate` seam templateUpgrade.annotateTemplateUpgrades injects.
 * Bound to one viewer and awaited by the caller, so an app created from a
 * CAPTURED template is offered its newer version too — re-saving an improved
 * app over its own template is the obvious thing to want, and the upgrade
 * machinery already knows how to deliver it to pristine copies.
 */
function templateResolverFor(viewer) {
    return (id) => resolveTemplate(id, viewer);
}

module.exports = {
    listAvailableTemplates,
    listBuiltIn,
    resolveTemplate,
    templateResolverFor,
    templateVersion: builtIn.templateVersion,
};
