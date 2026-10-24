/**
 * Install the TABLES (schema only), the empty tables the installer asked for,
 * and the list a `datatableKey` may be re-linked to.
 */

'use strict';

const { writeOpts } = require('../context');
const log = require('../../../../telemetry/log');

/** `<key>_2` … `<key>_9`: the copies a key clash may try (F7). */
const MAX_KEY_SUFFIX = 9;
/** The datatable key grammar allows 63 characters (vocabulary.js KEY_RE). */
const MAX_TABLE_KEY = 63;

function suffixedKey(key, n) {
    const tail = `_${n}`;
    return `${key.slice(0, MAX_TABLE_KEY - tail.length)}${tail}`;
}

/** The unique (scope, key) index refused this key; the same test createStudioDatatable uses. */
function isKeyClash(err) {
    return /uq_datatables_scope_key|already exists|duplicate key/i.test(String(err && err.message));
}

/**
 * Install the TABLES, schema only.
 *
 * ── Why the engine wiring is spelled out here ──────────────────────────────
 *
 * A `datatables` row, its entry in the scope model and the physical CREATE
 * TABLE have to land in ONE transaction. They used to be two on the create
 * route, and the failure mode is on the record: the metadata committed first,
 * so a DDL failure left a table the picker listed and every read 500'd on, and
 * the retry then hit the unique index on (scope, key). `createDatatable` takes
 * `applyPhysical` for exactly this reason, and it runs on the transaction's own
 * client. This is the third caller of that shape (POST /api/datatables and
 * scripts/assistantInstall.js are the other two); it is worth extracting once
 * there is somewhere shared to put it, and worth being explicit about until
 * then rather than approximating it.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * The installer's ORGANISATION when they have one, and their own account when
 * they do not. The Blueprint says nothing about scope — it cannot, the scope of
 * the install that produced it is meaningless here — so this is a decision made
 * at install time, and it is the same decision POST /api/datatables makes by
 * default.
 *
 * A failure is reported and skipped, never fatal: an install that half-worked
 * and said nothing is worse than one that failed loudly, and a rolled-back
 * transaction leaves nothing behind to be confused by.
 */
async function installDatatables(entities, ctx, report) {
    if (!entities.length) return;
    if (!ctx.can('automations')) {
        for (const e of entities) report.skipped.push({ ref: e.ref, kind: 'datatable', why: 'Tables are not part of this plan.', permanent: true });
        return;
    }
    const db = require('../../../../db');
    const datatableStore = require('../../../../stores/datatableStore');
    const datatableDbStore = require('../../../../stores/datatableDbStore');
    const { normalizeFields } = require('../../../../core/dataEngine/dataModel/datatableFields');
    const { migrationPlan } = require('../../../../core/dataEngine/dataModel/migrationPlan');
    const { ddlForTable } = require('../../../../core/dataEngine/dataModel/ddl');
    const { assertDatatableQuota } = require('../../../../core/dataEngine/datatableLimits');
    const PG = { dialect: 'pg' };

    const scope = ctx.scope || (ctx.organizationId
        ? datatableStore.orgScope(ctx.organizationId)
        : datatableStore.userScope(ctx.ownerId));
    const scopeKey = datatableDbStore.scopeKey(scope);

    for (const entity of entities) {
        try {
            // Through the same normaliser the create route uses: a column
            // without a stable id is INVISIBLE to the migration planner, so the
            // physical column is never created and nothing says so.
            const norm = normalizeFields(Array.isArray(entity.columns) ? entity.columns : [], []);
            if (!norm.ok) { report.skipped.push({ ref: entity.ref, kind: 'datatable', why: norm.error, permanent: true }); continue; }

            const rowScope = entity.rowScope === 'own' ? 'own' : 'all';
            const bundleKey = String(entity.key || '');
            const baseKey = typeof ctx.datatableKeyFor === 'function' ? String(ctx.datatableKeyFor(entity) || '') : bundleKey;
            const createWith = (key, logicalKey) => db.withTransaction(async (client) => datatableStore.createDatatable({
                scope, ownerUserId: ctx.ownerId,
                key,
                logicalKey,
                name: String(entity.name || 'Untitled table'),
                description: String(entity.description || ''),
                projectId: ctx.projectId,
                rowScope,
                retentionDays: Number.isInteger(entity.retentionDays) ? entity.retentionDays : null,
                retentionField: typeof entity.retentionField === 'string' && entity.retentionField ? entity.retentionField : 'created_at',
                subjectColumn: typeof entity.subjectColumn === 'string' && entity.subjectColumn ? entity.subjectColumn : null,
                fields: norm.fields,
            }, {
                client,
                // Filing a table into a stage project at INSERT is a stage write.
                ...writeOpts(ctx),
                assertQuota: (usage) => assertDatatableQuota(scope, { addTables: 1, usage }),
                applyPhysical: async (c, { before, next, modelVersion }) => {
                    const table = next.tables[next.tables.length - 1];
                    const ensure = ddlForTable(table, {
                        tableKeyById: new Map((next.tables || []).map(x => [x.id, x.key])),
                        dialect: 'pg', rowScope,
                    });
                    const plan = migrationPlan(before, next, { ...PG, onlyTableIds: [table.id] });
                    await datatableDbStore.applyMigration(scopeKey, scopeKey, [ensure, ...plan],
                        { client: c, targetVersion: modelVersion });
                },
            }));
            // F7: a second install of the same Blueprint in one organisation
            // meets its own first copy on the unique (scope, key) index. The
            // copy takes `<key>_<n>` and remembers the bundle's key as
            // `logical_key`; every in-bundle pointer reaches it through its
            // `$ref`, so nothing depends on the physical key.
            let created = null;
            let key = baseKey;
            for (let n = 1; !created; n++) {
                key = n === 1 ? baseKey : suffixedKey(baseKey, n);
                const logicalKey = key === bundleKey ? null : (bundleKey || null);
                try {
                    created = await createWith(key, logicalKey);
                } catch (err) {
                    try { datatableDbStore.invalidate(scopeKey); } catch (err) { log.debug('best effort', err); }
                    if (n >= MAX_KEY_SUFFIX || !isKeyClash(err)) throw err;
                }
            }
            datatableDbStore.invalidate(scopeKey);
            ctx.refMap.set(entity.ref, created.id);
            await ctx.stamp({ ref: entity.ref, kind: 'datatable', entityId: created.id, payload: { columns: norm.fields } });
            report.installed.datatables.push({ ref: entity.ref, id: created.id, name: entity.name, ...(key !== baseKey ? { key } : {}) });
            if (key !== baseKey) {
                report.warnings.push(`A table with the key "${baseKey}" already exists here, so "${entity.name || baseKey}" was created as "${key}".`);
            }
        } catch (err) {
            // The engine memoises "this scope has a model row" inside the
            // transaction that just rolled back, so the memo goes with it.
            try { datatableDbStore.invalidate(scopeKey); } catch (err) { log.debug('best effort', err); }
            report.skipped.push({ ref: entity.ref, kind: 'datatable', why: err.message });
        }
    }
}

/**
 * The empty tables the installer asked for, for keys this Blueprint does not
 * carry a table for.
 *
 * Through `installDatatables`, so there is exactly one path in this file that
 * creates a table — one transaction, one quota check, one physical DDL — rather
 * than a second, simpler-looking one that would drift from it.
 *
 * Two things are deliberately NOT shared with a bundled table:
 *
 *   - no stamp. `project_solution_entities` records what a bundled entity
 *     looked like on arrival so a later upgrade can tell edited from pristine.
 *     A table the installer conjured is in no Blueprint, so a stamp under a
 *     made-up ref would offer it updates from a file that never mentions it.
 *   - its own refMap. `{ $ref }` addresses the bundle; a synthetic ref must not
 *     become resolvable, or a manifest could point at one by guessing the name.
 */
async function createRequestedTables(ctx, report) {
    const wanted = (ctx.wiring.resolutions.tables || []).filter(t => t.create === true);
    if (!wanted.length) return;

    const sub = { installed: { datatables: [] }, skipped: [], warnings: [] };
    await installDatatables(
        wanted.map(t => ({ ref: `requested:${t.key}`, key: t.key, name: t.key, description: '', columns: [] })),
        { ...ctx, refMap: new Map(), stamp: async () => {} },
        sub,
    );

    for (const row of sub.installed.datatables) {
        const key = String(row.ref).slice('requested:'.length);
        ctx.wiring.createdForKey.set(key, row.id);
        // `ref: null` is the load-bearing part: this table belongs to the
        // Solution but to no entry in the Blueprint, and a reader (or O4's
        // upgrade client) must be able to tell those apart.
        report.installed.datatables.push({ ref: null, id: row.id, name: row.name, forKey: key });
    }
    for (const row of sub.skipped) {
        report.skipped.push({
            ref: null, kind: 'datatable',
            why: `The empty table "${String(row.ref).slice('requested:'.length)}" you asked for could not be created: ${row.why}`,
        });
    }
    report.warnings.push(...sub.warnings);
}

/**
 * The tables a `datatableKey` may be re-linked to, and which of them this
 * install made itself.
 *
 * The bundle's own tables come first and WIN a key clash. A Blueprint that
 * ships a table called "invoices" means its own copy when one of its automations
 * says `datatableKey: 'invoices'` — binding that step to a pre-existing table
 * of the recipient's instead would quietly point the Solution at somebody
 * else's data on the strength of a slug collision.
 */
function tablesForRebind(bundled, ctx, report) {
    const out = [];
    const byKey = new Set();

    for (const entity of bundled) {
        const id = ctx.refMap.get(entity.ref);
        const key = typeof entity.key === 'string' ? entity.key.trim() : '';
        if (!id || !key || byKey.has(key)) continue;
        byKey.add(key);
        ctx.wiring.freshTableIds.add(id);
        out.push({ id, key, name: entity.name || key });
    }

    for (const row of (ctx.wiring.resolutions.tables || [])) {
        const id = row.create === true ? ctx.wiring.createdForKey.get(row.key) : row.datatableId;
        if (!id) continue;                       // a create that failed; already reported
        if (byKey.has(row.key)) {
            report.warnings.push(
                `This Solution brings its own table for "${row.key}", so the one you picked was not used.`,
            );
            continue;
        }
        byKey.add(row.key);
        // A table THIS install created is as much "shipped with it" as a
        // bundled one, so it gets the same silence: there is nothing for the
        // installer to double-check about a table that did not exist a second
        // ago. A table they PICKED is theirs to check, and stays out of the set.
        if (row.create === true) ctx.wiring.freshTableIds.add(id);
        out.push({ id, key: row.key, name: row.key });
    }

    return out;
}

module.exports = { MAX_KEY_SUFFIX, MAX_TABLE_KEY, suffixedKey, isKeyClash, installDatatables, createRequestedTables, tablesForRebind };
