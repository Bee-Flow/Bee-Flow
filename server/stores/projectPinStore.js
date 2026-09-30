'use strict';
const { exec, pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const DDL = `
    CREATE TABLE IF NOT EXISTS project_pins (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, item_type, item_id)
    )`;
const initDB = makeStoreInit('ProjectPinStore', () => exec(DDL));
function makeProjectPinStore(db, ready = async () => {}) {
    return {
        async list(projectId) {
            await ready();
            return (await db.query('SELECT item_type AS type, item_id AS id FROM project_pins WHERE project_id = $1 ORDER BY created_at, item_type, item_id', [projectId])).rows;
        },
        async put(projectId, type, id) {
            await ready();
            await db.query('INSERT INTO project_pins (project_id, item_type, item_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [projectId, type, id]);
        },
        async remove(projectId, type, id) {
            await ready();
            await db.query('DELETE FROM project_pins WHERE project_id = $1 AND item_type = $2 AND item_id = $3', [projectId, type, id]);
        },
    };
}
module.exports = { DDL, initDB, makeProjectPinStore, ...makeProjectPinStore(pool, initDB) };
