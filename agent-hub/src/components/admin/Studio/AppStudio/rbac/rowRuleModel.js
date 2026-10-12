import { parseExpr } from '@shared/expr/engine.mjs';
import { validateRowFilterExpr } from './rowFilterSubset';

/**
 * App Studio RBAC — the picker model behind the row-rule builder.
 *
 * The server stores a row rule as ONE expression string (access.rowFilters[role])
 * and only accepts the bounded subset rowFilterSubset.js mirrors. This module is
 * the two-way bridge between that string and a list of pickable conditions:
 *
 *   parseRowRule(expr, table) → { ok, join, conditions }
 *   buildRowRule({ join, conditions }) → the expression string
 *
 * parseRowRule answers ok:false for anything the pickers cannot show EXACTLY —
 * mixed and/or, a comparison between two columns, a negation, a rule the server
 * would reject. The editor then keeps that rule as text instead of rewriting it;
 * a rule we do not understand is never regenerated from a partial reading.
 *
 * Round-tripping is byte-stable for everything the pickers produce, with two
 * deliberate normalisations on rules typed by hand: `===`/`!==` collapse to
 * `==`/`!=` (identical SQL), and `viewer.id == record.x` flips to put the column
 * first (comparison operators mirrored with it).
 *
 * It also owns the base-access presets (BASE_SCOPES / scopeToEntry /
 * resolveAccessEntry) and the sentence describing what a role ends up with, so
 * the words on screen and the permissions written to the model cannot drift.
 */

// Present on every table (dataModel SYSTEM_COLUMNS), so always pickable.
// org_id is stamped from the APP's organisation on every row (queryCompiler
// compileInsert), never from whoever added it — the name says so, otherwise a
// rule on it reads like a per-person check while it is the same for all rows.
const SYSTEM_FIELDS = [
    { key: 'created_by', name: 'Who added the row', nameKey: 'studio_apps_edit.row_rule.sys_created_by', type: 'text' },
    { key: 'created_at', name: 'When it was added', nameKey: 'studio_apps_edit.row_rule.sys_created_at', type: 'datetime' },
    { key: 'updated_at', name: 'When it was last changed', nameKey: 'studio_apps_edit.row_rule.sys_updated_at', type: 'datetime' },
    { key: 'org_id', name: 'Organisation the app belongs to', nameKey: 'studio_apps_edit.row_rule.sys_org_id', type: 'text' },
    { key: 'id', name: 'Row id', nameKey: 'studio_apps_edit.row_rule.sys_id', type: 'text' },
];

/**
 * Translate with `t` when the caller has one; otherwise the English default
 * (tests and non-React callers), interpolated the same way.
 */
const tr = (t, key, en, params) => (t
    ? t(key, en, params)
    : en.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m)));

/** The runtime values a rule may compare against, named the way a person says them. */
export const COMPARE_SOURCES = [
    { id: 'value', label: 'a value I type', labelKey: 'studio_apps_edit.row_rule.src_value' },
    { id: 'viewer.id', label: 'the person opening the app', labelKey: 'studio_apps_edit.row_rule.src_viewer_id' },
    { id: 'viewer.organizationId', label: 'their organisation', labelKey: 'studio_apps_edit.row_rule.src_viewer_org' },
    { id: 'viewer.role', label: 'their role', labelKey: 'studio_apps_edit.row_rule.src_viewer_role' },
];

const SOURCE_LABEL = new Map(COMPARE_SOURCES.map((s) => [s.id, s.label]));

/** A compare source's name, translated when `t` is given. */
export function compareSourceLabel(id, t = null) {
    const source = COMPARE_SOURCES.find((s) => s.id === id);
    return source ? tr(t, source.labelKey, source.label) : id;
}

/**
 * Base access presets. Each one hands out READING AND WRITING in one click, so
 * the label names the writing too — describeAccessOutcome then spells out the
 * exact same entry scopeToEntry writes.
 */
export const BASE_SCOPES = [
    { value: 'all', label: 'See, change and delete every row', labelKey: 'studio_apps_edit.row_rule.scope_all' },
    { value: 'own', label: 'Only the rows they added', labelKey: 'studio_apps_edit.row_rule.scope_own' },
    { value: 'none', label: 'No access', labelKey: 'studio_apps_edit.row_rule.scope_none' },
];

/** The access entry a base scope writes — read/add/edit/delete, all four. */
export function scopeToEntry(scope) {
    switch (scope) {
        case 'own': return { read: 'own', create: true, update: 'own', delete: 'own' };
        case 'none': return { read: 'none', create: false, update: 'none', delete: 'none' };
        case 'all':
        default: return { read: 'all', create: true, update: 'all', delete: 'all' };
    }
}

// ── The access a role already has ───────────────────────────────────

const ACCESS_MODES = ['app', 'owner', 'role', 'none'];
const ACTIONS = ['read', 'create', 'update', 'delete'];
const READ_WRITE_SCOPES = ['none', 'own', 'all'];

function normalizePerm(value, action) {
    if (action === 'create') return value === true || value === 'all' || value === 'own';
    if (READ_WRITE_SCOPES.includes(value)) return value;
    if (value === true) return 'all';
    if (value === false) return 'none';
    return 'none';
}

function defaultPerm(mode, action) {
    switch (mode) {
        case 'app': return action === 'create' ? true : 'all';
        case 'owner': return action === 'create' ? true : 'own';
        default: return action === 'create' ? false : 'none';
    }
}

/**
 * What a role may already do with a table, per action — the same resolution the
 * RLS gateway performs (an explicit access.roles[role][action] wins, otherwise
 * the table's access.default).
 *
 * The four actions are resolved SEPARATELY because they can differ: a role set
 * up elsewhere may read every row and change none. Collapsing that to the read
 * scope and saving a preset back would silently hand out editing and deleting.
 *
 * A model with no access.default at all is read as 'app' — the server fills it
 * in that way when it stores the model, and understating what a role has would
 * be the more dangerous mistake here.
 */
export function resolveAccessEntry(table, roleKey) {
    const access = (table && typeof table.access === 'object' && table.access) ? table.access : {};
    const roles = (access.roles && typeof access.roles === 'object') ? access.roles : {};
    const entry = (roleKey && Object.hasOwn(roles, roleKey) && roles[roleKey] && typeof roles[roleKey] === 'object')
        ? roles[roleKey]
        : null;
    const mode = ACCESS_MODES.includes(access.default) ? access.default : 'app';
    const out = {};
    for (const action of ACTIONS) {
        out[action] = (entry && Object.hasOwn(entry, action))
            ? normalizePerm(entry[action], action)
            : defaultPerm(mode, action);
    }
    return out;
}

/** Which preset an access entry IS, or null when it is a mix of its own. */
export function matchBaseScope(entry) {
    const found = BASE_SCOPES.find((s) => {
        const preset = scopeToEntry(s.value);
        return ACTIONS.every((a) => preset[a] === entry?.[a]);
    });
    return found ? found.value : null;
}

// ── Fields ──────────────────────────────────────────────────────────

/** Every column a rule may name, in picker order: the table's own, then the built-ins. */
export function ruleFields(table, t = null) {
    const own = (Array.isArray(table?.fields) ? table.fields : [])
        // Read-time computed fields have no stored column — the server rejects them.
        .filter((f) => f && typeof f.key === 'string'
            && !(f.type === 'computed' && !(f.computed && f.computed.stored === true)))
        .map((f) => ({ key: f.key, name: f.name || f.key, type: f.type, options: f.options }));
    const taken = new Set(own.map((f) => f.key));
    return [...own, ...SYSTEM_FIELDS.filter((f) => !taken.has(f.key)).map(({ nameKey, ...f }) => ({ ...f, name: tr(t, nameKey, f.name) }))];
}

export function findRuleField(table, key, t = null) {
    return ruleFields(table, t).find((f) => f.key === key) || null;
}

/** Which control the value side needs. */
export function valueKindOf(field) {
    switch (field?.type) {
        case 'bool': return 'yesno';
        case 'number': return 'number';
        case 'date': return 'date';
        case 'datetime': return 'datetime';
        case 'select': return 'choice';
        default: return 'text';
    }
}

// ── Operators ───────────────────────────────────────────────────────

const OPS_BY_KIND = {
    yesno: ['==', '!='],
    number: ['==', '!=', '>', '>=', '<', '<='],
    // No blank check on a date/number column: the subset spells it `== ""`, which
    // the database refuses to compare against a date.
    date: ['==', '!=', '>', '>=', '<', '<='],
    datetime: ['==', '!=', '>', '>=', '<', '<='],
    choice: ['==', '!=', 'empty', 'notEmpty'],
    text: ['==', '!=', 'empty', 'notEmpty'],
};

const OP_LABELS = {
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

const DATE_OP_LABELS = {
    '>': ['studio_apps_edit.row_rule.op_after', 'is after'],
    '>=': ['studio_apps_edit.row_rule.op_on_or_after', 'is on or after'],
    '<': ['studio_apps_edit.row_rule.op_before', 'is before'],
    '<=': ['studio_apps_edit.row_rule.op_on_or_before', 'is on or before'],
};

export function operatorLabel(op, kind, t = null) {
    const entry = ((kind === 'date' || kind === 'datetime') && DATE_OP_LABELS[op]) || OP_LABELS[op];
    return entry ? tr(t, entry[0], entry[1]) : op;
}

/**
 * The operator choices for a field. `keepOp` is always included so a rule that
 * was typed by hand (e.g. `>` on a text column) keeps its own operator in the
 * dropdown rather than snapping to another one.
 */
export function operatorsForField(field, keepOp = null, t = null) {
    const kind = valueKindOf(field);
    const ops = [...(OPS_BY_KIND[kind] || OPS_BY_KIND.text)];
    if (keepOp && !ops.includes(keepOp)) ops.push(keepOp);
    return ops.map((op) => ({ op, label: operatorLabel(op, kind, t) }));
}

// ── Conditions ──────────────────────────────────────────────────────

let conditionSeq = 0;
function nextId() { conditionSeq += 1; return `cond_${conditionSeq}`; }

export function blankCondition(table) {
    const first = ruleFields(table)[0];
    return {
        id: nextId(),
        field: first ? first.key : '',
        op: '==',
        source: 'value',
        value: '',
        valueType: first && valueKindOf(first) === 'number' ? 'number'
            : (first && valueKindOf(first) === 'yesno' ? 'bool' : 'string'),
    };
}

/** "Only rows they added themselves", as a condition instead of typed text. */
export function ownRowsCondition() {
    return { id: nextId(), field: 'created_by', op: '==', source: 'viewer.id', value: '', valueType: 'string' };
}

/** Re-type the value side after the field changed, keeping what still fits. */
export function retypeCondition(condition, field) {
    const kind = valueKindOf(field);
    const ops = (OPS_BY_KIND[kind] || OPS_BY_KIND.text);
    const op = ops.includes(condition.op) ? condition.op : '==';
    const valueType = kind === 'number' ? 'number' : (kind === 'yesno' ? 'bool' : 'string');
    let value = condition.value;
    if (valueType !== condition.valueType) value = valueType === 'bool' ? 'true' : '';
    if (kind === 'choice' && !(field.options || []).includes(value)) value = '';
    return { ...condition, field: field.key, op, valueType, value };
}

/**
 * Why this condition cannot be written yet, in words, or null when it is ready.
 * A rule with an unfinished condition is never saved half-applied.
 */
export function conditionProblem(condition, table, t = null) {
    if (!condition.field) return tr(t, 'studio_apps_edit.row_rule.problem_pick_column', 'Pick a column.');
    if (!findRuleField(table, condition.field)) return tr(t, 'studio_apps_edit.row_rule.problem_column_gone', 'This column is no longer in the table — pick another one.');
    if (condition.op === 'empty' || condition.op === 'notEmpty') return null;
    if (condition.source !== 'value') return null;
    if (condition.valueType === 'bool') return null;
    if (condition.valueType === 'number') {
        const n = Number(condition.value);
        if (condition.value === '' || !Number.isFinite(n)) return tr(t, 'studio_apps_edit.row_rule.problem_number', 'Type a number.');
        // A leading minus parses as arithmetic, which a row rule may not contain.
        if (n < 0) return tr(t, 'studio_apps_edit.row_rule.problem_negative', 'A row rule cannot use a negative number.');
        return null;
    }
    return String(condition.value ?? '') === '' ? tr(t, 'studio_apps_edit.row_rule.problem_value', 'Fill in the value.') : null;
}

function quote(s) {
    return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function serializeValue(condition) {
    if (condition.source && condition.source !== 'value') return condition.source;
    if (condition.valueType === 'bool') {
        return (condition.value === true || condition.value === 'true') ? 'true' : 'false';
    }
    if (condition.valueType === 'number') {
        const n = Number(condition.value);
        return (condition.value !== '' && Number.isFinite(n) && n >= 0) ? String(n) : null;
    }
    const s = String(condition.value ?? '');
    return s === '' ? null : quote(s);
}

export function serializeCondition(condition) {
    if (!condition || !condition.field) return null;
    const left = `record.${condition.field}`;
    if (condition.op === 'empty') return `${left} == ""`;
    if (condition.op === 'notEmpty') return `${left} != ""`;
    const right = serializeValue(condition);
    return right == null ? null : `${left} ${condition.op} ${right}`;
}

/** The conditions, joined, as the one expression string the server stores. */
export function buildRowRule({ join = 'and', conditions = [] } = {}) {
    const parts = conditions.map(serializeCondition).filter((p) => p != null);
    return parts.join(join === 'or' ? ' || ' : ' && ');
}

// ── Reading an existing rule back into pickers ──────────────────────

const CMP = new Set(['==', '!=', '>', '>=', '<', '<=']);
const CANON = { '===': '==', '!==': '!=' };
const MIRROR = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

const NOT_PICKABLE = { ok: false, join: 'and', conditions: [] };

function flattenLogic(node, ops, out) {
    if (node && node.kind === 'binop' && (node.op === '&&' || node.op === '||')) {
        ops.add(node.op);
        flattenLogic(node.a, ops, out);
        flattenLogic(node.b, ops, out);
        return;
    }
    out.push(node);
}

// A two-segment path → { root, leaf }, or null for anything else.
function readPath(node) {
    if (!node || node.kind !== 'path') return null;
    const segs = node.segments;
    if (!Array.isArray(segs) || segs.length !== 2) return null;
    if (segs[0].kind !== 'name' || segs[1].kind !== 'name') return null;
    return { root: segs[0].v, leaf: segs[1].v };
}

function readLiteral(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.kind === 'str') return { value: node.v, valueType: 'string' };
    if (node.kind === 'num') return { value: String(node.v), valueType: 'number' };
    if (node.kind === 'bool') return { value: node.v ? 'true' : 'false', valueType: 'bool' };
    return null;
}

function leafToCondition(node, table) {
    if (!node || node.kind !== 'binop') return null;
    const op = CANON[node.op] || node.op;
    if (!CMP.has(op)) return null;

    const leftPath = readPath(node.a);
    const rightPath = readPath(node.b);
    let column = null;
    let other = null;
    let effectiveOp = op;
    if (leftPath && leftPath.root === 'record') { column = leftPath.leaf; other = node.b; }
    else if (rightPath && rightPath.root === 'record') { column = rightPath.leaf; other = node.a; effectiveOp = MIRROR[op]; }
    if (!column || !effectiveOp) return null;
    if (!findRuleField(table, column)) return null;

    const otherPath = readPath(other);
    if (otherPath) {
        if (otherPath.root !== 'viewer') return null; // column-to-column has no picker
        const source = `viewer.${otherPath.leaf}`;
        if (!SOURCE_LABEL.has(source)) return null;
        return { id: nextId(), field: column, op: effectiveOp, source, value: '', valueType: 'string' };
    }

    const literal = readLiteral(other);
    if (!literal) return null;
    // `== ""` / `!= ""` is how the bounded subset spells empty — show it that way.
    if (literal.valueType === 'string' && literal.value === '' && (effectiveOp === '==' || effectiveOp === '!=')) {
        return { id: nextId(), field: column, op: effectiveOp === '==' ? 'empty' : 'notEmpty', source: 'value', value: '', valueType: 'string' };
    }
    return { id: nextId(), field: column, op: effectiveOp, source: 'value', value: literal.value, valueType: literal.valueType };
}

/**
 * Read an expression back into pickable conditions.
 * @returns {{ ok: boolean, join: 'and'|'or', conditions: object[] }} — ok:false
 *          means "keep this as text", never "throw it away".
 */
export function parseRowRule(expr, table) {
    const src = String(expr ?? '').trim();
    if (!src) return { ok: true, join: 'and', conditions: [] };
    if (!validateRowFilterExpr(src, table).ok) return NOT_PICKABLE;

    let ast;
    try { ast = parseExpr(src); } catch { return NOT_PICKABLE; }

    const ops = new Set();
    const leaves = [];
    flattenLogic(ast, ops, leaves);
    if (ops.size > 1) return NOT_PICKABLE; // mixed and/or needs brackets the pickers can't show

    const conditions = [];
    for (const leaf of leaves) {
        const condition = leafToCondition(leaf, table);
        if (!condition) return NOT_PICKABLE;
        conditions.push(condition);
    }
    return { ok: true, join: ops.has('||') ? 'or' : 'and', conditions };
}

// ── Plain-language summary ──────────────────────────────────────────

function describeValue(condition, t = null) {
    if (condition.source && condition.source !== 'value') return SOURCE_LABEL.has(condition.source) ? compareSourceLabel(condition.source, t) : condition.source;
    if (condition.valueType === 'bool') return (condition.value === true || condition.value === 'true') ? tr(t, 'studio_apps_edit.row_rule.yes', 'yes') : tr(t, 'studio_apps_edit.row_rule.no', 'no');
    if (condition.valueType === 'number') return String(condition.value);
    return `“${condition.value}”`;
}

export function describeCondition(condition, table, t = null) {
    const field = findRuleField(table, condition.field, t);
    const name = field ? field.name : condition.field;
    const kind = valueKindOf(field);
    const op = operatorLabel(condition.op, kind, t);
    if (condition.op === 'empty' || condition.op === 'notEmpty') return tr(t, 'studio_apps_edit.row_rule.cond_unary', '{name} {op}', { name, op });
    return tr(t, 'studio_apps_edit.row_rule.cond_binary', '{name} {op} {value}', { name, op, value: describeValue(condition, t) });
}

/** e.g. `Owner is the person opening the app and Status is “open”`. */
export function describeRowRule({ join = 'and', conditions = [] } = {}, table, t = null) {
    const usable = conditions.filter((c) => serializeCondition(c) != null);
    if (usable.length === 0) return '';
    return usable.map((c) => describeCondition(c, table, t)).reduce((acc, part) => (join === 'or'
        ? tr(t, 'studio_apps_edit.row_rule.rule_or', '{a} or {b}', { a: acc, b: part })
        : tr(t, 'studio_apps_edit.row_rule.rule_and', '{a} and {b}', { a: acc, b: part })));
}

/** True when any condition compares a never-filled-in column against empty. */
export function hasEmptyCheck({ conditions = [] } = {}) {
    return conditions.some((c) => c.op === 'empty' || c.op === 'notEmpty');
}

function joinAnd(parts, t) {
    if (parts.length <= 1) return parts[0] || '';
    return tr(t, 'studio_apps_edit.row_rule.list_and', '{head}, and {last}', { head: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
}

function joinOr(parts, t) {
    if (parts.length <= 1) return parts[0] || '';
    return tr(t, 'studio_apps_edit.row_rule.list_or', '{head} or {last}', { head: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
}

const rowsOf = (scope, t) => (scope === 'own'
    ? tr(t, 'studio_apps_edit.row_rule.rows_added', 'the rows they added')
    : tr(t, 'studio_apps_edit.row_rule.rows_visible', 'every row they can see'));

/** The adding, changing and deleting an access entry hands out, in one sentence. */
function describeWrites(entry, t) {
    const edits = entry.update !== 'none';
    const deletes = entry.delete !== 'none';

    const can = [];
    if (entry.create) can.push(tr(t, 'studio_apps_edit.row_rule.can_add', 'add new rows'));
    if (edits && deletes && entry.update === entry.delete) can.push(tr(t, 'studio_apps_edit.row_rule.can_change_delete', 'change or delete {rows}', { rows: rowsOf(entry.update, t) }));
    else {
        if (edits) can.push(tr(t, 'studio_apps_edit.row_rule.can_change', 'change {rows}', { rows: rowsOf(entry.update, t) }));
        if (deletes) can.push(tr(t, 'studio_apps_edit.row_rule.can_delete', 'delete {rows}', { rows: rowsOf(entry.delete, t) }));
    }

    const missing = [];
    if (!entry.create) missing.push(tr(t, 'studio_apps_edit.row_rule.verb_add', 'add'));
    if (!edits) missing.push(tr(t, 'studio_apps_edit.row_rule.verb_change', 'change'));
    if (!deletes) missing.push(tr(t, 'studio_apps_edit.row_rule.verb_delete', 'delete'));

    if (!can.length) return tr(t, 'studio_apps_edit.row_rule.writes_look_only', 'They cannot {missing} anything — they can only look.', { missing: joinOr(missing, t) });
    const allowed = joinAnd(can, t);
    return missing.length
        ? tr(t, 'studio_apps_edit.row_rule.writes_some', 'They can {allowed}, but cannot {missing} anything.', { allowed, missing: joinOr(missing, t) })
        : tr(t, 'studio_apps_edit.row_rule.writes_all', 'They can {allowed}.', { allowed });
}

// Adding is gated on its own, so a role that sees nothing can still be allowed
// to add rows it will never be able to open again.
function describeNoRows(entry, roleLabel, tableName, t) {
    if (entry.create) {
        return {
            sees: tr(t, 'studio_apps_edit.row_rule.none_can_add', '{role} sees no rows in {table} at all. A row rule changes nothing here.', { role: roleLabel, table: tableName }),
            writes: tr(t, 'studio_apps_edit.row_rule.none_writes', 'They can still add new rows, but never see them afterwards.'),
        };
    }
    return {
        sees: tr(t, 'studio_apps_edit.row_rule.none_cannot_add', '{role} sees no rows in {table} at all, and cannot add any. A row rule changes nothing here.', { role: roleLabel, table: tableName }),
        writes: null,
    };
}

/**
 * Who ends up seeing what, spelled out. The role's read access decides the rows
 * and the rule narrows them (the gateway ANDs the two), while the SAME entry
 * carries adding, changing and deleting — so those are named here instead of
 * hiding behind a read-sounding label.
 *
 * `entry` is what will actually be saved (resolveAccessEntry / scopeToEntry),
 * never a preset assumed from the read scope. `ruleSummary` is describeRowRule's
 * words, or '' when the rule is hand-written text this module cannot read back
 * into pickers.
 *
 * @returns {{ sees: string, writes: string|null, owner: string }}
 */
export function describeAccessOutcome({
    entry = null,
    t = null,
    roleLabel = tr(t, 'studio_apps_edit.row_rule.default_role', 'This role'),
    tableName = tr(t, 'studio_apps_edit.row_rule.default_table', 'this table'),
    hasRule = false,
    ruleSummary = '',
} = {}) {
    const grant = entry || scopeToEntry('all');
    const owner = tr(t, 'studio_apps_edit.row_rule.owner_note', 'You own this app, so you always see and change every row yourself — a row rule never applies to you.');
    const who = { role: roleLabel, table: tableName };

    if (grant.read === 'none') return { ...describeNoRows(grant, roleLabel, tableName, t), owner };

    if (grant.read === 'own') {
        let sees;
        if (!hasRule) sees = tr(t, 'studio_apps_edit.row_rule.own_plain', '{role} sees only the rows in {table} they added themselves.', who);
        else if (ruleSummary) sees = tr(t, 'studio_apps_edit.row_rule.own_where', '{role} sees only the rows in {table} they added themselves, and only where {summary}.', { ...who, summary: ruleSummary });
        else sees = tr(t, 'studio_apps_edit.row_rule.own_rule', '{role} sees only the rows in {table} they added themselves, and only the ones matching the rule written below.', who);
        return { sees, writes: describeWrites(grant, t), owner };
    }
    let sees = tr(t, 'studio_apps_edit.row_rule.all_plain', '{role} sees every row in {table}.', who);
    if (hasRule) {
        sees = ruleSummary
            ? tr(t, 'studio_apps_edit.row_rule.all_where', '{role} sees only the rows in {table} where {summary}.', { ...who, summary: ruleSummary })
            : tr(t, 'studio_apps_edit.row_rule.all_rule', '{role} sees only the rows in {table} matching the rule written below.', who);
    }
    return { sees, writes: describeWrites(grant, t), owner };
}
