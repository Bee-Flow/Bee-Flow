'use strict';
const { exec, pool, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const DDL = `CREATE TABLE IF NOT EXISTS project_task_boards (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    columns_sealed TEXT NOT NULL,
    assignments JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 0
)`;
const initDB = makeStoreInit('ProjectBoardStore', () => exec(DDL));
function makeProjectBoardStore(db, tx, ready = async () => {}) {
    return {
        async read(projectId) {
            await ready();
            return (await db.query('SELECT * FROM project_task_boards WHERE project_id = $1', [projectId])).rows[0] || null;
        },
        async change(projectId, initialColumns, change) {
            await ready();
            return tx(async client => {
                await client.query('INSERT INTO project_task_boards (project_id, columns_sealed) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, initialColumns]);
                const row = (await client.query('SELECT * FROM project_task_boards WHERE project_id = $1 FOR UPDATE', [projectId])).rows[0];
                const result = await change(row, client);
                await client.query('UPDATE project_task_boards SET columns_sealed = $2, assignments = $3::jsonb, version = version + 1 WHERE project_id = $1', [projectId, row.columns_sealed, JSON.stringify(row.assignments)]);
                return { ...result, version: row.version + 1 };
            });
        },
    };
}
module.exports = { DDL, initDB, makeProjectBoardStore, ...makeProjectBoardStore(pool, withTransaction, initDB) };
