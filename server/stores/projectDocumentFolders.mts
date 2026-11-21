/**
 * The folders of a project's Documents tab, shared by everyone on the project.
 *
 *   project_document_folders     a folder: its project and name (one level, no nesting)
 *   project_document_placements  which folder a document of the project is in;
 *                                no row means "not in a folder"
 *
 * A document's own folder in Studio (studio_document_folders) is its owner's
 * and stays as it is: a project's folders are the team's view of the documents
 * filed in that project. A placement only counts while the document is still
 * in the project (the list joins on studio_documents.project_id), so a document
 * taken out and filed again comes back loose. Deleting a folder puts its
 * documents back at the top (ON DELETE CASCADE on the placement).
 *
 * Built by a factory over a `{ query }` handle so the pg test runs this SQL
 * against PGlite; the default instance wraps the pool.
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { envCap } from '../utils/envNumber.mts';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[], rowCount?: number | null }> };

export type ProjectDocumentFolder = { id: string, name: string, createdBy: string, createdAt: string };

export const DDL = `
    CREATE TABLE IF NOT EXISTS project_document_folders (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        created_by  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_document_folders_project ON project_document_folders (project_id);
    CREATE TABLE IF NOT EXISTS project_document_placements (
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        folder_id   TEXT NOT NULL REFERENCES project_document_folders(id) ON DELETE CASCADE,
        PRIMARY KEY (project_id, document_id)
    );
`;

/** At most this many folders per project (PROJECT_DOCUMENT_FOLDERS_MAX, 0 = no limit). */
export const folderCap = (env: Record<string, string | undefined> = process.env): number => envCap('PROJECT_DOCUMENT_FOLDERS_MAX', 500, env);

const folderOf = (row: Row): ProjectDocumentFolder => ({
    id: String(row.id), name: String(row.name), createdBy: String(row.created_by),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
});

export function makeProjectDocumentFolders(db: Db, { ready = async () => {}, cap = () => folderCap() }: { ready?: () => Promise<unknown>, cap?: () => number } = {}) {
    /** The project's folders, by name. */
    async function listFolders(projectId: string): Promise<ProjectDocumentFolder[]> {
        await ready();
        const { rows } = await db.query(
            'SELECT id, name, created_by, created_at FROM project_document_folders WHERE project_id = $1 ORDER BY LOWER(name), created_at', [projectId]);
        return rows.map(folderOf);
    }

    /** document id → folder id, for the documents still filed in the project. */
    async function placements(projectId: string): Promise<Record<string, string>> {
        await ready();
        const { rows } = await db.query(
            `SELECT pl.document_id, pl.folder_id FROM project_document_placements pl
               JOIN studio_documents d ON d.id = pl.document_id AND d.project_id = pl.project_id
              WHERE pl.project_id = $1`, [projectId]);
        return Object.fromEntries(rows.map((r) => [String(r.document_id), String(r.folder_id)]));
    }

    /** A new folder; null when the project already has as many as it may. */
    async function createFolder(projectId: string, name: string, userId: string): Promise<ProjectDocumentFolder | null> {
        await ready();
        const max = cap();
        const { rows } = await db.query(
            `INSERT INTO project_document_folders (id, project_id, name, created_by)
             SELECT $1, $2, $3, $4
              WHERE $5::int = 0 OR (SELECT COUNT(*) FROM project_document_folders WHERE project_id = $2) < $5::int
             RETURNING id, name, created_by, created_at`,
            [crypto.randomUUID(), projectId, name, userId, max]);
        return rows[0] ? folderOf(rows[0]) : null;
    }

    /** Rename a folder of this project; null when there is no such folder in it. */
    async function renameFolder(projectId: string, folderId: string, name: string): Promise<ProjectDocumentFolder | null> {
        await ready();
        const { rows } = await db.query(
            'UPDATE project_document_folders SET name = $3 WHERE id = $2 AND project_id = $1 RETURNING id, name, created_by, created_at',
            [projectId, folderId, name]);
        return rows[0] ? folderOf(rows[0]) : null;
    }

    /** Delete a folder of this project; its documents go back to the top. */
    async function deleteFolder(projectId: string, folderId: string): Promise<boolean> {
        await ready();
        const r = await db.query('DELETE FROM project_document_folders WHERE id = $2 AND project_id = $1', [projectId, folderId]);
        return (r.rowCount || 0) > 0;
    }

    /**
     * Put a document of the project in one of its folders, or (null) back at
     * the top. False when the document is not filed in this project or the
     * folder is not one of its folders: both are checked in the statement.
     */
    async function placeDocument(projectId: string, documentId: string, folderId: string | null): Promise<boolean> {
        await ready();
        const inProject = await db.query('SELECT 1 FROM studio_documents WHERE id = $1 AND project_id = $2', [documentId, projectId]);
        if (!inProject.rows[0]) return false;
        if (folderId === null) {
            await db.query('DELETE FROM project_document_placements WHERE project_id = $1 AND document_id = $2', [projectId, documentId]);
            return true;
        }
        const r = await db.query(
            `INSERT INTO project_document_placements (project_id, document_id, folder_id)
             SELECT $1, $2, f.id FROM project_document_folders f WHERE f.id = $3 AND f.project_id = $1
             ON CONFLICT (project_id, document_id) DO UPDATE SET folder_id = EXCLUDED.folder_id`,
            [projectId, documentId, folderId]);
        return (r.rowCount || 0) > 0;
    }

    return { listFolders, placements, createFolder, renameFolder, deleteFolder, placeDocument };
}

const { exec, pool } = nodeRequire('../db') as { exec: (sql: string) => Promise<unknown>, pool: { query: Db['query'] } };
const { makeStoreInit } = nodeRequire('./lib/storeInit') as { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<unknown> };

export const initDB = makeStoreInit('ProjectDocumentFolders', async () => {
    await (nodeRequire('./projectStore') as { initDB: () => Promise<unknown> }).initDB();
    await (nodeRequire('./documentStore') as { initDB: () => Promise<unknown> }).initDB();
    await exec(DDL);
});

export const projectDocumentFolders = makeProjectDocumentFolders({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });
