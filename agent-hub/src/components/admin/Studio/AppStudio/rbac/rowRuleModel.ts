import { parseExpr } from '@shared/expr/engine.mjs';
import { validateRowFilterExpr } from './rowFilterSubset';
import type { ExprNode } from './rowFilterSubset';
import type { AccessEntry, AccessOutcomeArgs, ParsedRowRule, RowRule, RuleCondition, RuleField, RuleTable } from './rowRuleModel.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import { SYSTEM_FIELDS, COMPARE_SOURCES, SOURCE_LABEL, BASE_SCOPES, ACCESS_MODES, ACTIONS, OPS_BY_KIND, OP_LABELS, DATE_OP_LABELS, CMP, CANON, MIRROR, NOT_PICKABLE } from './rowRuleModel.constants';
import { tr, normalizePerm, defaultPerm, serializeValue, flattenLogic, readPath, readLiteral, describeWrites, describeNoRows } from './rowRuleModel.helpers';
;

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

/** A compare source's name, translated when `t` is given. */
export function compareSourceLabel(id: string, t: TranslateFn | null = null) {
    const source = COMPARE_SOURCES.find((s) => s.id === id);
    return source ? tr(t, source.labelKey, source.label) : id;
}

/** The access entry a base scope writes — read/add/edit/delete, all four. */
export function scopeToEntry(scope: string): AccessEntry {
    switch (scope) {
        case 'own': return { read: 'own', create: true, update: 'own', delete: 'own' };
        case 'none': return { read: 'none', create: false, update: 'none', delete: 'none' };
        case 'all':
        default: return { read: 'all', create: true, update: 'all', delete: 'all' };
    }
}

// ── The access a role already has ───────────────────────────────────

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
export function resolveAccessEntry(table: RuleTable | null | undefined, roleKey?: string | null): AccessEntry {
    const access: NonNullable<RuleTable['access']> = (table && typeof table.access === 'object' && table.access) ? table.access : {};
    const roles = (access.roles && typeof access.roles === 'object') ? access.roles : {};
    const entry = (roleKey && Object.hasOwn(roles, roleKey) && roles[roleKey] && typeof roles[roleKey] === 'object')
        ? roles[roleKey]
        : null;
    const mode = ACCESS_MODES.includes(access.default) ? access.default : 'app';
    const out: AccessEntry = {};
    for (const action of ACTIONS) {
        out[action] = (entry && Object.hasOwn(entry, action))
            ? normalizePerm(entry[action], action)
            : defaultPerm(mode, action);
    }
    return out;
}

/** Which preset an access entry IS, or null when it is a mix of its own. */
export function matchBaseScope(entry: AccessEntry | null | undefined) {
    const found = BASE_SCOPES.find((s) => {
        const preset = scopeToEntry(s.value);
        return ACTIONS.every((a) => preset[a] === entry?.[a]);
    });
    return found ? found.value : null;
}

// ── Fields ──────────────────────────────────────────────────────────

/** Every column a rule may name, in picker order: the table's own, then the built-ins. */
export function ruleFields(table: RuleTable | null | undefined, t: TranslateFn | null = null): RuleField[] {
    const own = (Array.isArray(table?.fields) ? table.fields : [])
        // Read-time computed fields have no stored column — the server rejects them.
        .filter((f) => f && typeof f.key === 'string'
            && !(f.type === 'computed' && !(f.computed && f.computed.stored === true)))
        .map((f) => ({ key: f.key, name: f.name || f.key, type: f.type, options: f.options }));
    const taken = new Set(own.map((f) => f.key));
    return [...own, ...SYSTEM_FIELDS.filter((f) => !taken.has(f.key)).map(({ nameKey, ...f }) => ({ ...f, name: tr(t, nameKey, f.name) }))];
}

export function findRuleField(table: RuleTable | null | undefined, key: string, t: TranslateFn | null = null) {
    return ruleFields(table, t).find((f) => f.key === key) || null;
}

/** Which control the value side needs. */
export function valueKindOf(field?: { type?: string } | null) {
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

function operatorLabel(op: string, kind: string, t: TranslateFn | null = null) {
    const entry = ((kind === 'date' || kind === 'datetime') && DATE_OP_LABELS[op]) || OP_LABELS[op];
    return entry ? tr(t, entry[0], entry[1]) : op;
}

/**
 * The operator choices for a field. `keepOp` is always included so a rule that
 * was typed by hand (e.g. `>` on a text column) keeps its own operator in the
 * dropdown rather than snapping to another one.
 */
export function operatorsForField(field: RuleField | null | undefined, keepOp: string | null = null, t: TranslateFn | null = null) {
    const kind = valueKindOf(field);
    const ops = [...(OPS_BY_KIND[kind] || OPS_BY_KIND.text)];
    if (keepOp && !ops.includes(keepOp)) ops.push(keepOp);
    return ops.map((op) => ({ op, label: operatorLabel(op, kind, t) }));
}

// ── Conditions ──────────────────────────────────────────────────────

let conditionSeq = 0;
function nextId() { conditionSeq += 1; return `cond_${conditionSeq}`; }

export function blankCondition(table: RuleTable | null | undefined): RuleCondition {
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
export function ownRowsCondition(): RuleCondition {
    return { id: nextId(), field: 'created_by', op: '==', source: 'viewer.id', value: '', valueType: 'string' };
}

/** Re-type the value side after the field changed, keeping what still fits. */
export function retypeCondition(condition: RuleCondition, field: RuleField): RuleCondition {
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
export function conditionProblem(condition: RuleCondition, table: RuleTable | null | undefined, t: TranslateFn | null = null) {
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

export function serializeCondition(condition: RuleCondition | null | undefined) {
    if (!condition || !condition.field) return null;
    const left = `record.${condition.field}`;
    if (condition.op === 'empty') return `${left} == ""`;
    if (condition.op === 'notEmpty') return `${left} != ""`;
    const right = serializeValue(condition);
    return right == null ? null : `${left} ${condition.op} ${right}`;
}

/** The conditions, joined, as the one expression string the server stores. */
export function buildRowRule({ join = 'and', conditions = [] }: RowRule = {}) {
    const parts = conditions.map(serializeCondition).filter((p) => p != null);
    return parts.join(join === 'or' ? ' || ' : ' && ');
}

// ── Reading an existing rule back into pickers ──────────────────────

function leafToCondition(node: ExprNode | undefined, table: RuleTable | null | undefined): RuleCondition | null {
    if (!node || node.kind !== 'binop') return null;
    const op = CANON[node.op] || node.op;
    if (!CMP.has(op)) return null;

    const leftPath = readPath(node.a);
    const rightPath = readPath(node.b);
    let column: string | null = null;
    let other: ExprNode | null | undefined = null;
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
 * Read an expression back into pickable conditions. ok:false means "keep this
 * as text", never "throw it away".
 */
export function parseRowRule(expr: unknown, table: RuleTable | null | undefined): ParsedRowRule {
    const src = String(expr ?? '').trim();
    if (!src) return { ok: true, join: 'and', conditions: [] };
    if (!validateRowFilterExpr(src, table).ok) return NOT_PICKABLE;

    let ast;
    try { ast = parseExpr(src); } catch { return NOT_PICKABLE; }

    const ops = new Set<string>();
    const leaves: Array<ExprNode | undefined> = [];
    flattenLogic(ast, ops, leaves);
    if (ops.size > 1) return NOT_PICKABLE; // mixed and/or needs brackets the pickers can't show

    const conditions: RuleCondition[] = [];
    for (const leaf of leaves) {
        const condition = leafToCondition(leaf, table);
        if (!condition) return NOT_PICKABLE;
        conditions.push(condition);
    }
    return { ok: true, join: ops.has('||') ? 'or' : 'and', conditions };
}

// ── Plain-language summary ──────────────────────────────────────────

function describeValue(condition: RuleCondition, t: TranslateFn | null = null) {
    if (condition.source && condition.source !== 'value') return SOURCE_LABEL.has(condition.source) ? compareSourceLabel(condition.source, t) : condition.source;
    if (condition.valueType === 'bool') return (condition.value === true || condition.value === 'true') ? tr(t, 'studio_apps_edit.row_rule.yes', 'yes') : tr(t, 'studio_apps_edit.row_rule.no', 'no');
    if (condition.valueType === 'number') return String(condition.value);
    return `“${condition.value}”`;
}

function describeCondition(condition: RuleCondition, table: RuleTable | null | undefined, t: TranslateFn | null = null) {
    const field = findRuleField(table, condition.field, t);
    const name = field ? field.name : condition.field;
    const kind = valueKindOf(field);
    const op = operatorLabel(condition.op, kind, t);
    if (condition.op === 'empty' || condition.op === 'notEmpty') return tr(t, 'studio_apps_edit.row_rule.cond_unary', '{name} {op}', { name, op });
    return tr(t, 'studio_apps_edit.row_rule.cond_binary', '{name} {op} {value}', { name, op, value: describeValue(condition, t) });
}

/** e.g. `Owner is the person opening the app and Status is “open”`. */
export function describeRowRule({ join = 'and', conditions = [] }: RowRule = {}, table?: RuleTable | null, t: TranslateFn | null = null) {
    const usable = conditions.filter((c) => serializeCondition(c) != null);
    if (usable.length === 0) return '';
    return usable.map((c) => describeCondition(c, table, t)).reduce((acc, part) => (join === 'or'
        ? tr(t, 'studio_apps_edit.row_rule.rule_or', '{a} or {b}', { a: acc, b: part })
        : tr(t, 'studio_apps_edit.row_rule.rule_and', '{a} and {b}', { a: acc, b: part })));
}

/** True when any condition compares a never-filled-in column against empty. */
export function hasEmptyCheck({ conditions = [] }: RowRule = {}) {
    return conditions.some((c) => c.op === 'empty' || c.op === 'notEmpty');
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
 */
export function describeAccessOutcome({
    entry = null,
    t = null,
    roleLabel = tr(t, 'studio_apps_edit.row_rule.default_role', 'This role'),
    tableName = tr(t, 'studio_apps_edit.row_rule.default_table', 'this table'),
    hasRule = false,
    ruleSummary = '',
}: AccessOutcomeArgs = {}): { sees: string; writes: string | null; owner: string } {
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
