// @typecheck
/**
 * Install the KNOWLEDGE BASES, as empty shells filed through the adapter.
 */

'use strict';

const { writeOpts } = require('../context');

/**
 * Install the KNOWLEDGE BASES, as empty shells.
 *
 * A base arrives with a name, a description, an icon and the surfaces its
 * author allowed — and no documents and no sources, because those are the
 * source organisation's material and its places to fetch from. Whoever installs
 * it fills it with their own, which is also what `duplicate` does and for the
 * same reason.
 *
 * The link into the project goes through the SAME adapter the resources route
 * uses, so the compare-and-swap on `projects.version` applies here too: an
 * install writing the whole array by hand would delete a base a colleague added
 * while it was running.
 */
async function installKnowledgeBases(entities, ctx, report) {
    if (!entities.length) return;
    const kbStore = require('../../../../stores/knowledgeBases');
    const kbMembership = require('../../../knowledgeBaseMembership');
    for (const entity of entities) {
        try {
            const created = await kbStore.createKB(
                ctx.ownerId,
                entity.name || 'Untitled knowledge base',
                entity.description || '',
                ctx.organizationId || null,
                {
                    icon: entity.icon || null,
                    // Filed under no category on purpose: a category id names a
                    // row of the source installation, so there is nothing to
                    // carry and nothing to guess.
                    categoryId: null,
                    sourceKind: 'manual',
                    ...(Array.isArray(entity.usageContexts) ? { usageContexts: entity.usageContexts } : {}),
                },
            );
            // Attaching by the owner's own hand: they created the base a moment
            // ago, so the read check the adapter applies passes by
            // construction. It still goes through the adapter rather than
            // around it — an install must not be the one path that writes
            // `knowledge_base_ids` without the compare-and-swap.
            const filed = await kbMembership.setKnowledgeBaseProject(created.id, ctx.ownerId, ctx.projectId,
                { req: ctx.req, projectId: ctx.projectId, ...writeOpts(ctx) });
            if (!filed) {
                // Said out loud rather than left as a base that exists and is
                // in no project. Reachable when the caller had no request to
                // check against — an install run from a script, say.
                report.warnings.push(`"${entity.name}" was created but could not be filed into the Solution. Add it to the project by hand.`);
            }
            ctx.refMap.set(entity.ref, created.id);
            await ctx.stamp({ ref: entity.ref, kind: 'knowledge_base', entityId: created.id, payload: { name: entity.name } });
            report.installed.knowledgeBases.push({ ref: entity.ref, id: created.id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'knowledge_base', why: /** @type {Error} */ (err).message });
        }
    }
}

module.exports = { installKnowledgeBases };
