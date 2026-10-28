// @typecheck
/**
 * stores/kb/catalog.js — knowledge-base CRUD: create, the system-managed
 * bases, read, update (with the Solution-stage guard), publish, categories,
 * the managed payload, delete and the content version bump; and the per-user
 * favourites. Split out of stores/knowledgeBases.js.
 */

const { UUID_RE, PROJECT_FILES_KIND, KB_COUNTS_SELECT } = require('./model');
const log = require('../../telemetry/log');

/**
 * @param {import('./model').KbCtx} ctx  the barrel's db handle, schema init,
 *        write guard and the store object itself (methods dispatch through it,
 *        so a method swapped on the export is the one the others call)
 */
function makeCatalogFns(ctx) {
    const { run, getOne, getAll, initDB, managedParts, assertKbWrite, kbUpdateChanges, stageStore, self: KnowledgeBasesStore } = ctx;
    return {
        // ── KB CRUD ─────────────────────────────────────────────────────────

        /**
         * Create a new KB.
         * @param {string} tenantId - Owner user ID
         * @param {string} name
         * @param {string} description
         * @param {string|null} organizationId - Organization this KB belongs to (null = personal)
         * @param {any} extra - Optional { categoryId, icon, sourceKind, usageContexts }
         *   - sourceKind: 'manual' | 'webpage_auto' | 'notebook_auto' (default 'manual')
         *   - usageContexts: array of 'agent' | 'direct_chat' | 'webpage' (default all three)
         */
        createKB: async (tenantId, name, description = '', organizationId = null, extra = {}) => {
            await initDB();
            const sourceKind = extra.sourceKind || 'manual';
            // Default for manual KBs: studio-managed contexts only. Webpage-owned KBs
            // pass usageContexts=['webpage'] explicitly via their auto-create paths.
            const usageContexts = Array.isArray(extra.usageContexts)
                ? extra.usageContexts
                : ['agent', 'direct_chat'];
            const isPublished = extra.isPublished === true || sourceKind === 'system_managed';
            const row = await getOne(
                `INSERT INTO knowledge_bases (tenant_id, name, description, organization_id, category_id, icon, source_kind, usage_contexts, system_slug, is_published)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
             RETURNING *`,
                [tenantId, name, description, organizationId || null, extra.categoryId || null, extra.icon || null, sourceKind, JSON.stringify(usageContexts), extra.systemSlug || null, isPublished]
            );
            return row;
        },

        /**
         * Look up a system-managed KB by its `system_slug`.
         * Returns the row or null. Used by the ingest script for idempotent upserts
         * and by the chat layer to resolve enabled-beta-feature → KB id.
         */
        getSystemKBBySlug: async (slug) => {
            await initDB();
            if (!slug) return null;
            return getOne(
                `SELECT * FROM knowledge_bases
             WHERE source_kind = 'system_managed' AND system_slug = $1
             LIMIT 1`,
                [slug]
            );
        },

        /**
         * List every seeded system-managed KB. Cheap — at most a handful of rows.
         * Used by the admin status panel and by the chat KB resolver.
         */
        listSystemKBs: async () => {
            await initDB();
            return getAll(
                `${KB_COUNTS_SELECT}
             WHERE kb.source_kind = 'system_managed'
             ORDER BY kb.name`
            );
        },

        /** Lightweight predicate for guarding write paths in routes. */
        isSystemKB: (kb) => !!(kb && kb.source_kind === 'system_managed'),

        /** Is this a project's files base (see PROJECT_FILES_KIND)? */
        isProjectFilesKB: (kb) => !!(kb && kb.source_kind === PROJECT_FILES_KIND),

        getKB: async (id) => {
            if (!id || !UUID_RE.test(String(id))) return null;
            await initDB();
            return getOne('SELECT * FROM knowledge_bases WHERE id = $1', [id]);
        },

        /**
         * `organizationId` is ONE-WAY on purpose: a value moves a personal KB into
         * an organisation, and there is no way to move it back out. Un-setting it
         * on a base colleagues may already have attached to their agents would
         * revoke their access with nothing to say so — so COALESCE is exactly the
         * right operator here, and a null means "leave as-is", never "clear".
         * The route decides WHO may set it (owner only, via assertUserCanUseOrg);
         * this only guarantees the direction.
         */
        updateKB: async (id, { name, description, categoryId, icon, usageContexts, organizationId }, opts = {}) => {
            await initDB();
            // A base in a Solution stage: its metadata changes through a deploy
            // (`opts.managedWrite`), judged on what the write actually changes.
            if (await managedParts.managedInfoForKb(String(id))) {
                const row = await KnowledgeBasesStore.getKB(id);
                if (row) {
                    const changed = kbUpdateChanges(row, { name, description, categoryId, icon, usageContexts, organizationId });
                    await assertKbWrite(id, changed, opts.managedWrite);
                }
            }
            const usageJson = Array.isArray(usageContexts) ? JSON.stringify(usageContexts) : null;
            // categoryId: undefined = leave as-is, explicit null = clear back to
            // NULL — COALESCE alone can't express the clear, so a
            // boolean flag drives a CASE for that column.
            const clearCategory = categoryId === null;
            return getOne(
                `UPDATE knowledge_bases
             SET name = COALESCE($2, name),
                 description = COALESCE($3, description),
                 category_id = CASE WHEN $7 THEN NULL ELSE COALESCE($4, category_id) END,
                 icon = COALESCE($5, icon),
                 usage_contexts = COALESCE($6::jsonb, usage_contexts),
                 organization_id = COALESCE($8, organization_id),
                 updated_at = now()
             WHERE id = $1
             RETURNING *`,
                [id, name, description, categoryId, icon, usageJson, clearCategory, organizationId || null]
            );
        },

        /**
         * Toggle publish state and (optionally) shared groups. Owner-only operation
         * enforced at the route layer.
         *
         * When `sharedGroups` is undefined, the existing DB value is preserved —
         * a toggle-publish call without an explicit groups payload must NOT
         * silently flip a group-restricted KB to entire-org visibility. Mirrors
         * the same fix in agentCrud.setAgentPublished.
         */
        setPublished: async (id, isPublished, sharedGroups) => {
            await initDB();
            if (sharedGroups === undefined) {
                return getOne(
                    `UPDATE knowledge_bases
                 SET is_published = $2,
                     updated_at = now()
                 WHERE id = $1
                 RETURNING *`,
                    [id, !!isPublished]
                );
            }
            const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
            return getOne(
                `UPDATE knowledge_bases
             SET is_published = $2,
                 shared_groups = $3,
                 updated_at = now()
             WHERE id = $1
             RETURNING *`,
                [id, !!isPublished, groupsJson]
            );
        },

        // ── KB Categories (org-level, mirrors agent_categories) ─────────────

        listKBCategories: async (organizationId) => {
            await initDB();
            if (!organizationId) {
                return getAll(`SELECT * FROM kb_categories WHERE organization_id IS NULL ORDER BY name`);
            }
            return getAll(
                `SELECT * FROM kb_categories WHERE organization_id = $1 ORDER BY name`,
                [organizationId]
            );
        },

        createKBCategory: async ({ id, organizationId, name, icon, color }) => {
            await initDB();
            return getOne(
                `INSERT INTO kb_categories (id, organization_id, name, icon, color)
             VALUES ($1, $2, $3, COALESCE($4, '📚'), COALESCE($5, '#6366f1'))
             RETURNING *`,
                [id, organizationId || null, name, icon, color]
            );
        },

        deleteKBCategory: async (id) => {
            await initDB();
            // Detach any KBs from this category, then remove it
            await run(`UPDATE knowledge_bases SET category_id = NULL WHERE category_id = $1`, [id]);
            await run(`DELETE FROM kb_categories WHERE id = $1`, [id]);
            return true;
        },

        /**
         * Refuse `changedKeys` on a base a Solution stage manages (409
         * managed_part) unless `managedWrite` is a deployment's capability. A
         * route that does irreversible work before the store write (the DELETE
         * purges chunks first) asks here before it starts.
         */
        assertKbWrite: (id, changedKeys, managedWrite = null, opts = {}) => assertKbWrite(id, changedKeys, managedWrite, opts),

        /**
         * What a GET says about the Solution stage that manages this base:
         * null | {solutionId, solutionName, stage, releaseSeq, devRef} (design 5.3).
         */
        managedPayload: async (id) => {
            if (!id) return null;
            const info = await managedParts.managedInfoForKb(String(id));
            if (!info) return null;
            return stageStore().managedPayloadFor({
                projectId: info.stageProjectId, kind: 'knowledge_base', entityId: String(id),
            });
        },

        /** @param {{ managedWrite?: { deploymentId?: string }|null }} [opts] a base in a stage is deleted only by a deploy */
        deleteKB: async (id, opts = {}) => {
            await initDB();
            await assertKbWrite(id, ['delete'], opts.managedWrite);
            // Documents cascade-delete; chunks must be deleted via search-service.
            // Also scrub this KB from any project's knowledge_base_ids so projects
            // don't carry dangling references after the KB row is gone.
            try {
                await run(
                    `UPDATE projects
                 SET knowledge_base_ids = COALESCE(
                     (SELECT jsonb_agg(elem) FROM jsonb_array_elements_text(knowledge_base_ids) elem WHERE elem <> $1),
                     '[]'::jsonb
                 )
                 WHERE knowledge_base_ids @> to_jsonb($1::text)`,
                    [id]
                );
            } catch (e) { log.debug('projects table may not exist yet on first boot', e); }
            await run('DELETE FROM knowledge_bases WHERE id = $1', [id]);
            return true;
        },

        /**
         * Content changed (ingest, replace, delete): bump the version the search
         * caches key on and stamp last_content_at — the "Updated 2 min ago" pill.
         * Metadata edits (updateKB/setPublished) deliberately do NOT touch it.
         */
        bumpKBVersion: async (id) => {
            await initDB();
            return getOne(
                `UPDATE knowledge_bases SET kb_version = kb_version + 1, updated_at = now(), last_content_at = now()
             WHERE id = $1 RETURNING kb_version, last_content_at`,
                [id]
            );
        },

        // ── KB Favorites ────────────────────────────────────────────────────
        listFavorites: async (userId) => {
            await initDB();
            const rows = await getAll(
                `SELECT kb_id FROM kb_favorites WHERE user_id = $1 ORDER BY created_at ASC`,
                [userId]
            );
            return rows.map(r => r.kb_id);
        },
        addFavorite: async (userId, kbId) => {
            await initDB();
            await run(
                `INSERT INTO kb_favorites (user_id, kb_id) VALUES ($1, $2)
             ON CONFLICT (user_id, kb_id) DO NOTHING`,
                [userId, kbId]
            );
        },
        removeFavorite: async (userId, kbId) => {
            await initDB();
            await run(
                `DELETE FROM kb_favorites WHERE user_id = $1 AND kb_id = $2`,
                [userId, kbId]
            );
        },
    };
}

module.exports = { makeCatalogFns };
