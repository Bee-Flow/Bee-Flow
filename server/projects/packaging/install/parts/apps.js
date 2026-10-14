// @typecheck
/**
 * Install the APPS, each with its own data model (F13).
 */

'use strict';

const { clone, resolveRefs } = require('../refs');
const { writeOpts } = require('../context');

/**
 * An app's own tables (F13): the SHAPE capture read from
 * `studio_app_data_meta.model`, written through the store's own save path so
 * the physical schema is created the way an edit in App Studio creates it.
 *
 * A table that reads a Studio datatable this bundle carries arrives pointing
 * at the copy installed a moment ago (`$ref`). One that read a table outside
 * the bundle arrives with `datatableId: null`: it is left out and named,
 * because a linked table with no table behind it is a model the validator
 * refuses, and the installer links it in the app's data settings. A model that
 * still does not save is reported, never fatal: the app itself is installed.
 */
async function installAppDataModel(appId, entity, ctx, report) {
    if (!entity.dataModel || typeof entity.dataModel !== 'object' || Array.isArray(entity.dataModel)) return;
    const holder = { dataModel: clone(entity.dataModel) };
    const unresolved = [];
    resolveRefs('app', holder, ctx.refMap, unresolved);
    for (const ref of [...new Set(unresolved)]) {
        report.warnings.push(`A reference to "${ref}" in the data model of "${entity.name}" could not be connected — whatever it pointed at was not installed.`);
    }
    const model = holder.dataModel;
    const tables = Array.isArray(model.tables) ? model.tables : [];
    const unlinked = tables.filter(t => t && typeof t.source === 'object' && t.source !== null
        && (typeof t.source.datatableId !== 'string' || !t.source.datatableId));
    if (unlinked.length) {
        model.tables = tables.filter(t => !unlinked.includes(t));
        report.warnings.push(`"${entity.name}" reads ${unlinked.length} table(s) from outside this Solution (${unlinked.map(t => `"${t.key || t.id}"`).join(', ')}). They were left out: link them in the app's data settings.`);
    }
    try {
        const out = await require('../../../../stores/studioAppDataStore')
            .saveDataModel(appId, ctx.ownerId, model, { ...(ctx.dataModelOptions || {}), ...writeOpts(ctx) });
        if (out && out.ok === false) {
            const why = Array.isArray(out.errors) && out.errors.length ? out.errors.join(' ') : 'it was refused';
            report.warnings.push(`The data model of "${entity.name}" could not be set up (${why}). The app is installed without its own tables.`);
        }
    } catch (err) {
        report.warnings.push(`The data model of "${entity.name}" could not be set up: ${err.message}`);
    }
}

async function installApps(entities, ctx, report) {
    if (!ctx.can('app_studio')) {
        for (const e of entities) report.skipped.push({ ref: e.ref, kind: 'app', why: 'App Studio is not part of this plan.', permanent: true });
        return;
    }
    const studioAppStore = require('../../../../stores/studioAppStore');
    for (const entity of entities) {
        try {
            const created = await studioAppStore.createStudioApp({
                userId: ctx.ownerId,
                organizationId: ctx.organizationId,
                name: entity.name || 'Untitled app',
                description: entity.description || '',
                icon: entity.icon || null,
                accentColor: entity.accentColor || null,
                definition: clone(entity.definition),
            });
            await studioAppStore.setAppProject(created.id, ctx.ownerId, ctx.projectId);
            ctx.refMap.set(entity.ref, created.id);
            await installAppDataModel(created.id, entity, ctx, report);
            await ctx.stamp({ ref: entity.ref, kind: 'app', entityId: created.id, payload: entity.definition });
            report.installed.apps.push({ ref: entity.ref, id: created.id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'app', why: err.message });
        }
    }
}

module.exports = { installAppDataModel, installApps };
