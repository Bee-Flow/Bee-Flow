// @typecheck
/**
 * Version Store - PostgreSQL-backed unified version control for all agent types
 * Tracks version history for agents, browser agents, terminal agents, and swarms.
 *
 * Every row has a `kind`:
 *   'autosave'   the pre-update snapshot updateAgent writes on every confirmed
 *                save (the default — and what every row that predates the
 *                column becomes, via the column default).
 *   'published'  the state POST /agents/:id/publish-version copied into the
 *                published_* columns. One row per published_version.
 *   'pre_refine' the snapshot the A2 refine flow takes before an AI rewrite,
 *                so "undo" = restore.
 *
 * Only 'autosave' rows are pruned (50 per agent). A published or pre-refine
 * snapshot is a deliberate point in time and must not be pushed out by fifty
 * keystroke batches.
 *
 * THE DATABASE IS AN ARGUMENT. `createVersionStore(db)` builds the store over
 * any object with run/getOne/getAll/exec, and the module's own export is that
 * factory applied to the real facade. A test hands it an in-memory double and
 * keeps its hands off require.cache — no Module._resolveFilename patch, no
 * stale cache entry leaking into whatever the next suite loads.
 */

const { makeStoreInit } = require('./lib/storeInit');
const { v4: uuidv4 } = require('uuid');

const VERSION_KINDS = new Set(['autosave', 'published', 'pre_refine']);
const AUTOSAVE_KEEP = 50;

function safeParseJSON(str, fallback) {
    try { return typeof str === 'string' ? JSON.parse(str) : (str || fallback); } catch { return fallback; }
}

/**
 * @param {{run: Function, getOne: Function, getAll: Function, exec: Function}} db
 * @param {{tag?: string}} [opts] - tag only changes the init error log prefix.
 */
function createVersionStore(db, { tag = 'VersionStore' } = {}) {
    const { run, getOne, getAll, exec } = db;

    const initDB = makeStoreInit(tag, _initDB);

    async function _initDB() {
        await exec(`
            CREATE TABLE IF NOT EXISTS agent_versions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                snapshot TEXT NOT NULL,
                change_summary TEXT,
                created_by TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(agent_id, version_number)
            )
        `);
        await exec(`CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id)`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_agent_versions_lookup ON agent_versions(agent_id, version_number DESC)`);
        // Existing snapshots become 'autosave' through the default — no backfill.
        await exec(`ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'autosave'`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_agent_versions_kind ON agent_versions(agent_id, kind, version_number DESC)`);
    }

    /**
     * @param {object} [opts]
     * @param {'autosave'|'published'|'pre_refine'} [opts.kind='autosave']
     */
    async function createVersion(agentId, agentType, snapshot, userId = null, changeSummary = null, opts = {}) {
        await initDB();
        const kind = VERSION_KINDS.has(opts?.kind) ? opts.kind : 'autosave';
        const id = uuidv4();
        const last = await getOne('SELECT MAX(version_number) as max_ver FROM agent_versions WHERE agent_id = $1', [agentId]);
        const versionNumber = (last?.max_ver || 0) + 1;
        if (!changeSummary && snapshot) {
            changeSummary = await _autoSummary(agentId, snapshot) || `Version ${versionNumber}`;
        }

        await run(`
            INSERT INTO agent_versions (id, agent_id, agent_type, version_number, snapshot, change_summary, created_by, kind)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [id, agentId, agentType, versionNumber, JSON.stringify(snapshot), changeSummary, userId, kind]);

        await pruneVersions(agentId, AUTOSAVE_KEEP);
        return { id, agent_id: agentId, agent_type: agentType, version_number: versionNumber, change_summary: changeSummary, kind, created_at: new Date().toISOString() };
    }

    async function getVersions(agentId) {
        await initDB();
        return getAll(`
            SELECT id, agent_id, agent_type, version_number, change_summary, created_by, created_at, kind
            FROM agent_versions WHERE agent_id = $1 ORDER BY version_number DESC
        `, [agentId]);
    }

    async function getVersion(versionId) {
        await initDB();
        const row = await getOne('SELECT * FROM agent_versions WHERE id = $1', [versionId]);
        if (!row) return null;
        return { ...row, snapshot: safeParseJSON(row.snapshot, {}) };
    }

    async function deleteVersion(versionId) {
        await initDB();
        const { rowCount } = await run('DELETE FROM agent_versions WHERE id = $1', [versionId]);
        return rowCount > 0;
    }

    async function deleteAllVersions(agentId) {
        await initDB();
        await run('DELETE FROM agent_versions WHERE agent_id = $1', [agentId]);
    }

    // Prunes AUTOSAVE rows only. Published / pre-refine snapshots are never
    // counted and never deleted here.
    async function pruneVersions(agentId, keepCount = AUTOSAVE_KEEP) {
        await initDB();
        const count = await getOne("SELECT COUNT(*) as cnt FROM agent_versions WHERE agent_id = $1 AND kind = 'autosave'", [agentId]);
        if (parseInt(count.cnt) <= keepCount) return;
        await run(`
            DELETE FROM agent_versions
            WHERE agent_id = $1 AND kind = 'autosave' AND id NOT IN (
                SELECT id FROM agent_versions WHERE agent_id = $2 AND kind = 'autosave'
                ORDER BY version_number DESC LIMIT $3
            )
        `, [agentId, agentId, keepCount]);
    }

    async function _autoSummary(agentId, snapshot) {
        try {
            const prev = await getOne(
                'SELECT snapshot FROM agent_versions WHERE agent_id = $1 ORDER BY version_number DESC LIMIT 1',
                [agentId]
            );
            if (!prev) return null;
            const before = safeParseJSON(prev.snapshot, {});
            const norm = (v) => (v && typeof v === 'object') ? JSON.stringify(v) : (v ?? '');
            const changed = [];
            if (norm(before.system_prompt) !== norm(snapshot.system_prompt)) changed.push('system prompt');
            if (norm(before.name) !== norm(snapshot.name)) changed.push('name');
            if (norm(before.model) !== norm(snapshot.model)) changed.push('model');
            if (norm(before.config) !== norm(snapshot.config)) changed.push('config');
            if (!changed.length) return null;
            return `Updated ${changed.join(', ')}`;
        } catch { return null; }
    }

    return {
        // Awaitbare init-ingang voor migrateDb en boot/storeSchemas.
        initDB,
        createVersion,
        getVersions,
        getVersion,
        deleteVersion,
        deleteAllVersions,
        pruneVersions,
        VERSION_KINDS,
        AUTOSAVE_KEEP,
    };
}

module.exports = createVersionStore(require('../db'));
module.exports.createVersionStore = createVersionStore;
