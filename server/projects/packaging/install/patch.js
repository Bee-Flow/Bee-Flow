// @typecheck
/**
 * The second pass of an install: with every id known, put the references back
 * (`patchReferences`), and keep the installer's resolutions for later
 * upgrades (`persistResolutions`).
 */

'use strict';

const { resolutionsToBindings } = require('../resolutions');
const { clone, resolveRefs } = require('./refs');
const { writeOpts } = require('./context');
const { safeInstallGrants } = require('./grants');

/**
 * The second pass: with every id known, put the references back.
 *
 * Written through the stores' own save paths, never raw SQL — the same
 * discipline templateInstall keeps, so an installed entity goes through
 * whatever validation and stamping a hand-edited one would.
 */
async function patchReferences(manifest, ctx, report, { refs = null } = {}) {
    const entities = manifest.solution.entities;
    const unresolved = [];
    // An upgrade patches only the parts it ADDED (F11); the parts it replaced
    // resolve their own references on the way in.
    const mine = (entity) => (!refs || refs.has(entity.ref)) && ctx.refMap.has(entity.ref);

    for (const entity of (entities.apps || []).filter(mine)) {
        const id = ctx.refMap.get(entity.ref);
        try {
            const { definition } = resolveRefs('app', { definition: clone(entity.definition) }, ctx.refMap, unresolved);
            await require('../../../stores/studioAppStore').saveDefinition(id, ctx.ownerId, definition, writeOpts(ctx));
        } catch (err) {
            report.warnings.push(`Could not connect the references inside "${entity.name}": ${/** @type {Error} */ (err).message}`);
        }
    }

    for (const entity of (entities.automations || []).filter(mine)) {
        const id = ctx.refMap.get(entity.ref);
        if (!JSON.stringify(entity.definition).includes('"$ref"')) continue;      // nothing to put back
        try {
            const live = await require('../../../stores/automationStore').getAutomation(id);
            // The stored copy: its step ids are the ones this install chose.
            const { definition } = resolveRefs('automation', { definition: clone(live.definition) }, ctx.refMap, unresolved, ctx.templateVersions);
            // goLive: the resolved references are part of the installed
            // automation, not a pending edit (handoff 5 live split). An automation
            // that never ran stays a draft: the store moves a live copy only
            // on an automation that has one (lifecycle LIVE_INVARIANT_SQL).
            await require('../../../stores/automationStore').updateAutomation(id, { definition }, ctx.ownerId, { goLive: true, ...writeOpts(ctx) });
        } catch (err) {
            report.warnings.push(`Could not connect the references inside "${entity.title}": ${/** @type {Error} */ (err).message}`);
        }
    }

    for (const entity of (entities.webpages || []).filter(mine)) {
        const id = ctx.refMap.get(entity.ref);
        try {
            await require('../../../stores/webpageStore').updateBridgeGrants(
                id, ctx.ownerId, safeInstallGrants(entity, ctx.refMap, unresolved), writeOpts(ctx),
            );
        } catch (err) {
            report.warnings.push(`Could not set what "${entity.name}" is allowed to call: ${/** @type {Error} */ (err).message}`);
        }
        const publicAsked = (Array.isArray(entity?.bridgeGrants?.tables) ? entity.bridgeGrants.tables : [])
            .some(g => Array.isArray(g?.publicColumns) && g.publicColumns.length);
        if (publicAsked) {
            report.warnings.push(`"${entity.name}" asks to show table columns to anonymous visitors. An install never grants that: open the page and choose the public columns yourself.`);
        }
    }

    for (const ref of [...new Set(unresolved)]) {
        report.warnings.push(`A reference to "${ref}" could not be connected — whatever it pointed at was not installed.`);
    }
}

/**
 * Keep the installer's resolutions as `solution_bindings` rows on the new
 * project (F3): an upgrade reads them back and fills the same holes. A table
 * the installer asked to have CREATED is kept as the table that was made.
 * Never fatal: the install already applied them; without the rows only a
 * later upgrade forgets them, and the report says so.
 */
async function persistResolutions(ctx, report) {
    if (!ctx.wiring) return;
    const rows = resolutionsToBindings(ctx.wiring.resolutions, {
        createdForKey: ctx.wiring.createdForKey,
        // Connections and approvers: only the ones that landed on a step of a
        // automation that was installed. One that missed was said once, here.
        applied: Array.isArray(ctx.wiring.applied) ? ctx.wiring.applied : null,
    });
    if (!rows.length) return;
    try {
        const store = ctx.deps?.bindings || require('../../../stores/solutionStageStore');
        await store.upsertBindings(ctx.projectId, rows, ctx.ownerId);
    } catch (err) {
        report.warnings.push(`Your choices were applied, but could not be saved for later updates, so an update will leave those steps unconnected again: ${/** @type {Error} */ (err).message}`);
    }
}

module.exports = { patchReferences, persistResolutions };
