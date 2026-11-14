// @typecheck strict
/**
 * The deterministic half of the access assistant (accessPlan.js explains the
 * feature): the model's answer, in names, resolved against the real directory
 * and the app's own roles. Every name it cannot resolve goes into
 * `unresolved`, in the order the answer used it, so the person sees "I could
 * not find this" rather than a silent no-op. A role's row scope becomes a
 * rule built here (renderRule), never one the model wrote.
 */

'use strict';

// A role per value of a column is a legitimate ask ("one per supplier"), so the
// cap is the number of values a person can still read on a screen — not the 8
// that fitted when a role was always hand-named. `PUT /:id/schema` has no role
// cap of its own; the 20 on `def.roles` and on the builder's `set_roles` tool
// is a different list (the app's UI roles) and is not touched here.
const MAX_ROLES = 40;
const MAX_ENTRIES = 25;
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Roles the platform always understands, whatever the app's model says. */
const BUILTIN_ROLES = Object.freeze(['app', 'member', 'public']);

/**
 * @typedef {{ tableName?: string | null, columns?: Array<{ key: string, name?: string, truncated?: boolean,
 *   values?: Array<{ value: unknown, count?: number }> }> }} DataDigest
 * @typedef {{ key: string, label?: string }} AppRole
 * @typedef {{ id: string, name: string }} DirectoryGroup
 * @typedef {{ id: string, name?: string, email?: string }} DirectoryPerson
 * @typedef {(rule: string) => ({ ok?: boolean } | null | undefined)} RuleValidator
 * @typedef {{ audience?: { kind?: string, groups?: unknown[] }, roles?: Array<{ key?: unknown, label?: unknown, scope?: { column?: unknown, value?: unknown } } | null>,
 *   defaultRole?: unknown, groupRoles?: Array<{ group?: unknown, role?: unknown } | null>,
 *   people?: Array<{ person?: unknown, role?: unknown } | null>, note?: unknown }} ProposedAccess
 *   The `propose_access` tool's arguments, as the model sent them (parsed JSON, so every leaf is unchecked).
 * @typedef {{ kind: string, name: string, what?: string }} Unresolved
 * @typedef {{ key: string, label: string, scope?: { column: string, value: string } }} NewRole
 * @typedef {{ tableId: string, roleKey: string, expr: string }} TableRule
 * @typedef {{ kind: string; groupIds: string[]; groupNames: string[]; } | { kind: string | undefined; } | null} Audience
 * @typedef {(v: unknown, what: string) => string | null} RoleOf
 */

const str = /** @param {unknown} v @param {number} [n] */ (v, n = 80) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const fold = /** @param {unknown} v */ (v) => str(v, 120).toLowerCase().replace(/\s+/g, ' ');

/**
 * A group by name, then by a forgiving match; null when the directory has no such group.
 * @param {DirectoryGroup[]} groups
 * @param {unknown} name
 */
function findGroup(groups, name) {
    const want = fold(name);
    if (!want) return null;
    return groups.find((g) => fold(g.name) === want)
        || groups.find((g) => fold(g.name).includes(want) || want.includes(fold(g.name)))
        || null;
}

/**
 * A person by e-mail first (exact), then by name.
 * @param {DirectoryPerson[]} people
 * @param {unknown} name
 */
function findPerson(people, name) {
    const want = fold(name);
    if (!want) return null;
    return people.find((u) => fold(u.email) === want)
        || people.find((u) => fold(u.name) === want)
        || people.find((u) => fold(u.name).startsWith(`${want} `) || fold(u.name) === want)
        || null;
}

/**
 * A `{column, value}` pair as a row rule the RLS gateway accepts.
 *
 * The expression grammar is tiny on purpose (core/dataEngine/accessFilter.js):
 * `record.<field> == <literal>`. Building it here rather than letting the model
 * write it means there is no syntax to get wrong and nothing to inject — the
 * value goes in as a JSON string literal and is BOUND as a parameter when the
 * filter is compiled.
 * @param {unknown} column
 * @param {unknown} value
 */
function renderRule(column, value) {
    const col = str(column, 63);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(col)) return null;
    if (typeof value !== 'string' || !value.trim()) return null;
    return `record.${col} == ${JSON.stringify(value.slice(0, 200))}`;
}

/**
 * Per digest column, the values that actually occur (as text).
 * @param {DataDigest | null} digest
 */
const digestColumnsOf = (digest) => new Map(((digest && digest.columns) || []).map((c) => [c.key, new Set((c.values || []).map((v) => String(v.value)))]));

/**
 * The rule a role's scope stands for, or null with the reason in `unresolved`.
 * A column or a value the data does not have is a hallucination, and a role
 * scoped to nothing would show its holder an empty app without ever saying why.
 * @param {{ column?: unknown, value?: unknown }} scope
 * @param {string} key
 * @param {{ digestColumns: Map<string, Set<string>>, validateRule: RuleValidator | null, unresolved: Unresolved[] }} ctx
 * @returns {string | null}
 */
function scopeRule(scope, key, { digestColumns, validateRule, unresolved }) {
    const column = str(scope.column, 63);
    const value = str(scope.value, 200);
    const known = digestColumns.get(column);
    if (!known) { unresolved.push({ kind: 'column', name: column, what: key }); return null; }
    if (!known.has(value)) { unresolved.push({ kind: 'value', name: value, what: column }); return null; }
    let rule = renderRule(column, value);
    if (rule && typeof validateRule === 'function') {
        const verdict = validateRule(rule);
        if (verdict && verdict.ok === false) { unresolved.push({ kind: 'rule', name: `${column} = ${value}`, what: key }); rule = null; }
    }
    if (!rule && !unresolved.some((u) => u.kind === 'rule' && u.what === key)) unresolved.push({ kind: 'rule', name: `${column} = ${value}`, what: key });
    return rule;
}

/**
 * A well-formed key that is not the app's, not a built-in and not added already.
 * @param {string} key
 * @param {Map<string, AppRole>} existing
 * @param {NewRole[]} newRoles
 */
// nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- ROLE_KEY_RE is anchored, one class with a bounded count (at most 31), no nesting: linear
const isNewRoleKey = (key, existing, newRoles) => ROLE_KEY_RE.test(key) && !existing.has(key) && !BUILTIN_ROLES.includes(key)
    && !newRoles.some((x) => x.key === key);

/**
 * A proposed role's cleaned-up key (snake_case ASCII), its label (the key
 * when it has none) and its scope, when it has one.
 * @param {NonNullable<ProposedAccess['roles']>[number]} r
 */
const readRole = (r) => {
    const key = str(r && r.key, 32).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    return { key, label: str(r && r.label, 60) || key, scope: r && r.scope && typeof r.scope === 'object' ? r.scope : null };
};

/**
 * The roles the answer adds (a clean key the app and the platform do not
 * have yet, once each, up to the cap) and the table rules of the scoped ones.
 * A role whose whole point was the scope is not created without it.
 * @param {ProposedAccess} d
 * @param {{ existing: Map<string, AppRole>, digestColumns: Map<string, Set<string>>, validateRule: RuleValidator | null,
 *   tableId: string | null, unresolved: Unresolved[] }} ctx
 */
function newRolesFrom(d, ctx) {
    /** @type {NewRole[]} */
    const newRoles = [];
    /** @type {TableRule[]} */
    const tableRules = [];
    for (const r of (Array.isArray(d.roles) ? d.roles : []).slice(0, MAX_ROLES)) {
        const { key, label, scope } = readRole(r);
        if (!isNewRoleKey(key, ctx.existing, newRoles)) continue;
        const rule = scope ? scopeRule(scope, key, ctx) : null;
        if (scope && !rule) continue;
        newRoles.push({ key, label, ...(scope && rule ? { scope: { column: str(scope.column, 63), value: str(scope.value, 200) } } : {}) });
        if (rule && ctx.tableId) tableRules.push({ tableId: ctx.tableId, roleKey: key, expr: rule });
    }
    return { newRoles, tableRules };
}

/**
 * A role key the plan may use (the app's, a new one, a built-in), or null
 * with the name in `unresolved`.
 * @param {Set<string>} known
 * @param {Unresolved[]} unresolved
 * @returns {RoleOf}
 */
const makeRoleOf = (known, unresolved) => (v, what) => {
    const key = str(v, 32).toLowerCase();
    if (known.has(key)) return key;
    unresolved.push({ kind: 'role', name: str(v, 60), what });
    return null;
};

/**
 * Group id to role key, for the groups the answer names.
 * @param {ProposedAccess} d
 * @param {DirectoryGroup[]} groups
 * @param {RoleOf} roleOf
 * @param {Unresolved[]} unresolved
 */
function groupRolesFrom(d, groups, roleOf, unresolved) {
    /** @type {Record<string, string>} */
    const byGroup = {};
    for (const entry of (Array.isArray(d.groupRoles) ? d.groupRoles : []).slice(0, MAX_ENTRIES)) {
        const g = findGroup(groups, entry && entry.group);
        const role = roleOf(entry && entry.role, str(entry && entry.group, 60));
        if (!g) { unresolved.push({ kind: 'group', name: str(entry && entry.group, 60) }); continue; }
        if (role) byGroup[g.id] = role;
    }
    return byGroup;
}

/**
 * The people the answer names, each once, with their role.
 * @param {ProposedAccess} d
 * @param {DirectoryPerson[]} people
 * @param {RoleOf} roleOf
 * @param {Unresolved[]} unresolved
 */
function membersFrom(d, people, roleOf, unresolved) {
    /** @type {Array<{ userId: string, roleKey: string, name: string }>} */
    const members = [];
    for (const entry of (Array.isArray(d.people) ? d.people : []).slice(0, MAX_ENTRIES)) {
        const u = findPerson(people, entry && entry.person);
        const role = roleOf(entry && entry.role, str(entry && entry.person, 60));
        if (!u) { unresolved.push({ kind: 'person', name: str(entry && entry.person, 60) }); continue; }
        if (role && !members.some((m) => m.userId === u.id)) members.push({ userId: u.id, roleKey: role, name: /** @type {string} */ (u.name || u.email) });
    }
    return members;
}

/**
 * Who can open the app: unchanged (null), private, organisation, or the named
 * groups that exist (null when none does).
 * @param {ProposedAccess} d
 * @param {DirectoryGroup[]} groups
 * @param {Unresolved[]} unresolved
 * @returns {Audience}
 */
function audienceFrom(d, groups, unresolved) {
    const rawAudience = d.audience && typeof d.audience === 'object' ? d.audience : { kind: 'unchanged' };
    if (!['private', 'organisation', 'groups'].includes(/** @type {string} */ (rawAudience.kind))) return null;
    if (rawAudience.kind !== 'groups') return { kind: rawAudience.kind };
    /** @type {string[]} */
    const ids = [];
    /** @type {string[]} */
    const names = [];
    for (const name of (Array.isArray(rawAudience.groups) ? rawAudience.groups : []).slice(0, MAX_ENTRIES)) {
        const g = findGroup(groups, name);
        if (!g) { unresolved.push({ kind: 'group', name: str(name, 60) }); continue; }
        if (!ids.includes(g.id)) { ids.push(g.id); names.push(g.name); }
    }
    return ids.length ? { kind: 'groups', groupIds: ids, groupNames: names } : null;
}

/**
 * The model's answer, resolved against the directory and the app's own roles.
 * Returns what the client may apply, what it could not resolve, and the list a
 * person reads before pressing Approve.
 * @param {ProposedAccess | null} raw
 * @param {{ roles?: AppRole[], groups?: DirectoryGroup[], people?: DirectoryPerson[], digest?: DataDigest | null, tableId?: string | null, validateRule?: RuleValidator | null }} [ctx]
 */
function resolveNames(raw, { roles = [], groups = [], people = [], digest = null, tableId = null, validateRule = null } = {}) {
    /** @type {ProposedAccess} */
    const d = raw && typeof raw === 'object' ? raw : {};
    const existing = new Map(roles.filter((r) => r && r.key).map((r) => [r.key, r]));
    /** @type {Unresolved[]} */
    const unresolved = [];

    const { newRoles, tableRules } = newRolesFrom(d, { existing, digestColumns: digestColumnsOf(digest), validateRule, tableId, unresolved });
    const roleOf = makeRoleOf(new Set([...existing.keys(), ...newRoles.map((r) => r.key), ...BUILTIN_ROLES]), unresolved);
    const byGroup = groupRolesFrom(d, groups, roleOf, unresolved);
    const members = membersFrom(d, people, roleOf, unresolved);
    const audience = audienceFrom(d, groups, unresolved);
    const defaultRole = d.defaultRole ? roleOf(d.defaultRole, 'default') : null;

    return {
        note: str(d.note, 240),
        audience,
        roles: newRoles,
        tableRules,
        defaultRole,
        byGroup,
        byGroupNames: groupNamesOf(byGroup, groups),
        members,
        unresolved,
        empty: isEmptyPlan({ audience, newRoles, tableRules, defaultRole, byGroup, members }),
    };
}

/**
 * A plan that changes nothing.
 * @param {{ audience: Audience, newRoles: unknown[], tableRules: unknown[], defaultRole: string | null,
 *   byGroup: Record<string, string>, members: unknown[] }} plan
 */
const isEmptyPlan = ({ audience, newRoles, tableRules, defaultRole, byGroup, members }) => !audience && !newRoles.length && !tableRules.length
    && !defaultRole && !Object.keys(byGroup).length && !members.length;

/**
 * The group roles keyed by group name, for the list the person reads.
 * @param {Record<string, string>} byGroup
 * @param {DirectoryGroup[]} groups
 */
const groupNamesOf = (byGroup, groups) => Object.fromEntries(Object.entries(byGroup)
    .map(([id, role]) => [(groups.find((g) => g.id === id) || { name: undefined }).name || id, role]));

module.exports = { resolveNames, renderRule, MAX_ROLES, ROLE_KEY_RE, BUILTIN_ROLES };
