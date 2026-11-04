// @typecheck strict
/**
 * App Studio data model — migration planning, step 4b: the stored-computed
 * rebuilds around the in-place field type conversions, and the op/probe
 * bookkeeping planMigration reports (./migrationPlan.js). Every step takes the
 * plan context `p` migrationPlan builds (RebuildContext below).
 */

'use strict';

const {
    qi,
    isAlterPhysical,
    isStoredComputed,
    ddlForStoredComputedColumn,
    dropColumnDdl,
} = require('./ddl');
const { fieldConversion, conversionDdl, unconvertibleWhere, exprMentions } = require('./fieldConversion.mts');

/**
 * The surviving tables a step may ALTER: [id, newTable, oldTable] for each.
 * @param {RebuildContext} p
 * @returns {Generator<[string, ModelTable, ModelTable]>}
 */
function* survivingAlterable(p) {
    for (const [id, nt] of p.newTables) {
        if (!p.inScope(id) || !p.alterable(id)) continue;
        const ot = p.oldTables.get(id);
        if (ot) yield [id, nt, ot];
    }
}

/**
 * Push statements as one op of the plan report; returns the op's index.
 * @param {RebuildContext} p
 * @param {string[]} statements
 * @param {Omit<PlanOp, 'first' | 'last'>} op
 */
function pushOp(p, statements, op) {
    const first = p.plan.length;
    p.plan.push(...statements);
    p.ops.push({ ...op, first, last: p.plan.length - 1 });
    return p.ops.length - 1;
}

/**
 * A COUNT probe the engine runs before statement `at` (the report's row counts, refuse-mode checks).
 * @param {RebuildContext} p
 * @param {{ tableKey: string, opIndex: number, at: number, bad?: string | null, refuse?: boolean }} probe
 */
function pushProbe(p, { tableKey, opIndex, at, bad = null, refuse = false }) {
    const badSql = bad ? `COALESCE(SUM(CASE WHEN ${bad} THEN 1 ELSE 0 END), 0)` : '0';
    p.probes.push({ sql: `SELECT COUNT(*) AS n, ${badSql} AS bad FROM ${qi(tableKey)}`, at, opIndex, refuse, tableKey });
}

/**
 * The op fields every report entry carries.
 * @param {PlanOp['kind']} kind
 * @param {string} reason
 * @param {{ nt: ModelTable, ot: ModelTable, nf: ModelField, of: ModelField | null }} fields
 * @returns {Omit<PlanOp, 'first' | 'last'>}
 */
function opBase(kind, reason, { nt, ot, nf, of }) {
    return {
        kind, reason, tableId: nt.id, tableKey: nt.key, oldTableKey: ot.key,
        fieldId: nf.id, fieldKey: nf.key, oldFieldKey: of ? of.key : nf.key,
    };
}

/** @param {ModelField} f */
const exprOf = (f) => (f.computed && typeof f.computed.expr === 'string' ? f.computed.expr : '');

/**
 * 4b. Stored-computed fields whose RULE changed on a surviving table.
 *
 * The value in a GENERATED ALWAYS column is decided by the expression baked
 * into the column at CREATE time, so editing `computed.expr` in the model used
 * to change nothing at all: the model said one thing, every row kept answering
 * with the old rule, and no error was raised anywhere. A "Controle" column went
 * on reporting "ok" for lines its own definition called doubtful.
 *
 * Rebuilding is safe in a way it never is for a normal column: the data is
 * entirely derived, so DROP + ADD recomputes it from the surviving columns
 * rather than losing anything. That is also what makes read-time ⇄ stored
 * transitions expressible here — a materialise is just an ADD.
 *
 * The expression itself passed computedExprError (no ";", no comment
 * sequences, bounded) during validateDataModel on this very save, the same
 * guard CREATE TABLE relies on.
 *
 * Three passes, all drops before all adds: 4b-i drops every stored-computed
 * column whose rule changed AND every one that reads a column converted in
 * this plan (neither database converts a column a generated column reads),
 * 4b-ii converts the field types (opts.convertTypes only), 4b-iii adds the
 * dropped ones back with their (new) rule. The ADD recomputes every row inside
 * the migration transaction; the op carries the row count probe.
 *
 * @param {RebuildContext} p
 * @returns {Rebuild[]}  [nt, ot, nf, of, reason] to rebuild
 */
function storedComputedRebuilds(p) {
    /** @type {Rebuild[]} */
    const out = [];
    for (const [, nt, ot] of survivingAlterable(p)) {
        const oldById = new Map(ot.fields.map(f => [f.id, f]));
        const converting = p.convertingKeys.get(nt.id) || [];
        for (const nf of nt.fields) {
            const of = oldById.get(nf.id);
            // A brand-new field is handled by step 4 / create.
            const reason = of ? rebuildReason(of, nf, converting) : null;
            if (of && reason) out.push([nt, ot, nf, of, reason]);
        }
    }
    return out;
}

/**
 * Why a surviving stored-computed field is rebuilt, or null when it is not.
 * @param {ModelField} of
 * @param {ModelField} nf
 * @param {string[]} converting
 */
function rebuildReason(of, nf, converting) {
    const wasStored = isStoredComputed(of);
    const nowStored = isStoredComputed(nf);
    if (!wasStored && !nowStored) return null;
    const sameRule = wasStored && nowStored
        && exprOf(of) === exprOf(nf)
        && (of.computed?.type || 'text') === (nf.computed?.type || 'text')
        && of.key === nf.key;
    if (!sameRule) return wasStored ? 'expression' : 'materialised';
    return converting.some(k => exprMentions(exprOf(nf), k)) ? 'dependency' : null;
}

/**
 * 4b-i. Drop the stored-computed columns 4b rebuilds, under the OLD key (renameColumns skips computed fields).
 * @param {RebuildContext} p
 * @param {Rebuild[]} rebuilds
 */
function dropStoredComputed(p, rebuilds) {
    for (const [nt, , , of] of rebuilds) {
        if (of && isStoredComputed(of)) p.plan.push(dropColumnDdl(nt.key, of.key, /** @type {string} */ (p.dialect)));
    }
}

/**
 * 4b-ii. Convert field types in place (opts.convertTypes); an unsafe pair is reported, never executed.
 * @param {RebuildContext} p
 */
function convertFieldTypes(p) {
    if (!p.convertTypes) return;
    for (const [, nt, ot] of survivingAlterable(p)) {
        const oldById = new Map(ot.fields.map(f => [f.id, f]));
        for (const nf of nt.fields) {
            const of = oldById.get(nf.id);
            const conv = of ? fieldConversion(of, nf) : null;
            if (!of || !conv) continue;
            const ctx = { nt, ot, nf, of };
            const physical = isAlterPhysical(of) && isAlterPhysical(nf) && of.type !== 'relation' && nf.type !== 'relation';
            if (!conv.safe || !physical) {
                p.ops.push({ ...opBase('unsupported', 'unsafe_pair', ctx), from: conv.from, to: conv.to, first: -1, last: -1 });
                continue;
            }
            const at = p.plan.length;
            const statements = conversionDdl({ table: nt, oldF: of, newF: nf, conv, onUnconvertible: p.onUnconvertible, dialect: p.dialect });
            const opIndex = pushOp(p, statements, { ...opBase('convert', 'type', ctx), from: conv.from, to: conv.to, action: p.onUnconvertible });
            pushProbe(p, { tableKey: nt.key, opIndex, at, bad: unconvertibleWhere(conv, nf.key, nf, p.dialect), refuse: p.onUnconvertible !== 'clear' });
        }
    }
}

/**
 * 4b-iii. Add the rebuilt stored-computed columns back (and the new ones that waited for a conversion).
 * @param {RebuildContext} p
 * @param {Rebuild[]} rebuilds
 */
function addStoredComputed(p, rebuilds) {
    /** @type {Array<[ModelTable, ModelTable, ModelField, ModelField | null, string]>} */
    const adds = rebuilds.filter(([, , nf]) => isStoredComputed(nf));
    for (const [, nt, ot] of survivingAlterable(p)) {
        const oldIds = new Set(ot.fields.map(f => f.id));
        const converting = p.convertingKeys.get(nt.id) || [];
        for (const nf of nt.fields) {
            if (!oldIds.has(nf.id) && isStoredComputed(nf) && converting.some(k => exprMentions(exprOf(nf), k))) {
                adds.push([nt, ot, nf, null, 'new']);
            }
        }
    }
    for (const [nt, ot, nf, of, reason] of adds) {
        const at = p.plan.length;
        const opIndex = pushOp(p, [ddlForStoredComputedColumn(nt.key, nf, p.dialect)], opBase('recompute', reason, { nt, ot, nf, of }));
        pushProbe(p, { tableKey: nt.key, opIndex, at });
    }
}

/**
 * 4b. Stored-computed rebuilds around the type conversions (see storedComputedRebuilds).
 * @param {RebuildContext} p
 */
function rebuildStoredComputed(p) {
    const rebuilds = storedComputedRebuilds(p);
    dropStoredComputed(p, rebuilds);
    convertFieldTypes(p);
    addStoredComputed(p, rebuilds);
}

/**
 * Per surviving table id: the old and new keys of the fields this plan converts.
 * @param {RebuildContext} p
 * @returns {Map<string, string[]>}
 */
function convertingKeysOf(p) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    if (!p.convertTypes) return out;
    for (const [id, nt, ot] of survivingAlterable(p)) {
        const oldById = new Map(ot.fields.map(f => [f.id, f]));
        /** @type {string[]} */
        const keys = [];
        for (const nf of nt.fields) {
            const of = oldById.get(nf.id);
            const conv = of ? fieldConversion(of, nf) : null;
            if (of && conv && conv.safe && isAlterPhysical(of) && isAlterPhysical(nf)) keys.push(of.key, nf.key);
        }
        if (keys.length) out.set(id, keys);
    }
    return out;
}

module.exports = { survivingAlterable, pushOp, pushProbe, opBase, rebuildStoredComputed, convertingKeysOf };

/** @typedef {import('./migrationShape').ModelTable} ModelTable */
/** @typedef {import('./migrationShape').ModelField} ModelField */
/** @typedef {[ModelTable, ModelTable, ModelField, ModelField, string]} Rebuild */

/**
 * One report entry of a plan (planMigration `ops`).
 * @typedef {{ kind: 'recompute' | 'convert' | 'unsupported', reason: string, tableId: string, tableKey: string,
 *   oldTableKey: string, fieldId: string, fieldKey: string, oldFieldKey: string, from?: string, to?: string,
 *   action?: 'refuse' | 'clear', first: number, last: number }} PlanOp
 */

/**
 * The part of migrationPlan's context step 4b reads and writes.
 * @typedef {{ oldTables: Map<string, ModelTable>, newTables: Map<string, ModelTable>,
 *   inScope: (id: string) => boolean, alterable: (id: string) => boolean, dialect?: string, plan: string[],
 *   ops: PlanOp[], probes: Array<{ sql: string, at: number, opIndex: number, refuse: boolean, tableKey: string }>,
 *   convertTypes: boolean, onUnconvertible: 'refuse' | 'clear', convertingKeys: Map<string, string[]> }} RebuildContext
 */
