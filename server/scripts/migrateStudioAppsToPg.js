#!/usr/bin/env node
/**
 * Move App Studio apps off the per-app SQLite blob and into a per-app Postgres
 * schema (app_<appId> inside beeflow_core).
 *
 * WHY: the blob engine is single-writer by construction — one synchronous
 * handle per app, flushed as a whole file — so two server replicas writing one
 * app silently lose each other's changes, and every read blocks the event loop.
 * Postgres gives multi-replica correctness, real concurrency and authoritative
 * quotas for free.
 *
 * SAFETY MODEL
 *  • One PG transaction per app, guarded by an advisory lock, so two migrator
 *    runs (or a run racing a live server) cannot both migrate the same app.
 *  • Row counts must match per table BEFORE the transaction commits; a
 *    mismatch rolls the whole app back and leaves it on sqlite.
 *  • studio_apps.engine flips to 'pg' inside that same transaction — the flag
 *    the engines use as their interlock, so the switch is never half-made.
 *  • The RustFS blob is NOT deleted. It is the pre-migration backup.
 *  • --dry-run does the entire run and ends in ROLLBACK: a real rehearsal
 *    (PG's DDL is transactional), leaving no residue.
 *
 * USAGE
 *   node scripts/migrateStudioAppsToPg.js --all [--dry-run] [--report path]
 *   node scripts/migrateStudioAppsToPg.js --app <appId> [--dry-run]
 *   node scripts/migrateStudioAppsToPg.js --all --keep-going   # don't stop on a failed app
 *
 * The compiler/DDL layer is dialect-driven by STUDIO_APP_ENGINE, which this
 * script sets to 'pg' for its own process before requiring dataModel.
 */

'use strict';

process.env.STUDIO_APP_ENGINE = 'pg';

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');

const BATCH_ROWS = 500;
const SPOT_CHECK_ROWS = 20;

// ── SQLite → Postgres expression translation for stored computed columns ────
// Shared with the live DDL path (appStudio/dataModel.js) so a migrated app and
// a freshly installed one get byte-identical generated columns. Anything the
// translator does not know is attempted as-is and, if Postgres refuses it, the
// column is materialized as a plain column carrying the values SQLite already
// computed (frozen, but never wrong) and flagged in the report.
const { translateComputedExpr } = require('../appStudio/computedDialect');

function qi(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

// ── Value coercion, SQLite row → Postgres column ────────────────────────────
function coerceForPg(value, field, report) {
    if (value === null || value === undefined) return null;
    const type = field?.type;
    if (type === 'bool') {
        // SQLite stores 0/1 (and tolerates '0'/'true' from older writers).
        if (typeof value === 'boolean') return value;
        if (value === 1 || value === '1' || value === 'true') return true;
        if (value === 0 || value === '0' || value === 'false') return false;
        return null;
    }
    if (type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            report.push({ column: field.key, reason: `non-numeric value ${JSON.stringify(value)} → NULL` });
            return null;
        }
        return n;
    }
    // text / richtext / select / relation / multiselect / file / date /
    // datetime all travel as the strings SQLite holds; Postgres casts the
    // date-ish ones on insert (an unparseable one is caught per row below).
    return value;
}

/**
 * Migrate ONE app. Everything runs on `client` inside a single transaction the
 * CALLER owns — so a verification failure can roll back the whole app.
 */
async function _migrateOne(deps, appRow, opts = {}) {
    const { client, streamBlob, loadModel, openSqlite, log = () => {} } = deps;
    const appId = appRow.id;
    const ownerId = appRow.user_id;
    const schema = `app_${appId}`;
    const result = {
        id: appId, name: appRow.name || null, status: 'migrated',
        tables: {}, degradedComputed: [], coercionFallbacks: [],
    };

    if (appRow.engine === 'pg') {
        result.status = 'skipped';
        result.reason = 'already on the pg engine';
        return result;
    }

    // Serialize per app: a second migrator (or a racing server) waits here.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`studio-app-migrate:${appId}`]);

    const model = await loadModel(appId, ownerId);
    const tables = Array.isArray(model?.tables) ? model.tables : [];
    if (tables.length === 0) {
        result.status = 'skipped';
        result.reason = 'no data model';
        return result;
    }

    // 1. The source database. An app whose blob never materialized is a valid
    //    empty app: create the schema, copy nothing.
    const localPath = await streamBlob(ownerId, appId);
    // ...but "I could not read the blob" must NEVER be mistaken for "there is
    // no blob". studio_apps.db_size is the metadata's own claim about the
    // source; if it says there are bytes and we got none, every table would
    // copy zero rows AND pass the count check (0 === 0), quietly replacing a
    // real database with an empty one. Refuse instead.
    if (!localPath && Number(appRow.db_size) > 0) {
        throw new Error(
            `metadata says this app has a ${appRow.db_size}-byte database but the blob could not be read `
            + '— refusing to migrate an app to an empty schema (is object storage reachable?)',
        );
    }
    const db = localPath ? openSqlite(localPath) : null;

    try {
        // 2. Schema + DDL. dataModel emits PG dialect (STUDIO_APP_ENGINE=pg).
        const { ddlForTable } = require('../appStudio/dataModel');
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${qi(schema)}`);
        await client.query(`SET LOCAL search_path = ${qi(schema)}, pg_temp`);

        for (const table of tables) {
            const degraded = [];
            let ddl = ddlForTable(table);
            // Translate stored computed expressions, then prove each one
            // actually applies — inside a savepoint, so a refusal costs
            // nothing and we can fall back per column.
            const computed = (table.fields || []).filter((f) => f.type === 'computed' && f.computed?.stored);
            for (const f of computed) {
                ddl = ddl.split(f.computed.expr).join(translateComputedExpr(f.computed.expr));
            }
            await client.query('SAVEPOINT create_table');
            try {
                await client.query(ddl);
                await client.query('RELEASE SAVEPOINT create_table');
            } catch (e) {
                await client.query('ROLLBACK TO SAVEPOINT create_table');
                if (computed.length === 0) throw e;
                // Retry with every stored computed column demoted to a plain
                // column: the values SQLite already materialized are copied
                // below, so the data survives even when the expression cannot.
                const plainTable = {
                    ...table,
                    fields: (table.fields || []).map((f) => (f.type === 'computed' && f.computed?.stored
                        ? { ...f, type: f.computed.type || 'text', computed: undefined }
                        : f)),
                };
                await client.query(ddlForTable(plainTable));
                for (const f of computed) {
                    degraded.push({ table: table.key, field: f.key, reason: e.message });
                }
            }
            result.degradedComputed.push(...degraded);
            table._degradedFields = new Set(degraded.map((d) => d.field));
        }

        // 3. Copy rows, table by table, in batches.
        for (const table of tables) {
            const sqliteRows = db ? db.prepare(`SELECT * FROM ${qi(table.key)}`).all() : [];
            // Computed columns are server-derived and never inserted — unless
            // this one was demoted to a plain column, which is exactly the
            // case where its stored value must travel.
            const cols = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
            for (const f of (table.fields || [])) {
                if (f.type === 'computed' && !table._degradedFields?.has(f.key)) continue;
                cols.push(f.key);
            }
            const fieldByKey = new Map((table.fields || []).map((f) => [f.key, f]));

            for (let i = 0; i < sqliteRows.length; i += BATCH_ROWS) {
                const batch = sqliteRows.slice(i, i + BATCH_ROWS);
                const params = [];
                const tuples = batch.map((row) => {
                    const placeholders = cols.map((c) => {
                        const problems = [];
                        params.push(coerceForPg(row[c], fieldByKey.get(c), problems));
                        for (const p of problems) result.coercionFallbacks.push({ table: table.key, rowId: row.id, ...p });
                        return `$${params.length}`;
                    });
                    return `(${placeholders.join(',')})`;
                });
                const sql = `INSERT INTO ${qi(table.key)} (${cols.map(qi).join(',')}) VALUES ${tuples.join(',')}`;
                await client.query('SAVEPOINT ins');
                try {
                    await client.query(sql, params);
                    await client.query('RELEASE SAVEPOINT ins');
                } catch (e) {
                    // One poisoned value must not cost the whole batch: retry
                    // row by row so the report can name the casualty.
                    await client.query('ROLLBACK TO SAVEPOINT ins');
                    for (const row of batch) {
                        const rowParams = cols.map((c) => coerceForPg(row[c], fieldByKey.get(c), []));
                        const ph = rowParams.map((_v, n) => `$${n + 1}`);
                        try {
                            await client.query(
                                `INSERT INTO ${qi(table.key)} (${cols.map(qi).join(',')}) VALUES (${ph.join(',')})`,
                                rowParams,
                            );
                        } catch (rowErr) {
                            result.coercionFallbacks.push({ table: table.key, rowId: row.id, column: null, reason: rowErr.message });
                            throw rowErr; // count parity below would fail anyway — fail loudly here
                        }
                    }
                }
            }

            // 4. Verify BEFORE commit: counts must match exactly.
            const { rows: [{ count }] } = await client.query(`SELECT COUNT(*)::int AS count FROM ${qi(table.key)}`);
            result.tables[table.key] = { sqliteRows: sqliteRows.length, pgRows: count };
            if (count !== sqliteRows.length) {
                throw new Error(`row count mismatch for ${table.key}: sqlite ${sqliteRows.length} vs pg ${count}`);
            }
            // Spot-check a sample of ids so a silent id mangling can't pass.
            const sample = sqliteRows.slice(0, SPOT_CHECK_ROWS).map((r) => r.id).filter(Boolean);
            if (sample.length) {
                const { rows: found } = await client.query(
                    `SELECT id FROM ${qi(table.key)} WHERE id = ANY($1::text[])`, [sample],
                );
                if (found.length !== sample.length) {
                    throw new Error(`spot check failed for ${table.key}: ${found.length}/${sample.length} ids found`);
                }
            }
            log(`  ${table.key}: ${sqliteRows.length} rows`);
        }

        // 5. Schema stamp + the engine flip, same transaction.
        await client.query(`CREATE TABLE IF NOT EXISTS ${qi('_meta')} (key text PRIMARY KEY, value text)`);
        await client.query(
            `INSERT INTO ${qi('_meta')} (key, value) VALUES ('schema_stamp', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [String(model.modelVersion ?? 0)],
        );
        await client.query(`SET LOCAL search_path = public`);
        await client.query(`UPDATE studio_apps SET engine = 'pg', updated_at = NOW() WHERE id = $1`, [appId]);

        if (opts.dryRun) result.status = 'dry-run-ok';
        return result;
    } finally {
        if (db) { try { db.close(); } catch (_) { /* best effort */ } }
        if (localPath) { try { await fsp.unlink(localPath); } catch (_) { /* temp file */ } }
    }
}

// ── Real-world dependencies (the test injects its own) ──────────────────────

function realDeps(client) {
    const storageStore = require('../stores/storageStore');
    const { getOne } = require('../db');
    return {
        client,
        log: (m) => console.log(m),
        async loadModel(appId, ownerId) {
            const row = await getOne(
                `SELECT model, model_version FROM studio_app_data_meta WHERE app_id = $1 AND owner_user_id = $2`,
                [appId, ownerId],
            );
            if (!row) return null;
            const model = typeof row.model === 'string' ? JSON.parse(row.model) : row.model;
            return { ...model, modelVersion: parseInt(row.model_version, 10) || 0 };
        },
        async streamBlob(ownerId, appId) {
            // isAvailable() is false until init() has been awaited. In the
            // server that happens at boot; this script is its own process, so
            // skipping it made storage look absent — and every app look empty.
            if (typeof storageStore.init === 'function') await storageStore.init();
            if (!storageStore.isAvailable()) return null;
            const key = storageStore.buildStudioAppKey(ownerId, appId);
            try {
                const { stream } = await storageStore.streamFile(key);
                const chunks = [];
                for await (const chunk of stream) chunks.push(chunk);
                const target = path.join(os.tmpdir(), `beeflow-migrate-${appId}.db`);
                await fsp.writeFile(target, Buffer.concat(chunks));
                return target;
            } catch (err) {
                if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
                throw err;
            }
        },
        openSqlite(file) {
            let Database;
            try {
                Database = require('better-sqlite3');
            } catch (e) {
                throw new Error(`better-sqlite3 is required to read the source blob but could not be loaded: ${e.message}`);
            }
            return new Database(file, { readonly: true, fileMustExist: true });
        },
    };
}

function parseArgs(argv) {
    const opts = { all: false, appId: null, dryRun: false, keepGoing: false, report: 'studio-pg-migration-report.json' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--all') opts.all = true;
        else if (a === '--app') opts.appId = argv[++i];
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--keep-going') opts.keepGoing = true;
        else if (a === '--report') opts.report = argv[++i];
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.all && !opts.appId) {
        console.error('Usage: node scripts/migrateStudioAppsToPg.js (--all | --app <id>) [--dry-run] [--keep-going] [--report <path>]');
        process.exit(2);
    }

    const { getAll, getClient, pool } = require('../db');
    const apps = opts.appId
        ? await getAll(`SELECT id, user_id, name, engine, db_size FROM studio_apps WHERE id = $1`, [opts.appId])
        : await getAll(`SELECT id, user_id, name, engine, db_size FROM studio_apps ORDER BY created_at ASC`);

    console.log(`[migrate] ${apps.length} app(s)${opts.dryRun ? ' — DRY RUN (everything rolls back)' : ''}`);
    const report = { startedAt: new Date().toISOString(), dryRun: opts.dryRun, apps: [] };
    let failures = 0;

    for (const appRow of apps) {
        console.log(`[migrate] ${appRow.name || appRow.id} (${appRow.id})`);
        const client = await getClient();
        try {
            await client.query('BEGIN');
            const res = await _migrateOne(realDeps(client), appRow, { dryRun: opts.dryRun });
            if (opts.dryRun) await client.query('ROLLBACK');
            else await client.query('COMMIT');
            report.apps.push(res);
            console.log(`  → ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
            if (res.degradedComputed.length) {
                console.warn(`  ! ${res.degradedComputed.length} computed column(s) demoted to plain values — see the report`);
            }
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            failures++;
            report.apps.push({ id: appRow.id, name: appRow.name || null, status: 'failed', error: e.message });
            console.error(`  ✖ FAILED: ${e.message}`);
            if (!opts.keepGoing) break;
        } finally {
            client.release();
        }
    }

    report.finishedAt = new Date().toISOString();
    await fsp.writeFile(opts.report, JSON.stringify(report, null, 2));
    console.log(`[migrate] report → ${opts.report}`);
    console.log(`[migrate] ${report.apps.filter((a) => a.status === 'migrated' || a.status === 'dry-run-ok').length} ok, `
        + `${report.apps.filter((a) => a.status === 'skipped').length} skipped, ${failures} failed`);

    await pool.end().catch(() => {});
    process.exit(failures ? 1 : 0);
}

if (require.main === module) {
    main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { _migrateOne, translateComputedExpr, coerceForPg };
