// @typecheck
/**
 * Release Notes Store — customer-facing changelog entries.
 *
 * ── Why this is not CMS content ────────────────────────────────────────────
 *
 * The obvious home for a changelog is a CMS block, and that would be wrong for
 * two reasons the CMS makes explicit:
 *
 *   1. Draft/publish in the CMS is SITE-WIDE. `cmsStore.publishSite()` snapshots
 *      the whole draft at once, so a machine-written note parked in the draft
 *      would go live on the next unrelated publish — nobody having reviewed it.
 *   2. Locale overrides address block array items BY NUMERIC INDEX. A generator
 *      rewriting an `items` array would silently re-point every existing
 *      translation at a different item.
 *
 * So notes get their own table with PER-ENTRY status, and the `release-notes`
 * block renders them from `GET /api/public/release-notes`. That is the same
 * shape as the existing `github-stats` block, which the CMS documents as the
 * sanctioned route for a block that needs live server data.
 *
 * ── The rolling draft ──────────────────────────────────────────────────────
 *
 * A dev build refreshes ONE "Unreleased" entry covering everything since the
 * last production release; a prod release freezes that entry under a version
 * and the next dev build opens a fresh one. "Exactly one unreleased entry" is
 * enforced by a partial unique index rather than by application logic, so two
 * concurrent builds cannot race a second one into existence.
 */

const crypto = require('crypto');
const { pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');
const log = require('../telemetry/log');

const STATUS_DRAFT = 'draft';
const STATUS_PUBLISHED = 'published';

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS release_notes (
    id TEXT PRIMARY KEY,
    version TEXT,
    channel TEXT NOT NULL DEFAULT 'dev',
    status TEXT NOT NULL DEFAULT 'draft',
    title TEXT NOT NULL DEFAULT '',
    lead TEXT NOT NULL DEFAULT '',
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    from_sha TEXT,
    to_sha TEXT,
    services TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

-- At most one unreleased (version IS NULL) row, ever. The indexed expression is
-- constant within the filtered subset, so uniqueness collapses it to one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_notes_one_unreleased
    ON release_notes ((version IS NULL)) WHERE version IS NULL;

CREATE INDEX IF NOT EXISTS idx_release_notes_status ON release_notes(status, published_at DESC);
`;

const initDB = makeStoreInit('ReleaseNotesStore', _initDB);

async function _initDB() {
    try {
        await pool.query(INIT_SQL);
        log.info('[ReleaseNotesStore] PostgreSQL initialized');
    } catch (err) {
        log.error('[ReleaseNotesStore] Init error:', err.message);
        throw err;
    }
}

function rowToEntry(r) {
    if (!r) return null;
    return {
        id: r.id,
        version: r.version || null,
        channel: r.channel,
        status: r.status,
        title: r.title || '',
        lead: r.lead || '',
        items: Array.isArray(r.items) ? r.items : [],
        fromSha: r.from_sha || null,
        toSha: r.to_sha || null,
        services: r.services || null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    };
}

/**
 * Create or refresh the rolling "Unreleased" entry.
 *
 * Deliberately destructive of its own previous content: a dev build recomputes
 * the whole range since the last release, so the newest draft supersedes the
 * last rather than appending to it. Publishing status is preserved — see below.
 */
async function upsertUnreleased({ title = '', lead = '', items = [], fromSha = null, toSha = null, services = null, channel = 'dev' }) {
    await initDB();
    const existing = await getUnreleased();

    if (existing) {
        // A published Unreleased entry is left alone. Someone deliberately put
        // it in front of customers; silently rewriting it under them would be
        // worse than a slightly stale changelog.
        if (existing.status === STATUS_PUBLISHED) return existing;

        const { rows } = await pool.query(
            `UPDATE release_notes
                SET title = $2, lead = $3, items = $4::jsonb, from_sha = $5, to_sha = $6,
                    services = $7, channel = $8, updated_at = NOW()
              WHERE id = $1
              RETURNING *`,
            [existing.id, title, lead, JSON.stringify(items), fromSha, toSha, services, channel]
        );
        return rowToEntry(rows[0]);
    }

    const id = crypto.randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO release_notes (id, version, channel, status, title, lead, items, from_sha, to_sha, services)
         VALUES ($1, NULL, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         RETURNING *`,
        [id, channel, STATUS_DRAFT, title, lead, JSON.stringify(items), fromSha, toSha, services]
    );
    return rowToEntry(rows[0]);
}

/**
 * Freeze the rolling entry under a version — a production release happened.
 *
 * Stamping the version is what removes the row from the partial unique index,
 * which is what lets the next dev build open a fresh Unreleased entry. When no
 * rolling entry exists (first ever release, or every dev build failed), the
 * supplied material becomes the versioned entry directly.
 */
async function finaliseRelease({ version, title = '', lead = '', items = [], fromSha = null, toSha = null, services = null }) {
    await initDB();
    if (!version) throw new Error('version is required to finalise a release');

    const existing = await getUnreleased();
    if (existing) {
        const { rows } = await pool.query(
            `UPDATE release_notes
                SET version = $2, channel = 'prod', title = $3, lead = $4, items = $5::jsonb,
                    from_sha = COALESCE($6, from_sha), to_sha = $7, services = $8, updated_at = NOW()
              WHERE id = $1
              RETURNING *`,
            [existing.id, version, title || existing.title, lead || existing.lead,
                JSON.stringify(items.length ? items : existing.items), fromSha, toSha, services]
        );
        return rowToEntry(rows[0]);
    }

    const id = crypto.randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO release_notes (id, version, channel, status, title, lead, items, from_sha, to_sha, services)
         VALUES ($1, $2, 'prod', $3, $4, $5, $6::jsonb, $7, $8, $9)
         RETURNING *`,
        [id, version, STATUS_DRAFT, title, lead, JSON.stringify(items), fromSha, toSha, services]
    );
    return rowToEntry(rows[0]);
}

/** The rolling entry, or null. */
async function getUnreleased() {
    await initDB();
    const { rows } = await pool.query('SELECT * FROM release_notes WHERE version IS NULL');
    return rowToEntry(rows[0]);
}

async function getById(id) {
    await initDB();
    const { rows } = await pool.query('SELECT * FROM release_notes WHERE id = $1', [id]);
    return rowToEntry(rows[0]);
}

/** Everything, newest first — the admin review queue. */
async function listAll({ limit = 100 } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM release_notes
          ORDER BY (version IS NULL) DESC, COALESCE(published_at, updated_at) DESC
          LIMIT $1`,
        [limit]
    );
    return rows.map(rowToEntry);
}

/**
 * Published entries only — everything the public endpoint is allowed to see.
 * The status filter lives here, in the store, so no route can leak a draft by
 * forgetting a WHERE clause.
 */
async function listPublished({ limit = 20 } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM release_notes
          WHERE status = $1
          ORDER BY published_at DESC NULLS LAST
          LIMIT $2`,
        [STATUS_PUBLISHED, limit]
    );
    return rows.map(rowToEntry);
}

// Status is deliberately absent: publishing is its own gate (publishEntry).
const ENTRY_COLUMNS = {
    title: 'title',
    lead: 'lead',
    items: { col: 'items', cast: 'jsonb', transform: (v) => JSON.stringify(v) },
    version: { col: 'version', transform: (v) => v || null },
};

/** Editorial changes from the admin panel. Status is NOT settable here. */
async function updateEntry(id, { title, lead, items, version }) {
    await initDB();
    const built = buildUpdate({
        table: 'release_notes',
        updates: { title, lead, items, version },
        columnMap: ENTRY_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
        returning: '*',
    });
    if (!built) return getById(id);
    const { rows } = await pool.query(built.sql, built.params);
    return rowToEntry(rows[0]);
}

/** The human gate. Idempotent: re-publishing keeps the original timestamp. */
async function publishEntry(id) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE release_notes
            SET status = $2, published_at = COALESCE(published_at, NOW()), updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id, STATUS_PUBLISHED]
    );
    return rowToEntry(rows[0]);
}

/** Pull an entry back out of public view without deleting it. */
async function unpublishEntry(id) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE release_notes SET status = $2, published_at = NULL, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [id, STATUS_DRAFT]
    );
    return rowToEntry(rows[0]);
}

async function deleteEntry(id) {
    await initDB();
    const { rowCount } = await pool.query('DELETE FROM release_notes WHERE id = $1', [id]);
    return rowCount > 0;
}

module.exports = {
    upsertUnreleased,
    finaliseRelease,
    getUnreleased,
    getById,
    listAll,
    listPublished,
    updateEntry,
    publishEntry,
    unpublishEntry,
    deleteEntry,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
