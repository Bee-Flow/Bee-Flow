// @typecheck
/**
 * House Style Store — per-organization Word/DOCX templates that drive the
 * styling of Notebook exports (font, headings, margins, header/footer logo).
 *
 * One org has zero or more house styles; at most one is marked as default.
 * The original .docx is kept as a blob so we can re-extract or regenerate
 * style metadata later without asking the user to re-upload.
 *
 * THE DATABASE IS AN ARGUMENT. `createHouseStyleStore(db)` builds the store
 * over any object with run/getOne/getAll/exec/withTransaction, and the module's
 * own export is that factory applied to the real facade. The rollback test
 * hands it a double instead of parking one on db.js's path in require.cache,
 * where every later suite in the process would have picked it up.
 */

const crypto = require('crypto');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');

// One default per org is enforced by the partial unique index below, so the
// old default has to be cleared BEFORE the new one is written. That ordering is
// only safe inside a transaction: on its own, a clear followed by a write that
// fails (or matches no row) leaves the org with no default at all.
const CLEAR_DEFAULT_SQL =
    'UPDATE org_house_styles SET is_default = FALSE WHERE org_id = $1 AND is_default = TRUE';

const HOUSE_STYLE_COLUMNS = {
    name: 'name',
    description: 'description',
    styleMeta: { col: 'style_meta', transform: v => JSON.stringify(v) },
};

/**
 * @param {{run: Function, getOne: Function, getAll: Function, exec: Function,
 *          withTransaction: Function}} db
 * @param {{tag?: string}} [opts] - tag only changes the init error log prefix.
 */
function createHouseStyleStore(db, { tag = 'houseStyleStore' } = {}) {
    const { run, getOne, getAll, exec, withTransaction } = db;

    const initDB = makeStoreInit(tag, _initDB);

    async function _initDB() {

        await exec(`
            CREATE TABLE IF NOT EXISTS org_house_styles (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                docx_blob BYTEA NOT NULL,
                style_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
                is_default BOOLEAN NOT NULL DEFAULT FALSE,
                created_by TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_house_styles_org ON org_house_styles(org_id);
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_house_styles_default
                ON org_house_styles(org_id) WHERE is_default = TRUE;
        `);
    }

    function mapRow(r, { includeBlob = false } = {}) {
        if (!r) return null;
        const out = {
            id: r.id,
            orgId: r.org_id,
            name: r.name,
            description: r.description || '',
            styleMeta: typeof r.style_meta === 'string' ? safeJSON(r.style_meta) : (r.style_meta || {}),
            isDefault: !!r.is_default,
            createdBy: r.created_by,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        };
        if (includeBlob) out.docxBlob = r.docx_blob;
        return out;
    }

    function safeJSON(v) { try { return JSON.parse(v); } catch (_) { return {}; } }

    async function listForOrg(orgId) {
        await initDB();
        const rows = await getAll(
            `SELECT id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at
             FROM org_house_styles WHERE org_id = $1 ORDER BY is_default DESC, created_at DESC`,
            [orgId]
        );
        return rows.map(r => mapRow(r));
    }

    async function getById(id, orgId, { includeBlob = false } = {}) {
        await initDB();
        const cols = includeBlob
            ? 'id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at, docx_blob'
            : 'id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at';
        const row = await getOne(
            `SELECT ${cols} FROM org_house_styles WHERE id = $1 AND org_id = $2`,
            [id, orgId]
        );
        return mapRow(row, { includeBlob });
    }

    async function getDefaultForOrg(orgId, { includeBlob = false } = {}) {
        await initDB();
        const cols = includeBlob
            ? 'id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at, docx_blob'
            : 'id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at';
        const row = await getOne(
            `SELECT ${cols} FROM org_house_styles WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
            [orgId]
        );
        return mapRow(row, { includeBlob });
    }

    async function create({ orgId, name, description, docxBuffer, styleMeta, createdBy, makeDefault }) {
        await initDB();
        const id = crypto.randomUUID();
        const insertSql =
            `INSERT INTO org_house_styles (id, org_id, name, description, docx_blob, style_meta, is_default, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
        const insertParams = [id, orgId, name, description || '', docxBuffer, JSON.stringify(styleMeta || {}), !!makeDefault, createdBy || null];

        if (makeDefault) {
            // Clear + insert commit together: a failing INSERT (oversized blob,
            // FK violation, dropped connection) must not strand the org without a
            // default house style.
            await withTransaction(async (client) => {
                await client.query(CLEAR_DEFAULT_SQL, [orgId]);
                await client.query(insertSql, insertParams);
            });
        } else {
            await run(insertSql, insertParams);
        }
        return getById(id, orgId);
    }

    async function update(id, orgId, updates) {
        await initDB();
        const built = buildUpdate({
            table: 'org_house_styles',
            updates,
            columnMap: HOUSE_STYLE_COLUMNS,
        });
        // `isDefault` alone is a real write — it flips a literal, so the
        // builder sees no changed column and the timestamp bump has to keep
        // following the flag rather than the builder.
        if (!built && updates.isDefault === undefined) return getById(id, orgId);
        const values = built ? built.params : [];
        const fields = [];
        if (updates.isDefault === true) {
            fields.push(`is_default = TRUE`);
        } else if (updates.isDefault === false) {
            fields.push(`is_default = FALSE`);
        }
        fields.push(`updated_at = NOW()`);
        let i = values.length + 1;
        values.push(id, orgId);
        const sql = `${built ? `${built.sql}, ` : 'UPDATE org_house_styles SET '}${fields.join(', ')}`
            + ` WHERE id = $${i++} AND org_id = $${i++}`;

        if (updates.isDefault === true) {
            const applied = await withTransaction(async (client) => {
                // Take (and hold) the target row first. If it is not in this org —
                // stale id, id copied from another organisation, concurrent delete —
                // the existing default must stay put: clearing it here would leave
                // the org with no default while the route answers 404, which reads
                // to the admin as "nothing happened".
                const { rowCount } = await client.query(
                    'SELECT id FROM org_house_styles WHERE id = $1 AND org_id = $2 FOR UPDATE',
                    [id, orgId]
                );
                if (!rowCount) return false;
                await client.query(CLEAR_DEFAULT_SQL, [orgId]);
                await client.query(sql, values);
                return true;
            });
            if (!applied) return null;
        } else {
            await run(sql, values);
        }
        return getById(id, orgId);
    }

    async function remove(id, orgId) {
        await initDB();
        await run(`DELETE FROM org_house_styles WHERE id = $1 AND org_id = $2`, [id, orgId]);
    }

    return {
        // Awaitbare init-ingang voor migrateDb en boot/storeSchemas.
        initDB,
        listForOrg,
        getById,
        getDefaultForOrg,
        create,
        update,
        remove,
    };
}

module.exports = createHouseStyleStore(require('../db'));
module.exports.createHouseStyleStore = createHouseStyleStore;
