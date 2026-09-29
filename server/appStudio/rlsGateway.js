/**
 * App Studio — VIEWER ROLE RESOLUTION, over the shared access-filter compiler.
 *
 * The compiler half — resolveScope / canRead / compileAccessFilter /
 * assertCanWrite / rowFilterToSql / validateRowFilter / AccessError — moved to
 * core/dataEngine/accessFilter.js so automation datatables can scope rows with
 * the SAME code (server/layering.test.js forbids one feature requiring
 * another). This module re-exports it unchanged, so every existing caller and
 * every existing test keeps its import path and its behaviour.
 *
 * What stayed is the one function that genuinely knows about apps:
 * resolveViewerRole reads studio_app_members and the model's role mapping. A
 * datatable has no members table — it resolves its grade from the organisation
 * (auth/datatableAccess.js) and produces the same {where, params} shape.
 *
 * The `require('../stores/studioAppDataStore')` below must stay in THIS file:
 * rlsGateway.matrix.test.js, rlsGateway.publicRole.test.js and
 * queryCompiler.safety.test.js pre-seed require.cache for that exact resolved
 * path, and Node caches by absolute path.
 */

'use strict';

const accessFilter = require('../core/dataEngine/accessFilter');
const studioAppDataStore = require('../stores/studioAppDataStore');

// ── Viewer role resolution ──────────────────────────────────────────

/**
 * Resolve a viewer's role in an app:
 *   1. app owner            → 'owner' (always full access)
 *   2. explicit membership  → studio_app_members.role_key
 *   3. group mapping        → model.roleMapping.byGroup ∩ the viewer's groups
 *   4. default mapping      → model.roleMapping.default
 *   5. otherwise            → null (no data access)
 */
async function resolveViewerRole(app, viewerId, model, audience = {}) {
    if (!app || !viewerId) return null;
    if (app.userId === viewerId) return 'owner';

    try {
        const memberRole = await studioAppDataStore.getMemberRole(app.id, viewerId);
        if (memberRole) return memberRole;
    } catch { /* membership lookup failure → fall through to mapping */ }

    const roleMapping = (model && typeof model.roleMapping === 'object' && model.roleMapping) ? model.roleMapping : {};
    const byGroup = (roleMapping.byGroup && typeof roleMapping.byGroup === 'object') ? roleMapping.byGroup : {};
    const groups = Array.isArray(audience.userGroups) ? audience.userGroups
        : (Array.isArray(audience.groups) ? audience.groups : []);
    for (const g of groups) {
        if (typeof g === 'string' && Object.hasOwn(byGroup, g) && byGroup[g]) return byGroup[g];
    }
    if (typeof roleMapping.default === 'string' && roleMapping.default) return roleMapping.default;
    return null;
}

module.exports = { ...accessFilter, resolveViewerRole };
