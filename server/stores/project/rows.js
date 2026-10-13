// @typecheck
/**
 * stores/project/rows.js — the project row as the API speaks it, the kind
 * vocabulary, the permission vocabulary and the "no sharing schema" SQLSTATEs.
 * Split out of stores/projectStore.js.
 */

const { parseJSONObject: parseJSON } = require('../lib/json');

/** The two kinds a project can be. NULL (legacy) is the absence of one. */
const PROJECT_KINDS = Object.freeze(['workspace', 'solution']);


/**
 * The kind a new project is created as. Omitted means 'workspace': the
 * collaborative project is what "a project" is; a Solution says so.
 * @param {unknown} kind
 * @returns {'workspace'|'solution'}
 */
function kindForNewProject(kind) {
    if (kind === undefined || kind === null) return 'workspace';
    if (kind === 'workspace' || kind === 'solution') return kind;
    throw new TypeError(`A project kind is 'workspace' or 'solution', not ${JSON.stringify(kind)}.`);
}

/** A stored kind as the API speaks it: one of the two, or null (legacy). */
function kindOf(row) {
    return row && (row.kind === 'workspace' || row.kind === 'solution') ? row.kind : null;
}

/** A projects row as the API speaks it (getProject, and each listUserProjects row). */
function mapProjectRow(row) {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        customInstructions: row.custom_instructions,
        knowledgeBaseIds: parseJSON(row.knowledge_base_ids, []),
        color: row.color,
        icon: row.icon,
        ownerId: row.owner_id,
        organizationId: row.organization_id,
        extractMemories: row.extract_memories,
        // May editors invite people (viewer or editor)? The owner always may.
        editorsCanInvite: row.editors_can_invite !== false,
        // Set while the project is archived (read-only for everyone but the owner's restore/delete).
        archivedAt: row.archived_at || null,
        archivedBy: row.archived_by || null,
        version: row.version,
        // 'workspace' | 'solution', or null for a legacy row nobody has
        // classified yet.
        kind: kindOf(row),
        // True while the kind is the backfill's guess, which the owner may
        // still correct once (setProjectKind).
        kindGuessed: row.kind_guessed === true,
        filesKbId: row.files_kb_id || null,
        // Which Blueprint this Solution was installed from, if any. The
        // overview's "Installed" tab is this column being non-null; `null` is
        // "built here", and stays distinguishable from "the Blueprint is gone".
        installedFromBlueprintId: row.installed_from_blueprint_id || null,
        // The organisation the file or gallery row NAMES as its source; never a
        // ground for access (see the ladder above).
        installedFromOrgId: row.installed_from_org_id || null,
        installedVersion: Number.isInteger(row.installed_version) ? row.installed_version : null,
        // 'uat' | 'prd' on a Solution stage, with the Dev project it is a stage
        // of; null on every other project.
        stage: row.stage === 'uat' || row.stage === 'prd' ? row.stage : null,
        stageOf: row.stage_of || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// Translate legacy permission vocabulary so external callers don't break.
function normalizePermission(permission) {
    if (permission === 'view') return 'viewer';
    if (permission === 'edit') return 'editor';
    if (permission === 'viewer' || permission === 'editor') return permission;
    return 'viewer';
}


// SQLSTATEs that mean "this installation has no shared conversations at all":
// the agent schema was never created here, or predates sharing.
const NO_SHARING_SCHEMA = new Set(['42P01', '42703']);

module.exports = { PROJECT_KINDS, kindForNewProject, kindOf, mapProjectRow, normalizePermission, NO_SHARING_SCHEMA };
