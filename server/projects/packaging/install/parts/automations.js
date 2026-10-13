/**
 * Install the AUTOMATIONS (and blocks and layers): validated through the
 * single-automation import path, wired with the installer's resolutions,
 * rekeyed, created inactive and filed into the project.
 */

'use strict';

const { clone, resolveKnownRefs, applyResolutionsTo } = require('../refs');
const { writeOpts } = require('../context');

/** Blocks and layers are building materials: they must exist before callers. */
const KIND_ORDER = { block: 0, layer: 0, automation: 1 };

async function installAutomations(entities, ctx, report) {
    const { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION, sanitizeImport, rekeyDefinition } = require('../../../../automation/portability');
    const automationStore = require('../../../../stores/automationStore');

    const ordered = [...entities].sort(
        (a, b) => (KIND_ORDER[a.kind] ?? 1) - (KIND_ORDER[b.kind] ?? 1),
    );

    for (const entity of ordered) {
        try {
            // Through the normal import path, so a Blueprint's automations are
            // validated by the same code a single-automation import uses.
            const { automation, errors } = sanitizeImport({
                format: EXPORT_FORMAT, schemaVersion: EXPORT_SCHEMA_VERSION, automation: clone(entity),
            });
            if (!automation) { report.skipped.push({ ref: entity.ref, kind: 'automation', why: errors.join(' '), permanent: true }); continue; }

            // Tables and knowledge bases are installed before any automation, so
            // their `$ref`s resolve now: a step wired to the bundle's own table
            // is then no hole for the resolutions below to fill or warn about.
            resolveKnownRefs('automation', { definition: automation.definition }, ctx.refMap, ['datatable', 'knowledgeBase']);

            // What the INSTALLER supplied, before the step ids change: a
            // resolution is addressed by the id the wizard read off the
            // manifest, and rekeyDefinition replaces every one of them.
            const applied = applyResolutionsTo(automation.definition, entity.ref, ctx, report);

            // Fresh step ids per graph, so two installs of the same Blueprint
            // never share them. The rename map goes on the stamp, so an
            // upgrade can put the same ids on the next version (F10). A stage
            // copy keeps Dev's ids (ctx.rekey false), and its map is identity.
            let definition = automation.definition;
            let stepIdMap = null;
            if (ctx.rekey !== false) ({ definition, renameMap: stepIdMap } = rekeyDefinition(definition));

            // A reusable Step is a `kind = 'block'` row, which only createStep
            // makes; createAutomation would land it as a plain automation.
            const created = entity.kind === 'block'
                ? await automationStore.createStep({
                    userId: ctx.ownerId,
                    organizationId: ctx.organizationId,
                    title: automation.title,
                    description: automation.description || '',
                    definition,
                })
                : await automationStore.createAutomation({
                    userId: ctx.ownerId,
                    organizationId: ctx.organizationId,
                    title: automation.title,
                    description: automation.description || '',
                    definition,
                    triggerType: automation.triggerType || 'manual',
                    scheduleCron: automation.scheduleCron || null,
                    scheduleTz: automation.scheduleTz || undefined,
                });
            await automationStore.updateAutomation(created.id, { projectId: ctx.projectId }, ctx.ownerId, writeOpts(ctx));
            ctx.refMap.set(entity.ref, created.id);
            // Kept only for an automation that actually landed (persistResolutions).
            if (ctx.wiring && Array.isArray(ctx.wiring.applied)) ctx.wiring.applied.push(...applied);
            await ctx.stamp({ ref: entity.ref, kind: 'automation', entityId: created.id, payload: definition, stepIdMap });
            report.installed.automations.push({ ref: entity.ref, id: created.id, title: automation.title });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'automation', why: err.message });
        }
    }
}

module.exports = { KIND_ORDER, installAutomations };
