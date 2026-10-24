// @typecheck
const { KEY_RE: DATA_KEY_RE } = require('../dataModel');
const { adoptCanonical } = require('./shared');
const { pickClosestId, currentDataModel, tableIdHint, persistDataModel, dataModelPersistError } = require('./dataToolsShared');

const MAX_ROLES = 20;

/**
 * Everywhere the definition still references a table id: node props carrying
 * record/records bindings or a relation input's tableId, and action/step
 * fields. Used by app_remove_table's refusal (teach, don't destroy).
 */
function findTableRefs(def, tableId) {
    const refs = new Set();
    const scan = (value, where) => {
        if (!value || typeof value !== 'object') return;
        if (!Array.isArray(value) && value.tableId === tableId) { refs.add(where); return; }
        for (const v of Object.values(value)) scan(v, where);
    };
    const walkNode = (node) => {
        scan(node.props, `component ${node.id}`);
        for (const c of node.children || []) walkNode(c);
    };
    for (const s of def.screens || []) {
        for (const sec of s.sections || []) {
            for (const n of sec.children || []) walkNode(n);
        }
    }
    for (const [id, action] of Object.entries(def.actions || {})) scan(action, `action ${id}`);
    return [...refs];
}

async function applyRemoveTable(draftWrap, args) {
    const model = currentDataModel(draftWrap);
    const tableId = typeof args?.tableId === 'string' ? args.tableId : null;
    const table = tableId ? (model.tables || []).find((t) => t.id === tableId) : null;
    if (!table) {
        const suggestion = pickClosestId(tableId, (model.tables || []).map((t) => t.id));
        return { error: `Unknown tableId ${JSON.stringify(tableId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: tableIdHint(model) };
    }
    const refs = findTableRefs(draftWrap.def, tableId);
    if (refs.length) {
        return {
            error: `Cannot remove ${tableId} ("${table.name}") — the definition still references it: ${refs.slice(0, 8).join(', ')}${refs.length > 8 ? ` and ${refs.length - 8} more` : ''}.`,
            _fixHint: 'Re-bind or remove those components/steps first, then remove the table.',
        };
    }
    const rowCount = (draftWrap.rowCounts && draftWrap.rowCounts[tableId]) || 0;
    const op = (m) => ({ ...m, tables: (Array.isArray(m.tables) ? m.tables : []).filter((t) => t.id !== tableId) });
    const persisted = await persistDataModel(draftWrap, op(model), { rebase: op });
    const failed = dataModelPersistError(persisted);
    if (failed) return failed;
    return {
        removed: tableId,
        modelVersion: draftWrap.dataModelVersion,
        ...(rowCount ? { note: `The table and its ${rowCount} row(s) were deleted.` } : {}),
    };
}

async function applySetRoles(draftWrap, args) {
    const rawRoles = Array.isArray(args?.roles) ? args.roles : null;
    if (!rawRoles || !rawRoles.length) return { error: 'roles must be a non-empty array of { key, label }.' };
    if (rawRoles.length > MAX_ROLES) return { error: `roles: max ${MAX_ROLES} roles.` };
    const seen = new Set();
    const roles = [];
    for (const [i, r] of rawRoles.entries()) {
        if (!r || typeof r !== 'object' || typeof r.key !== 'string' || !DATA_KEY_RE.test(r.key)) {
            return { error: `roles[${i}].key must be lowercase snake_case starting with a letter (e.g. "manager").` };
        }
        if (seen.has(r.key)) return { error: `roles[${i}].key "${r.key}" is duplicated.` };
        seen.add(r.key);
        roles.push({ key: r.key, label: (typeof r.label === 'string' && r.label) ? r.label : r.key });
    }

    const model = currentDataModel(draftWrap);
    let roleMapping = (model.roleMapping && typeof model.roleMapping === 'object')
        ? model.roleMapping : { default: 'app', byGroup: {} };
    if (args?.roleMapping !== undefined) {
        const rm = args.roleMapping;
        if (!rm || typeof rm !== 'object' || Array.isArray(rm)) {
            return { error: 'roleMapping must be an object { default?, byGroup? }.' };
        }
        const nextDefault = rm.default !== undefined ? rm.default : roleMapping.default;
        // '' is the explicit "no access" default — rlsGateway.resolveViewerRole
        // reads a blank default as "no role, so no data", and the editor's role
        // manager persists exactly that. Rejecting it here would make every
        // set_roles call fail on an app the owner deliberately locked down.
        if (typeof nextDefault !== 'string' || (nextDefault !== 'app' && nextDefault !== '' && !seen.has(nextDefault))) {
            return { error: `roleMapping.default ${JSON.stringify(rm.default)} must be one of the role keys (${roles.map((x) => x.key).join(', ')}), "app", or "" for no access.` };
        }
        const byGroup = (rm.byGroup && typeof rm.byGroup === 'object' && !Array.isArray(rm.byGroup)) ? rm.byGroup : roleMapping.byGroup || {};
        for (const [group, roleKey] of Object.entries(byGroup)) {
            if (!seen.has(roleKey)) {
                return { error: `roleMapping.byGroup[${JSON.stringify(group)}] = ${JSON.stringify(roleKey)} is not a defined role key.` };
            }
        }
        roleMapping = { default: nextDefault, byGroup };
    }

    // Whether the app may read the organisation's member list — the switch that
    // makes `input_person` and the reserved `sys_org_members` dataset work. It
    // lives with roles because it answers the same question: who this app can
    // see. Absent means unchanged, so a set_roles call that says nothing about
    // it cannot silently turn it on OR off.
    let directory = model.directory;
    if (args?.orgDirectory !== undefined) {
        if (typeof args.orgDirectory !== 'boolean') {
            return { error: 'orgDirectory must be true or false.' };
        }
        directory = { orgMembers: args.orgDirectory };
    }

    const op = (m) => ({ ...m, roles, roleMapping, ...(directory ? { directory } : {}) });
    const persisted = await persistDataModel(draftWrap, op(model), { rebase: op });
    const failed = dataModelPersistError(persisted);
    if (failed) return failed;

    // Mirror into definition.roles ([{id,name}] — drives visibleToRoles) so
    // both stores stay lockstep. The route persists the definition right after
    // (this tool is in MUTATING_TOOLS).
    const next = { ...draftWrap.def, roles: roles.map((r) => ({ id: r.key, name: r.label })) };
    return adoptCanonical(draftWrap, next, {
        roles: roles.map((r) => r.key),
        roleMapping,
        orgDirectory: directory?.orgMembers === true,
        modelVersion: draftWrap.dataModelVersion,
    });
}

module.exports = { findTableRefs, applyRemoveTable, applySetRoles };
