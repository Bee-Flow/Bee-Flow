// @typecheck
/**
 * Install the WEBPAGES, unpublished. Their bridge grants are written later, by
 * the reference pass (install/patch.js, install/grants.js).
 */

'use strict';

const { fromRefs, isRef } = require('../../../../core/packaging/pointers');
const { writeOpts } = require('../context');

async function installWebpages(entities, ctx, report) {
    if (!ctx.can('webpages')) {
        for (const e of entities) report.skipped.push({ ref: e.ref, kind: 'webpage', why: 'Webpages are not part of this plan.', permanent: true });
        return;
    }
    const webpageStore = require('../../../../stores/webpageStore');
    for (const entity of entities) {
        try {
            // The page's knowledge bases: only the ones this bundle carries,
            // by `$ref` (installed before any page). A bare id names a base of
            // the installation the file came from, so it is not a pointer here.
            const kbHolder = { knowledgeBaseIds: (Array.isArray(entity.knowledgeBaseIds) ? entity.knowledgeBaseIds : []).filter(isRef) };
            const { unresolved } = fromRefs('webpage', kbHolder, ctx.refMap);
            for (const u of unresolved) {
                report.warnings.push(`A reference to "${u.ref}" could not be connected — whatever it pointed at was not installed.`);
            }
            const created = await webpageStore.createWebpage({
                userId: ctx.ownerId,
                name: entity.name || 'Untitled Webpage',
                description: entity.description || '',
                instructions: entity.instructions || '',
                ...(kbHolder.knowledgeBaseIds.length ? { knowledgeBaseIds: kbHolder.knowledgeBaseIds } : {}),
            });
            // Unpublished by construction — an installed page must not be live
            // on arrival any more than an installed automation must be running.
            const files = entity.files || {};
            for (const [slot, content] of [['html', files.html], ['css', files.css], ['js', files.js]]) {
                if (content) await webpageStore.writeSlot(ctx.ownerId, created.id, slot, content, writeOpts(ctx));
            }
            await webpageStore.setWebpageProject(created.id, ctx.ownerId, ctx.projectId);
            // An installed page is a page with code, so it belongs in the
            // dependents index too. Without this the one page nobody ever
            // edits by hand was never in it, and that is exactly the kind of
            // page whose owner does not know which tables hang under it.
            // Debounced and detached; an install does not wait.
            require('../../../../core/webpages/webpageUsageSync').reconcileWebpageUsageDetached(created.id);
            ctx.refMap.set(entity.ref, created.id);
            await ctx.stamp({ ref: entity.ref, kind: 'webpage', entityId: created.id, payload: entity.files || {} });
            report.installed.webpages.push({ ref: entity.ref, id: created.id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'webpage', why: err.message });
        }
    }
}

module.exports = { installWebpages };
