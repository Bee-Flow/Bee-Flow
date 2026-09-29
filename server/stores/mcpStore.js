// @typecheck
/**
 * MCP Server Store — Persistence layer for MCP server definitions
 * 
 * Stores admin-defined MCP server configurations (command, args, required env vars).
 * Tools are discovered at config time and cached. Per-user credentials are stored
 * separately via configStore.
 */

const db = require('../db');
const { runDdl, CODES } = require('./lib/_ddl');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const TABLE = 'mcp_servers';

async function initTable() {
    // Migrate: drop old HTTP-based schema if it exists. Herkenning: het oude
    // schema had wél 'url' maar nog géén 'transport' — het huidige schema
    // heeft beide, dus alleen op 'url' testen (zoals eerst) liet deze DROP
    // elke boot opnieuw vuren op de NIEUWE tabel. De stille catch eromheen
    // maskeerde dat; nu de probe klopt geeft een échte fout (verbinding,
    // timeout) gewoon een luide init-fout. De DROP loopt via runDdl — die
    // serialiseert óók statements die db.exec' substring-queue passeren
    // (zoals DROP TABLE).
    const oldSchema = await db.getOne(
        `SELECT 1 AS old
           FROM information_schema.columns
          WHERE table_name = '${TABLE}' AND column_name = 'url'
            AND NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = '${TABLE}' AND column_name = 'transport'
            )`
    );
    if (oldSchema) {
        log.info('[MCPStore] Migrating from HTTP to stdio schema...');
        await runDdl('mcpStore', [`DROP TABLE ${TABLE}`]);
    }

    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            command TEXT,
            args JSONB DEFAULT '[]',
            required_credentials JSONB DEFAULT '[]',
            tools_cache JSONB DEFAULT '[]',
            enabled BOOLEAN DEFAULT true,
            status TEXT DEFAULT 'disconnected',
            error TEXT,
            transport TEXT DEFAULT 'stdio',
            url TEXT,
            category TEXT,
            description TEXT,
            icon TEXT,
            source TEXT DEFAULT 'manual',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // Migrate: add new columns if they don't exist yet. ADD COLUMN zonder
    // IF NOT EXISTS: de verwachte duplicate_column is hier het
    // idempotentie-mechanisme en blijft stil (tolerate); elke ándere fout —
    // die de oude catch (_) net zo hard inslikte — wordt nu luid verzameld.
    const newCols = [
        { name: 'transport', def: "TEXT DEFAULT 'stdio'" },
        { name: 'url', def: 'TEXT' },
        { name: 'category', def: 'TEXT' },
        { name: 'description', def: 'TEXT' },
        { name: 'icon', def: 'TEXT' },
        { name: 'source', def: "TEXT DEFAULT 'manual'" },
    ];
    await runDdl('mcpStore', [
        ...newCols.map((col) => ({
            sql: `ALTER TABLE ${TABLE} ADD COLUMN ${col.name} ${col.def}`,
            tolerate: CODES.DUPLICATE_COLUMN,
            reden: 'kolom bestaat al — verwachte idempotentie',
        })),
        // Make command nullable (HTTP servers don't need a command);
        // DROP NOT NULL is zelf al idempotent, dus fouten zijn hier echt.
        `ALTER TABLE ${TABLE} ALTER COLUMN command DROP NOT NULL`,
    ]);

    log.info('[MCPStore] Initialized (PostgreSQL)');
}

const initDB = makeStoreInit('MCPStore', initTable);

/**
 * Create a new MCP server definition.
 * @param {Object} server - { id, name, command, args, required_credentials }
 * required_credentials: [{ key: 'GITHUB_TOKEN', label: 'GitHub Token', description: '...' }]
 */
async function createServer({ id, name, command, args = [], required_credentials = [], transport = 'stdio', url, category, description, icon, source = 'manual' }) {
    await initDB();
    await db.run(
        `INSERT INTO ${TABLE} (id, name, command, args, required_credentials, transport, url, category, description, icon, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            command = EXCLUDED.command,
            args = EXCLUDED.args,
            required_credentials = EXCLUDED.required_credentials,
            transport = EXCLUDED.transport,
            url = EXCLUDED.url,
            category = EXCLUDED.category,
            description = EXCLUDED.description,
            icon = EXCLUDED.icon,
            source = EXCLUDED.source,
            updated_at = NOW()`,
        [id, name, command || null, JSON.stringify(args), JSON.stringify(required_credentials), transport, url || null, category || null, description || null, icon || null, source]
    );
}

async function getServer(id) {
    await initDB();
    const row = await db.getOne(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
    if (!row) return null;
    return parseRow(row);
}

async function listServers() {
    await initDB();
    const rows = await db.getAll(`SELECT * FROM ${TABLE} ORDER BY created_at ASC`);
    return rows.map(parseRow);
}

async function getEnabledServers() {
    await initDB();
    const rows = await db.getAll(`SELECT * FROM ${TABLE} WHERE enabled = true ORDER BY created_at ASC`);
    return rows.map(parseRow);
}

// [SEC] Updatable columns come ONLY from this hardcoded allowlist — an arbitrary
// `updates` key can no longer inject a column name (was `col = key`, M6d).
const MCP_UPDATE_COLS = {
    name: 'name',
    command: 'command',
    args: { col: 'args', transform: (v) => JSON.stringify(v) },
    required_credentials: { col: 'required_credentials', transform: (v) => JSON.stringify(v) },
    tools_cache: { col: 'tools_cache', transform: (v) => JSON.stringify(v) },
    enabled: 'enabled',
    transport: 'transport',
    url: 'url',
    category: 'category',
    description: 'description',
    icon: 'icon',
    source: 'source',
};

async function updateServer(id, updates) {
    await initDB();
    const { buildUpdate } = require('./lib/sqlBuilder');
    const built = buildUpdate({
        table: TABLE,
        updates,
        columnMap: MCP_UPDATE_COLS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
    });
    if (!built) return;
    await db.run(built.sql, built.params);
}

async function deleteServer(id) {
    await initDB();
    await db.run(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
}

function parseRow(row) {
    return {
        ...row,
        args: typeof row.args === 'string' ? JSON.parse(row.args) : (row.args || []),
        required_credentials: typeof row.required_credentials === 'string'
            ? JSON.parse(row.required_credentials) : (row.required_credentials || []),
        tools_cache: typeof row.tools_cache === 'string'
            ? JSON.parse(row.tools_cache) : (row.tools_cache || []),
        enabled: row.enabled !== false,
    };
}

module.exports = {
    initDB,
    // Historic name for the same memoized promise; started on access, so
    // requiring this module creates nothing.
    get ready() { return initDB(); },
    createServer,
    getServer,
    listServers,
    getEnabledServers,
    updateServer,
    deleteServer,
};
