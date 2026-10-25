import type { AccessPerm, ParsedRowRule } from './rowRuleModel.types';

// Present on every table (dataModel SYSTEM_COLUMNS), so always pickable.
// org_id is stamped from the APP's organisation on every row (queryCompiler
// compileInsert), never from whoever added it — the name says so, otherwise a
// rule on it reads like a per-person check while it is the same for all rows.
export const SYSTEM_FIELDS: Array<{ key: string; name: string; nameKey: string; type: string }> = [
    { key: 'created_by', name: 'Who added the row', nameKey: 'studio_apps_edit.row_rule.sys_created_by', type: 'text' },
    { key: 'created_at', name: 'When it was added', nameKey: 'studio_apps_edit.row_rule.sys_created_at', type: 'datetime' },
    { key: 'updated_at', name: 'When it was last changed', nameKey: 'studio_apps_edit.row_rule.sys_updated_at', type: 'datetime' },
    { key: 'org_id', name: 'Organisation the app belongs to', nameKey: 'studio_apps_edit.row_rule.sys_org_id', type: 'text' },
    { key: 'id', name: 'Row id', nameKey: 'studio_apps_edit.row_rule.sys_id', type: 'text' },
];

/** The runtime values a rule may compare against, named the way a person says them. */
export const COMPARE_SOURCES: Array<{ id: string; label: string; labelKey: string }> = [
    { id: 'value', label: 'a value I type', labelKey: 'studio_apps_edit.row_rule.src_value' },
    { id: 'viewer.id', label: 'the person opening the app', labelKey: 'studio_apps_edit.row_rule.src_viewer_id' },
    { id: 'viewer.organizationId', label: 'their organisation', labelKey: 'studio_apps_edit.row_rule.src_viewer_org' },
    { id: 'viewer.role', label: 'their role', labelKey: 'studio_apps_edit.row_rule.src_viewer_role' },
];

export const SOURCE_LABEL = new Map(COMPARE_SOURCES.map((s): [string, string] => [s.id, s.label]));

/**
 * Base access presets. Each one hands out READING AND WRITING in one click, so
 * the label names the writing too — describeAccessOutcome then spells out the
 * exact same entry scopeToEntry writes.
 */
export const BASE_SCOPES: Array<{ value: string; label: string; labelKey: string }> = [
    { value: 'all', label: 'See, change and delete every row', labelKey: 'studio_apps_edit.row_rule.scope_all' },
    { value: 'own', label: 'Only the rows they added', labelKey: 'studio_apps_edit.row_rule.scope_own' },
    { value: 'none', label: 'No access', labelKey: 'studio_apps_edit.row_rule.scope_none' },
];

export const ACCESS_MODES: Array<string | undefined> = ['app', 'owner', 'role', 'none'];

export const ACTIONS = ['read', 'create', 'update', 'delete'];

export const READ_WRITE_SCOPES: AccessPerm[] = ['none', 'own', 'all'];

export const OPS_BY_KIND: Record<string, string[]> = {
    yesno: ['==', '!='],
    number: ['==', '!=', '>', '>=', '<', '<='],
    // No blank check on a date/number column: the subset spells it `== ""`, which
    // the database refuses to compare against a date.
    date: ['==', '!=', '>', '>=', '<', '<='],
    datetime: ['==', '!=', '>', '>=', '<', '<='],
    choice: ['==', '!=', 'empty', 'notEmpty'],
    text: ['==', '!=', 'empty', 'notEmpty'],
};

export const OP_LABELS: Record<string, [string, string]> = {
    '==': ['studio_apps_edit.row_rule.op_eq', 'is'],
    '!=': ['studio_apps_edit.row_rule.op_ne', 'is not'],
    '>': ['studio_apps_edit.row_rule.op_gt', 'is more than'],
    '>=': ['studio_apps_edit.row_rule.op_ge', 'is at least'],
    '<': ['studio_apps_edit.row_rule.op_lt', 'is less than'],
    '<=': ['studio_apps_edit.row_rule.op_le', 'is at most'],
    // `== ""` is the only emptiness the subset can spell: a column nobody ever
    // filled in is NULL, and NULL compares to nothing here. "blank", not "empty".
    empty: ['studio_apps_edit.row_rule.op_blank', 'is blank'],
    notEmpty: ['studio_apps_edit.row_rule.op_not_blank', 'is not blank'],
};

export const DATE_OP_LABELS: Record<string, [string, string]> = {
    '>': ['studio_apps_edit.row_rule.op_after', 'is after'],
    '>=': ['studio_apps_edit.row_rule.op_on_or_after', 'is on or after'],
    '<': ['studio_apps_edit.row_rule.op_before', 'is before'],
    '<=': ['studio_apps_edit.row_rule.op_on_or_before', 'is on or before'],
};

export const CMP = new Set(['==', '!=', '>', '>=', '<', '<=']);

export const CANON: Record<string, string> = { '===': '==', '!==': '!=' };

export const MIRROR: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

export const NOT_PICKABLE: ParsedRowRule = { ok: false, join: 'and', conditions: [] };
