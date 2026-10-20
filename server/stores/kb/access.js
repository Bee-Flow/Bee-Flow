// @typecheck
/**
 * stores/kb/access.js — who sees which knowledge base: the listing per
 * caller (owner, org member, org admin, super admin, system bases), the group
 * filter, and the read and manage predicates. Split out of
 * stores/knowledgeBases.js.
 */

const { PROJECT_FILES_KIND, KB_COUNTS_SELECT } = require('./model');

/**
 * @param {import('./model').KbCtx} ctx  the barrel's db handle, schema init,
 *        write guard and the store object itself (methods dispatch through it,
 *        so a method swapped on the export is the one the others call)
 */
function makeAccessFns(ctx) {
    const { getAll, initDB, self: KnowledgeBasesStore } = ctx;
    return {
        /**
         * List KBs accessible to the user.
         * @param {string} tenantId - The user's ID
         * @param {Set|null} orgIds - User's org IDs from resolveUserOrgIds().
         *   null = super admin (see all), Set with values = org member, empty Set = no org
         * @param {object} [opts]
         * @param {string|string[]|null} [opts.sourceKind='manual'] - Filter by source kind.
         *   Pass a string for one kind, an array for several, or null to include all kinds.
         * @param {string|null} [opts.usageContext=null] - When set, only KBs whose `usage_contexts`
         *   array contains this value are returned ('agent' | 'direct_chat' | 'webpage').
         * @param {string|null} [opts.excludeContext=null] - Inverse of `usageContext`. KBs whose
         *   `usage_contexts` array contains this value are excluded.
         * @param {string[]} [opts.systemSlugs=null] - When provided, system-managed KBs whose
         *   `system_slug` is in this list are included in addition to the normal personal/org
         *   results. Used by the chat layer to surface system KBs whose beta feature is enabled
         *   for the requesting user's org.
         * @param {boolean} [opts.isOrgAdmin] - server-resolved; org admins also see draft org KBs.
         */
        listKBs: async (tenantId, orgIds = undefined, opts = {}) => {
            await initDB();

            const sourceKindOpt = opts.sourceKind === undefined ? 'manual' : opts.sourceKind;
            const sourceKindList = sourceKindOpt === null
                ? null
                : (Array.isArray(sourceKindOpt) ? sourceKindOpt : [sourceKindOpt]);
            const usageContext = opts.usageContext || null;
            const excludeContext = opts.excludeContext || null;
            const systemSlugs = Array.isArray(opts.systemSlugs) ? opts.systemSlugs : null;

            // Build optional filter clauses + their bound params. Each branch below
            // appends these so the marketplace, agent and direct-chat pickers all
            // narrow the same way.
            const buildFilters = (startIdx) => {
                const conds = [];
                const params = [];
                let idx = startIdx;
                if (sourceKindList && sourceKindList.length > 0) {
                    conds.push(`kb.source_kind = ANY($${idx++})`);
                    params.push(sourceKindList);
                }
                if (usageContext) {
                    conds.push(`kb.usage_contexts ? $${idx++}`);
                    params.push(usageContext);
                }
                if (excludeContext) {
                    conds.push(`NOT (kb.usage_contexts ? $${idx++})`);
                    params.push(excludeContext);
                }
                return { sql: conds.length > 0 ? ' AND ' + conds.join(' AND ') : '', params };
            };

            // System-managed KBs ride alongside personal + org-published results.
            // They are filtered by an explicit allow-list of system_slugs from the
            // caller (resolved from the org's enabled beta features). We OR them
            // into the visibility predicate AFTER the sourceKind/usageContext
            // filters so the same slug list always applies regardless of the kind
            // filter.
            const buildSystemUnion = (startIdx) => {
                if (!systemSlugs || systemSlugs.length === 0) return { sql: '', params: [] };
                const conds = [`kb.source_kind = 'system_managed'`, `kb.system_slug = ANY($${startIdx})`];
                /** @type {Array<string|string[]>} */
                const params = [systemSlugs];
                let idx = startIdx + 1;
                if (usageContext) {
                    conds.push(`kb.usage_contexts ? $${idx++}`);
                    params.push(usageContext);
                }
                if (excludeContext) {
                    conds.push(`NOT (kb.usage_contexts ? $${idx++})`);
                    params.push(excludeContext);
                }
                return { sql: ` UNION ${KB_COUNTS_SELECT}
                WHERE ${conds.join(' AND ')}`, params };
            };

            const baseSelect = KB_COUNTS_SELECT;

            // Legacy fallback: if orgIds not provided, show only user's own KBs
            if (orgIds === undefined) {
                const f = buildFilters(2);
                const u = buildSystemUnion(2 + f.params.length);
                return getAll(
                    `${baseSelect} WHERE kb.tenant_id = $1${f.sql}${u.sql}
                 ORDER BY created_at DESC`,
                    [tenantId, ...f.params, ...u.params]
                );
            }

            // Super admin — see all KBs. When the caller has narrowed by
            // sourceKind (e.g. 'manual' for the picker), system KBs whose slug is
            // on the systemSlugs allow-list are unioned back in so super admins
            // get the same chat UX as regular users.
            if (orgIds === null) {
                const f = buildFilters(1);
                const where = f.sql ? ' WHERE ' + f.sql.replace(/^ AND /, '') : '';
                const u = buildSystemUnion(1 + f.params.length);
                return getAll(
                    `${baseSelect}${where}${u.sql} ORDER BY created_at DESC`,
                    [...f.params, ...u.params]
                );
            }

            const orgIdArray = Array.from(orgIds);

            if (orgIdArray.length === 0) {
                // No org membership — only personal KBs (+ enabled system KBs, if any)
                const f = buildFilters(2);
                const u = buildSystemUnion(2 + f.params.length);
                return getAll(
                    `${baseSelect} WHERE kb.tenant_id = $1${f.sql}${u.sql}
                 ORDER BY created_at DESC`,
                    [tenantId, ...f.params, ...u.params]
                );
            }

            // Org member — personal KBs (any state) + PUBLISHED KBs from user's org(s)
            // + enabled system-managed KBs.
            // Group restriction (shared_groups) is applied in JS by callers via filterByGroupAccess.
            const f = buildFilters(3);
            const u = buildSystemUnion(3 + f.params.length);
            // Org admins see every KB in their org (drafts included); regular
            // members see only PUBLISHED org KBs. Owner KBs always included.
            // (isOrgAdmin is a server-resolved boolean, never user input.)
            const orgDraftClause = opts.isOrgAdmin ? '' : ' AND kb.is_published = TRUE';
            // A project's files base is never an org row, whoever asks (see
            // PROJECT_FILES_KIND): an org admin's ?includeAuto=1 listing must not
            // hand them the files of a project they are not a member of.
            return getAll(
                `${baseSelect}
             WHERE (kb.tenant_id = $1 OR (kb.organization_id = ANY($2) AND kb.source_kind IS DISTINCT FROM '${PROJECT_FILES_KIND}'${orgDraftClause}))${f.sql}${u.sql}
             ORDER BY created_at DESC`,
                [tenantId, orgIdArray, ...f.params, ...u.params]
            );
        },

        /**
         * Filter a KB list down to those the user is allowed to see based on
         * `shared_groups` group restrictions. Owner KBs (tenant_id = userId)
         * always pass. Drafts (is_published = false) always pass for the owner.
         *
         * @param {Array} kbs - Result of listKBs
         * @param {string} userId - The user's ID
         * @param {Array<string>} userGroups - Group IDs the user belongs to
         */
        filterByGroupAccess: (kbs, userId, userGroups = [], opts = {}) => {
            if (!Array.isArray(kbs)) return [];
            return kbs.filter(kb => KnowledgeBasesStore.canUserAccessKB(kb, userId, opts.orgIds, userGroups, { isOrgAdmin: opts.isOrgAdmin }));
        },

        /**
         * Single source of truth for "is this user allowed to read this KB?".
         * Used both by the list filter and by per-id route guards so the two
         * paths can never drift.
         *
         * @param {any} kb - Row from knowledge_bases
         * @param {string} userId - The requesting user's id
         * @param {Set|null|undefined} orgIds - User's org ids; null = super admin.
         *   When undefined, org membership is not considered (list-path callers
         *   already constrained the query by org, so only group rules need to run).
         * @param {Array<string>} userGroups - Group ids the user belongs to
         */
        canUserAccessKB: (kb, userId, orgIds = undefined, userGroups = [], opts = {}) => {
            if (!kb) return false;
            // System-managed KBs hold public reference content (e.g. Dutch
            // legislation). Read access is granted to any authenticated user; the
            // beta-feature toggle gates whether they appear in pickers / chat,
            // not whether the underlying public text is reachable.
            if (kb.source_kind === 'system_managed') return true;
            // A project's files base: its owner and a super admin, nobody else.
            // Members reach it through the project (see PROJECT_FILES_KIND); an
            // org admin or a "published" flag must not.
            if (kb.source_kind === PROJECT_FILES_KIND) return kb.tenant_id === userId || orgIds === null;
            // Owner always has access
            if (kb.tenant_id === userId) return true;
            // Super admin
            if (orgIds === null) return true;
            // Org admins always see every KB in their organisation — including
            // unpublished drafts and group-restricted KBs (read access). Scoped to
            // the admin's own org(s); a member's personal (no-org) KB stays private.
            if (opts.isOrgAdmin && kb.organization_id && orgIds instanceof Set && orgIds.has(kb.organization_id)) {
                return true;
            }
            // Direct-fetch path: must be in the KB's org
            if (orgIds instanceof Set) {
                if (!kb.organization_id || !orgIds.has(kb.organization_id)) return false;
            }
            // Drafts hidden from non-owners
            if (!kb.is_published) return false;
            // shared_groups restriction
            let groups = [];
            try { groups = JSON.parse(kb.shared_groups || '[]'); } catch { groups = []; }
            if (!Array.isArray(groups) || groups.length === 0) return true;
            return groups.some(g => userGroups.includes(g));
        },

        /**
         * "Is this user allowed to MANAGE this KB's settings?" (BFSF-214).
         * Deliberately separate from canUserAccessKB: draft status gates READING
         * content, not managing settings. Non-owner managers must belong to the
         * KB's org AND hold manage_knowledge (checked by the caller via
         * hasPermission and passed in as a boolean so this stays pure/testable).
         *
         * @param {any} kb - Row from knowledge_bases
         * @param {string} userId - Requesting user's id
         * @param {Set|null} orgIds - resolveUserOrgIds(req) result; null = super admin
         * @param {boolean} hasManagePermission - hasPermission(userId,'manage_knowledge')
         */
        canUserManageKB: (kb, userId, orgIds, hasManagePermission) => {
            if (!kb) return false;
            // A project's files are added and removed through the project, by its
            // role ladder; the generic routes manage nothing in that base.
            if (kb.source_kind === PROJECT_FILES_KIND) return false;
            if (kb.tenant_id === userId) return true;          // owner
            if (orgIds === null) return true;                  // super admin
            if (!kb.organization_id) return false;             // personal KB of someone else
            if (!(orgIds instanceof Set) || !orgIds.has(kb.organization_id)) return false; // must share org
            return !!hasManagePermission;
        },

    };
}

module.exports = { makeAccessFns };
