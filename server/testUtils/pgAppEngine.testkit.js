// @typecheck
'use strict';

/**
 * The per-app Postgres engine (stores/lib/pgAppEngine) on PGlite, for a test that runs
 * migrations and writes through the real engine. Registers a setup test that boots PGlite with
 * the `studio_apps` table and the engine, and closes PGlite after the file.
 *
 *   const pgApp = usePgAppEngine(test);
 *   await pgApp.rawQuery('INSERT INTO studio_apps …', [...]);
 *   await pgApp.engine.applyMigration(owner, appId, plan);
 */

const { createPgAppEngine } = require('../stores/lib/pgAppEngine');
const { pgliteQuery } = require('./pglitePool');

function usePgAppEngine(test) {
    const h = { pg: null, engine: null, rawQuery: (sql, params) => pgliteQuery(h.pg)(sql, params) };
    test('(setup) boot pglite and the engine', async () => {
        const { newPglite } = require('./pgliteTemplate');
        h.pg = newPglite();
        await h.pg.exec(`CREATE TABLE studio_apps (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'sqlite',
            db_sha256 TEXT DEFAULT '', db_size BIGINT DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW())`);
        h.engine = createPgAppEngine({
            runQuery: h.rawQuery,
            getClient: async () => ({ query: h.rawQuery, release: () => {} }),
            logPrefix: 'StudioAppDB',
            entityLabel: 'Studio App DB',
            schemaFor: (appId) => 'app_' + appId,
        });
    });
    test.after(async () => { if (h.pg) await h.pg.close(); });
    return h;
}

module.exports = { usePgAppEngine };
