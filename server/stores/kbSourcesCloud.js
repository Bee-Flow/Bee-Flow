// @typecheck strict
/**
 * The `cloud_folder` kind in the kb_sources store (stores/kbSources.js): the
 * boot DDL that lets an existing table hold the kind, the change cursor the
 * refresh engine keeps in `config`, and the lookup of a person's cloud folders.
 */

/**
 * A table that exists already keeps the CHECK it was created with, and CREATE TABLE IF NOT EXISTS
 * does not touch it: widen it once for a kind added later. The name is the one Postgres gave the
 * unnamed column check. The quotes in the LIKE matter: 'nextcloud_folder' contains the word cloud_folder.
 * @param {string} kindCheck  the full `kind IN (...)` condition
 */
function widenKindCheckDdl(kindCheck) {
    return `DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'kb_sources_kind_check' AND conrelid = 'kb_sources'::regclass
                          AND pg_get_constraintdef(oid) NOT LIKE '%''cloud_folder''%') THEN
                ALTER TABLE kb_sources DROP CONSTRAINT kb_sources_kind_check;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conname = 'kb_sources_kind_check' AND conrelid = 'kb_sources'::regclass) THEN
                ALTER TABLE kb_sources ADD CONSTRAINT kb_sources_kind_check CHECK (${kindCheck});
            END IF;
        END $$`;
}

/**
 * @template Row
 * @param {{ initDB: () => Promise<unknown>,
 *   getOne: (sql: string, params?: unknown[]) => Promise<DbRow.KbSources | null | undefined>,
 *   getAll: (sql: string, params?: unknown[]) => Promise<DbRow.KbSources[]>,
 *   mapRow: (row: DbRow.KbSources | null | undefined) => Row }} store
 */
function cloudFolders({ initDB, getOne, getAll, mapRow }) {
    return {
        /**
         * Record the change cursor of a cloud-folder source after a pass that covered everything
         * (core/kb/sources `precheck`): the folder's etag, a Graph delta link or a Drive page token.
         *
         * Merged into `config` like setSeenDataVersion, under `syncCursor`; a null clears it. It is
         * never part of what a client sees (routes/knowledgeBases/sourcePolicy publicSourceConfig).
         * @param {string} id
         * @param {string | null} cursor
         */
        setSyncCursor: async (id, cursor) => {
            await initDB();
            if (!id) return null;
            if (cursor == null || cursor === '') {
                return mapRow(await getOne(
                    `UPDATE kb_sources SET config = COALESCE(config, '{}'::jsonb) - 'syncCursor', updated_at = now()
                      WHERE id = $1 RETURNING *`,
                    [id],
                ));
            }
            return mapRow(await getOne(
                `UPDATE kb_sources
                    SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb,
                        updated_at = now()
                  WHERE id = $1
                  RETURNING *`,
                [id, JSON.stringify({ syncCursor: String(cursor).slice(0, 2000) })],
            ));
        },

        /**
         * The cloud-folder sources a user created at one provider: what a "something changed in this
         * account's storage" hint refreshes (core/kb/sources/cloudFolderEvents).
         * @param {string} userId
         * @param {string} provider  'nextcloud_files' | 'onedrive' | 'google_drive'
         */
        listCloudFoldersByUser: async (userId, provider) => {
            await initDB();
            if (!userId || !provider) return [];
            const rows = await getAll(
                `SELECT * FROM kb_sources
                  WHERE kind = 'cloud_folder' AND created_by = $1 AND config->>'provider' = $2
                  ORDER BY created_at ASC, id ASC`,
                [String(userId), String(provider)],
            );
            return (rows || []).map(mapRow);
        },
    };
}

module.exports = { cloudFolders, widenKindCheckDdl };
