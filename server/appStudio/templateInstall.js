/**
 * App Studio — the SINGLE template-instantiation path for a template's DATA
 * side (data model + seed rows + datasets). (review C4)
 *
 * The DEFINITION (component tree) is installed by studioApps.js's
 * create-from-template clone path; this module owns ONLY the data engine so
 * there is exactly one place that materialises a template's tables and rows.
 *
 *   installTemplate({ appId, ownerId, template }) → { ok, appId, dataModelVersion }
 *                                                 | { ok:false, error }
 *
 * Signature is FROZEN — the builder tool `app_apply_template` (sibling wave)
 * calls it with this exact shape. The OPTIONAL `seedMode` key is additive:
 *
 *   seedMode: 'all' (default)          — seed every table (create-time install)
 *   seedMode: 'missing-tables-only'    — the template-UPGRADE re-run: the
 *     migration diff still applies (safe), but seed rows go ONLY into tables
 *     that currently hold ZERO rows (authoritative COUNT(*) via
 *     studioAppDataStore.recountRows — the same store the executor's quota
 *     bookkeeping uses), so re-seeding can never duplicate rows in a table
 *     someone is working in. When a table's count is unknowable it is treated
 *     as populated (fail safe: skip). Datasets are likewise only created when
 *     no dataset with the same name exists yet.
 *
 * What it does, in order:
 *   1. dataModel → studioAppDataStore.saveDataModel (CAS seam; runs
 *      migrationPlan → SQLite DDL). The model is canonicalized first.
 *   2. seed rows → actionExecutor.writeRecord (the ONE record-write choke
 *      point: RLS + row/byte quotas asserted inside, created_by = the owner).
 *      Parent tables are seeded FIRST and a { $ref } relation value is rewritten
 *      to the parent's real rec_ id. NEVER raw SQL.
 *   3. datasets → studioAppDataStore.createDataset.
 *
 * Robustness: it is idempotent-SAFE (re-running against an app that already has
 * the model just replays an empty migration diff and re-seeds) and NEVER throws
 * past a clean { ok:false, error } — a single bad/over-quota seed row is logged
 * and skipped so the rest of the install still lands.
 */

'use strict';

const studioAppStore = require('../stores/studioAppStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const userStore = require('../stores/userStore');
const actionExecutor = require('./actionExecutor');
const { canonicalizeDataModel } = require('./dataModel');
const log = require('../telemetry/log');

// A template may not seed more than this per table. Raised from 50 for
// VOCABULARY tables — a materials list of 65 entries is seeded as one row per
// material (the humane editing shape), and a silent slice() here would have
// dropped fifteen of them into thin air.
const MAX_SEED_ROWS_PER_TABLE = 100;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Order a model's tables so every table comes AFTER the tables its relation
 * fields point at (parents before children) — so a child row's { $ref } always
 * resolves to an already-seeded parent id. Stable within a dependency tier
 * (keeps the authored order); tolerant of self-references and cycles (a cycle
 * just falls back to declaration order, never loops).
 */
function orderTablesByDependency(model) {
    const tables = Array.isArray(model && model.tables) ? model.tables : [];
    const byId = new Map(tables.map((t) => [t.id, t]));
    const visited = new Set();
    const visiting = new Set();
    const ordered = [];

    const visit = (table) => {
        if (!table || visited.has(table.id) || visiting.has(table.id)) return;
        visiting.add(table.id);
        for (const f of (Array.isArray(table.fields) ? table.fields : [])) {
            if (f && f.type === 'relation' && f.relation && typeof f.relation.table === 'string'
                && f.relation.table !== table.id && byId.has(f.relation.table)) {
                visit(byId.get(f.relation.table));
            }
        }
        visiting.delete(table.id);
        visited.add(table.id);
        ordered.push(table);
    };

    for (const t of tables) visit(t);
    return ordered;
}

/**
 * Turn one authored seed row into { alias, values } ready for writeRecord.
 * `$id` is a local alias (never a column); a { $ref } value is rewritten to the
 * referenced parent's real rec_ id (or null when the parent was not seeded).
 */
function resolveSeedRow(row, refMap) {
    let alias = null;
    const values = {};
    for (const [key, v] of Object.entries(isObject(row) ? row : {})) {
        if (key === '$id') { alias = (typeof v === 'string' && v) ? v : null; continue; }
        if (isObject(v) && typeof v.$ref === 'string') {
            values[key] = refMap.has(v.$ref) ? refMap.get(v.$ref) : null;
            continue;
        }
        values[key] = v;
    }
    return { alias, values };
}

/**
 * Rewrite a template's demo people into the installer's REAL colleagues.
 *
 * A seeded board is worth having — an app that opens empty teaches nothing —
 * but "Anna de Vries" is not on anybody's team, and now that assignment stores
 * a real user id, a demo name is a row whose owner does not exist. So the demo
 * WORK stays and the demo PEOPLE are replaced: the roster table is filled from
 * the organisation, and every card the template assigned to a fictional person
 * is dealt round-robin to a real one.
 *
 * The declaration lives on the template (`seedPeople`), so this stays generic:
 *
 *   seedPeople: {
 *     roster: { tableId, nameField, emailField? },
 *     assign: { tableId, idField, nameField, emailField? },
 *   }
 *
 * FALLBACK IS THE IMPORTANT PATH. A single-member org (a self-host trial, a
 * first login) or a directory read that fails leaves the authored seed exactly
 * as written — a demo board with demo names beats an empty board with none, and
 * the id column simply stays null until somebody assigns for real. Never write
 * a colleague's e-mail here: the directory deliberately does not return one.
 */
function applySeedPeople(tpl, members) {
    const spec = isObject(tpl.seedPeople) ? tpl.seedPeople : null;
    if (!spec || !Array.isArray(members) || members.length < 2) return tpl.seed;

    const seed = { ...tpl.seed };
    const roster = isObject(spec.roster) ? spec.roster : null;
    const assign = isObject(spec.assign) ? spec.assign : null;

    // The roster keeps the authored SHAPE (capacity, role) and takes real names,
    // so a team's capacity numbers survive and only the people change.
    if (roster && Array.isArray(seed[roster.tableId])) {
        const authored = seed[roster.tableId];
        seed[roster.tableId] = members.slice(0, authored.length).map((m, i) => {
            const base = { ...(isObject(authored[i]) ? authored[i] : {}) };
            if (roster.nameField) base[roster.nameField] = m.name;
            // The directory carries no e-mail; leaving the authored fake one in
            // place would be worse than leaving it empty.
            if (roster.emailField) base[roster.emailField] = null;
            return base;
        });
    }

    if (assign && Array.isArray(seed[assign.tableId])) {
        let next = 0;
        seed[assign.tableId] = seed[assign.tableId].map((row) => {
            if (!isObject(row)) return row;
            // Only rows the author already assigned. An unassigned card in the
            // seed is a deliberate "nobody has picked this up yet".
            const wasAssigned = assign.nameField && row[assign.nameField];
            if (!wasAssigned) return row;
            const m = members[next % members.length];
            next += 1;
            const out = { ...row };
            if (assign.idField) out[assign.idField] = m.id;
            if (assign.nameField) out[assign.nameField] = m.name;
            if (assign.emailField) out[assign.emailField] = null;
            return out;
        });
    }

    return seed;
}

/** The installer first, then everyone else — your own board should have you on it. */
function orderMembersForSeed(members, ownerId) {
    const list = (Array.isArray(members) ? members : [])
        .filter((m) => m && m.id)
        .map((m) => ({ id: m.id, name: m.displayName || m.username || m.id }));
    const meIdx = list.findIndex((m) => m.id === ownerId);
    if (meIdx > 0) list.unshift(list.splice(meIdx, 1)[0]);
    return list;
}

async function installTemplate({ appId, ownerId, template, seedMode = 'all' } = {}) {
    if (!appId || !ownerId) return { ok: false, error: 'appId and ownerId are required' };
    const missingOnly = seedMode === 'missing-tables-only';
    const tpl = isObject(template) ? template : {};
    const hasModel = isObject(tpl.dataModel);
    const hasSeed = isObject(tpl.seed);
    const hasDatasets = Array.isArray(tpl.datasets) && tpl.datasets.length > 0;

    // Definition-only template — nothing on the data side to install.
    if (!hasModel && !hasSeed && !hasDatasets) {
        return { ok: true, appId, dataModelVersion: 0 };
    }

    try {
        // writeRecord needs the app row for org_id stamping + owner scoping.
        const app = await studioAppStore.getStudioApp(appId);
        if (!app || app.userId !== ownerId) {
            return { ok: false, error: 'App not found or not owned by the installer' };
        }

        let dataModelVersion = 0;
        let model = null;

        // 1. Data model (canonicalized) → CAS store → SQLite DDL.
        if (hasModel) {
            const { model: canonical } = canonicalizeDataModel(tpl.dataModel);
            const res = await studioAppDataStore.saveDataModel(appId, ownerId, canonical);
            if (!res || !res.ok) {
                const why = res && res.invalid ? `data model failed validation: ${(res.errors || []).join('; ')}`
                    : res && res.conflict ? 'data model save conflict'
                        : res && res.notFound ? 'app not found while saving the data model'
                            : 'data model save failed';
                return { ok: false, error: why };
            }
            dataModelVersion = res.version;
            model = canonical;
        }

        // 2. Seed rows — parents first, through the writeRecord choke point.
        if (model && hasSeed) {
            // Upgrade re-runs must never duplicate rows: in missing-tables-only
            // mode, seed ONLY tables whose authoritative COUNT(*) is zero
            // (tables the migration just added count 0 and get their demo
            // rows; every populated table is left alone). Unknowable counts
            // fail SAFE — the table is treated as populated and skipped.
            let skipTableIds = null;
            if (missingOnly) {
                skipTableIds = new Set();
                let counts = null;
                try {
                    counts = await studioAppDataStore.recountRows(appId, ownerId, model.tables);
                } catch (e) {
                    log.warn(`[templateInstall] row recount failed for ${appId} — skipping ALL seeding: ${e && e.message ? e.message : e}`);
                }
                for (const table of (Array.isArray(model.tables) ? model.tables : [])) {
                    const n = counts ? parseInt(counts[table.key], 10) : NaN;
                    if (!Number.isFinite(n) || n > 0) skipTableIds.add(table.id);
                }
            }
            // Demo people → real colleagues, where the template asked for it.
            // Best-effort by design: a directory that will not answer must not
            // stop an install, it just leaves the authored seed alone.
            let seedRows = tpl.seed;
            if (isObject(tpl.seedPeople)) {
                try {
                    const members = app.organizationId
                        ? await userStore.getOrgMembersForDirectory(app.organizationId)
                        : [];
                    seedRows = applySeedPeople(tpl, orderMembersForSeed(members, ownerId));
                } catch (e) {
                    log.warn(`[templateInstall] org directory unavailable for ${appId} — seeding the authored demo people: ${e && e.message ? e.message : e}`);
                }
            }

            const refMap = new Map(); // $id alias → real rec_ id
            const viewer = { id: ownerId, role: 'owner' };
            for (const table of orderTablesByDependency(model)) {
                if (skipTableIds && skipTableIds.has(table.id)) continue;
                const rows = Array.isArray(seedRows[table.id]) ? seedRows[table.id] : [];
                for (const row of rows.slice(0, MAX_SEED_ROWS_PER_TABLE)) {
                    const { alias, values } = resolveSeedRow(row, refMap);
                    try {
                        const { id } = await actionExecutor.writeRecord(app, model, table, values, { viewer });
                        if (alias && id) refMap.set(alias, id);
                    } catch (e) {
                        // One bad/duplicate/over-quota row must not abort the
                        // install — the definition + model are already usable.
                        log.warn(`[templateInstall] seed row skipped for ${appId} table ${table.key}: ${e && e.message ? e.message : e}`);
                    }
                }
            }
        }

        // 3. Datasets (BI descriptors). createDataset always mints a new row,
        // so an upgrade re-run dedupes by NAME: only datasets the app does not
        // have yet are created. Unknowable existing datasets fail safe (none
        // created) — a duplicate dataset is confusing, a missing one is a
        // one-click re-add.
        if (hasDatasets) {
            let existingNames = null;
            if (missingOnly) {
                try {
                    const existing = await studioAppDataStore.listDatasets(appId, ownerId);
                    existingNames = new Set((existing || []).map((d) => d && d.name).filter(Boolean));
                } catch (e) {
                    log.warn(`[templateInstall] dataset listing failed for ${appId} — skipping dataset creation: ${e && e.message ? e.message : e}`);
                }
            }
            for (const ds of tpl.datasets) {
                if (!isObject(ds)) continue;
                if (missingOnly && (!existingNames || existingNames.has(ds.name))) continue;
                try {
                    await studioAppDataStore.createDataset(appId, ownerId, {
                        name: ds.name,
                        tableId: ds.tableId,
                        source: ds.source,
                        descriptor: ds.descriptor,
                        cacheTtlSeconds: ds.cacheTtlSeconds,
                    });
                } catch (e) {
                    log.warn(`[templateInstall] dataset skipped for ${appId}: ${e && e.message ? e.message : e}`);
                }
            }
        }

        return { ok: true, appId, dataModelVersion };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}

module.exports = {
    installTemplate,
    MAX_SEED_ROWS_PER_TABLE,
    // The two halves of "write a written-down row into a live table", shared
    // with appContentInstall.js. An app archive writes far more rows than a
    // seed and writes files besides, but it has to answer the same two
    // questions in the same way — which table goes first, and what a { $ref }
    // in a value means — so it asks these rather than keeping a second opinion.
    orderTablesByDependency,
    resolveSeedRow,
    // Test-only aliases (the names the existing tests import).
    _orderTablesByDependency: orderTablesByDependency,
    _resolveSeedRow: resolveSeedRow,
};
