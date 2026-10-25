/**
 * folderStore.mts: the org-wide folder tree of the automations sidebar.
 *
 * Folders nest: a folder has an optional `parent_id` (same table, same
 * organisation). The rules a tree needs live HERE, in the store, so the web
 * routes and the MCP tools cannot disagree about them:
 *
 *   - no cycles: a folder cannot move under itself or one of its descendants;
 *   - parent and child belong to the same organisation, and the caller's own
 *     organisation owns both (an id from a client is never trusted: both the
 *     folder and the parent are loaded and checked before any write);
 *   - a maximum depth (AUTOMATION_FOLDER_MAX_DEPTH, default 8, 0 = unlimited);
 *   - a name is unique among the folders of ONE parent, case-insensitively.
 *
 * Deleting a folder never deletes anything. Its automations are detached (as
 * before: the folder may hold automations of colleagues this user cannot see)
 * and its sub-folders move up to the deleted folder's parent.
 *
 * Plain TypeScript that Node strips on load (erasable syntax only), so it
 * imports nothing: the database arrives as `db`, like the other store
 * factories (shares.js, lifecycle.js), and the pg test runs it on PGlite.
 * A refusal is a FolderError with a stable `code`; callers map it to their
 * own error type.
 */

import { randomBytes } from 'node:crypto';

const MAX_NAME_LEN = 80;
const DEFAULT_MAX_DEPTH = 8;

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface FolderDb extends Queryable {
    tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export interface Folder {
    id: string;
    organizationId: string | null;
    parentId: string | null;
    name: string;
    icon: string;
    color: string | null;
    createdAt: unknown;
    updatedAt: unknown;
    automationCount?: number;
}
export interface FolderNode extends Folder {
    children: FolderNode[];
}

export class FolderError extends Error {
    code: string;
    status: number;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = 'FolderError';
        this.code = code;
        this.status = status;
    }
}

// ── Pure tree rules ─────────────────────────────────────────────────────────

/** id to parent id, for the folders of one organisation. */
export type ParentMap = ReadonlyMap<string, string | null>;

/** The depth limit from AUTOMATION_FOLDER_MAX_DEPTH: a whole number, 0 = unlimited. */
export function maxFolderDepth(env: Record<string, string | undefined> = process.env): number {
    const raw = env.AUTOMATION_FOLDER_MAX_DEPTH;
    if (raw == null || raw.trim() === '') return DEFAULT_MAX_DEPTH;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_DEPTH;
}

/** Folders from the root down to `id`, inclusive (a top-level folder has depth 1). A loop in bad data ends the walk. */
export function depthOf(parents: ParentMap, id: string | null): number {
    let depth = 0;
    const seen = new Set<string>();
    let cur = id;
    while (cur != null && !seen.has(cur)) {
        seen.add(cur);
        depth += 1;
        cur = parents.get(cur) ?? null;
    }
    return depth;
}

/** Is `ancestorId` the folder `id` itself or one of its ancestors? */
export function isSelfOrAncestor(parents: ParentMap, ancestorId: string, id: string | null): boolean {
    const seen = new Set<string>();
    let cur = id;
    while (cur != null && !seen.has(cur)) {
        if (cur === ancestorId) return true;
        seen.add(cur);
        cur = parents.get(cur) ?? null;
    }
    return false;
}

/** Levels in the subtree of `id`, itself included (a leaf is 1). */
export function heightOf(parents: ParentMap, id: string): number {
    const children = new Map<string, string[]>();
    for (const [child, parent] of parents) {
        if (parent == null) continue;
        const list = children.get(parent);
        if (list) list.push(child);
        else children.set(parent, [child]);
    }
    let height = 0;
    const seen = new Set<string>();
    let level = [id];
    while (level.length > 0) {
        height += 1;
        const next: string[] = [];
        for (const node of level) {
            if (seen.has(node)) continue;
            seen.add(node);
            next.push(...(children.get(node) ?? []));
        }
        level = next;
    }
    return height;
}

/**
 * Throws when `id` (null = a folder that does not exist yet) cannot sit under
 * `newParentId` in this tree: a loop, or a tree deeper than `maxDepth`.
 */
export function assertPlacement(parents: ParentMap, id: string | null, newParentId: string | null, maxDepth: number): void {
    if (newParentId != null && id != null && isSelfOrAncestor(parents, id, newParentId)) {
        throw new FolderError(409, 'folder_cycle', 'A folder cannot be moved into itself or into one of its own subfolders.');
    }
    if (maxDepth > 0) {
        const below = id == null ? 1 : heightOf(parents, id);
        if (depthOf(parents, newParentId) + below > maxDepth) {
            throw new FolderError(400, 'folder_too_deep', `Folders can be nested at most ${maxDepth} levels deep.`);
        }
    }
}

export function cleanName(name: unknown): string {
    return String(name ?? '').trim().slice(0, MAX_NAME_LEN);
}

/** The folders as a forest, siblings sorted by name. */
export function buildTree(folders: Folder[]): FolderNode[] {
    const byId = new Map<string, FolderNode>(folders.map((f) => [f.id, { ...f, children: [] }]));
    const roots: FolderNode[] = [];
    for (const node of byId.values()) {
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        // A folder whose parent is missing from the list is shown at the top rather than lost.
        (parent ? parent.children : roots).push(node);
    }
    const byName = (a: FolderNode, b: FolderNode) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    const sort = (nodes: FolderNode[]) => { nodes.sort(byName); nodes.forEach((n) => sort(n.children)); };
    sort(roots);
    return roots;
}

// ── Rows ────────────────────────────────────────────────────────────────────

function rowToFolder(r: Record<string, any> | undefined | null): Folder | null {
    if (!r) return null;
    return {
        id: r.id,
        organizationId: r.organization_id ?? null,
        parentId: r.parent_id ?? null,
        name: r.name,
        icon: r.icon || '📁',
        color: r.color ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // Only present when the caller asked for counts.
        ...(r.automation_count !== undefined ? { automationCount: Number(r.automation_count || 0) } : {}),
    };
}

const sameOrg = (a: string | null | undefined, b: string | null | undefined) => (a || null) === (b || null);

const notFound = () => new FolderError(404, 'folder_not_found', 'Folder not found.');

// ── The store ───────────────────────────────────────────────────────────────

export function makeFolderStore(db: FolderDb, opts: { ready?: () => Promise<unknown>; maxDepth?: () => number } = {}) {
    const ready = async () => { if (opts.ready) await opts.ready(); };
    const depthLimit = opts.maxDepth || (() => maxFolderDepth());

    /** Every tree change of one organisation runs one at a time, so two moves cannot each look fine and close a loop together. */
    async function lockOrg(q: Queryable, organizationId: string | null) {
        await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`automation_folders:${organizationId || ''}`]);
    }

    async function parentMapOf(q: Queryable, organizationId: string | null): Promise<Map<string, string | null>> {
        const { rows } = await q.query(
            'SELECT id, parent_id FROM automation_folders WHERE organization_id IS NOT DISTINCT FROM $1',
            [organizationId ?? null],
        );
        return new Map(rows.map((r) => [r.id as string, (r.parent_id ?? null) as string | null]));
    }

    async function loadIn(q: Queryable, id: unknown): Promise<Folder | null> {
        if (typeof id !== 'string' || !id) return null;
        const { rows } = await q.query('SELECT * FROM automation_folders WHERE id = $1', [id]);
        return rowToFolder(rows[0]);
    }

    /** A folder of THIS organisation, or null: the same answer for "no such folder" and "somebody else's". */
    async function getFolderInOrg(id: unknown, organizationId: string | null): Promise<Folder | null> {
        await ready();
        const folder = await loadIn(db, id);
        return folder && sameOrg(folder.organizationId, organizationId) ? folder : null;
    }

    async function getFolder(id: string): Promise<Folder | null> {
        await ready();
        return loadIn(db, id);
    }

    /** The parent a folder is placed under: loaded, and in the caller's organisation. Null = top level. */
    async function requireParent(q: Queryable, parentId: unknown, organizationId: string | null): Promise<Folder | null> {
        if (parentId == null || parentId === '') return null;
        const parent = await loadIn(q, parentId);
        if (!parent || !sameOrg(parent.organizationId, organizationId)) {
            throw new FolderError(404, 'parent_not_found', 'The parent folder was not found.');
        }
        return parent;
    }

    async function assertNameFree(q: Queryable, organizationId: string | null, parentId: string | null, name: string, exceptId: string | null) {
        const { rows } = await q.query(
            `SELECT 1 FROM automation_folders
              WHERE organization_id IS NOT DISTINCT FROM $1 AND parent_id IS NOT DISTINCT FROM $2
                AND LOWER(name) = LOWER($3) AND id IS DISTINCT FROM $4 LIMIT 1`,
            [organizationId ?? null, parentId, name, exceptId],
        );
        if (rows.length) throw new FolderError(409, 'folder_name_taken', 'A folder with that name already exists here.');
    }

    /**
     * Folders for an org (the whole tree, flat, each with `parentId`), each with
     * how many of THIS user's automations sit directly in it. The count is
     * per-user on purpose: the list beside it is per-user too.
     */
    async function listFolders(organizationId: string | null, userId: string): Promise<Folder[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT f.*, (
                 SELECT COUNT(*) FROM automations a
                  WHERE a.folder_id = f.id AND a.user_id = $2 AND a.kind = 'automation' AND a.deleted_at IS NULL
             ) AS automation_count
               FROM automation_folders f
              WHERE f.organization_id IS NOT DISTINCT FROM $1
              ORDER BY LOWER(f.name) ASC`,
            [organizationId ?? null, userId],
        );
        return rows.map((r) => rowToFolder(r) as Folder);
    }

    async function listFolderTree(organizationId: string | null, userId: string): Promise<FolderNode[]> {
        return buildTree(await listFolders(organizationId, userId));
    }

    async function createFolder(input: {
        organizationId?: string | null; name: unknown; icon?: string | null; color?: string | null; parentId?: string | null;
    }): Promise<Folder> {
        await ready();
        const organizationId = input.organizationId ?? null;
        const name = cleanName(input.name);
        if (!name) throw new FolderError(400, 'folder_name_required', 'A folder needs a name.');
        const id = randomBytes(12).toString('hex');
        await db.tx(async (q) => {
            await lockOrg(q, organizationId);
            const parent = await requireParent(q, input.parentId, organizationId);
            assertPlacement(await parentMapOf(q, organizationId), null, parent?.id ?? null, depthLimit());
            await assertNameFree(q, organizationId, parent?.id ?? null, name, null);
            await q.query(
                `INSERT INTO automation_folders (id, organization_id, parent_id, name, icon, color)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, organizationId, parent?.id ?? null, name, input.icon || '📁', input.color ?? null],
            );
        });
        return (await getFolder(id)) as Folder;
    }

    async function updateFolder(id: string, patch: { name?: string; icon?: string; color?: string | null } = {}): Promise<Folder | null> {
        await ready();
        // Rejected before anything is written: a rename to whitespace is a caller error.
        if (patch.name !== undefined && !cleanName(patch.name)) throw new FolderError(400, 'folder_name_required', 'A folder needs a name.');
        await db.tx(async (q) => {
            const existing = await loadIn(q, id);
            if (!existing) throw notFound();
            await lockOrg(q, existing.organizationId);
            const sets: string[] = [];
            const params: unknown[] = [id];
            if (patch.name !== undefined) {
                const name = cleanName(patch.name);
                await assertNameFree(q, existing.organizationId, existing.parentId, name, id);
                params.push(name);
                sets.push(`name = $${params.length}`);
            }
            if (patch.icon !== undefined) { params.push(patch.icon || '📁'); sets.push(`icon = $${params.length}`); }
            if (patch.color !== undefined) { params.push(patch.color ?? null); sets.push(`color = $${params.length}`); }
            if (sets.length) await q.query(`UPDATE automation_folders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
        });
        return getFolder(id);
    }

    /**
     * Move a folder (with everything under it) to another parent, or to the top
     * level with `newParentId` null. `organizationId` is the CALLER's: a folder
     * or parent of another organisation answers "not found".
     */
    async function moveFolder(id: string, newParentId: string | null, organizationId: string | null): Promise<Folder> {
        await ready();
        await db.tx(async (q) => {
            await lockOrg(q, organizationId);
            const folder = await loadIn(q, id);
            if (!folder || !sameOrg(folder.organizationId, organizationId)) throw notFound();
            const parent = await requireParent(q, newParentId, organizationId);
            const parentId = parent?.id ?? null;
            if (parentId === folder.parentId) return;
            assertPlacement(await parentMapOf(q, organizationId), folder.id, parentId, depthLimit());
            await assertNameFree(q, organizationId, parentId, folder.name, folder.id);
            await q.query('UPDATE automation_folders SET parent_id = $2, updated_at = NOW() WHERE id = $1', [folder.id, parentId]);
        });
        return (await getFolder(id)) as Folder;
    }

    /**
     * Remove the folder and turn its automations loose; its sub-folders move up
     * to its parent (a name that is taken there gets " (2)", " (3)", ...).
     * Never deletes an automation or a sub-folder. Returns how many automations
     * were detached and how many sub-folders moved up.
     */
    async function deleteFolder(id: string): Promise<{ detached: number; reparented: number }> {
        await ready();
        return db.tx(async (q) => {
            const folder = await loadIn(q, id);
            if (!folder) return { detached: 0, reparented: 0 };
            await lockOrg(q, folder.organizationId);
            const { rows: kids } = await q.query(
                'SELECT id, name FROM automation_folders WHERE parent_id = $1 ORDER BY LOWER(name)',
                [id],
            );
            for (const kid of kids) {
                let name = kid.name as string;
                for (let n = 2; ; n += 1) {
                    const { rows } = await q.query(
                        `SELECT 1 FROM automation_folders
                          WHERE organization_id IS NOT DISTINCT FROM $1 AND parent_id IS NOT DISTINCT FROM $2
                            AND LOWER(name) = LOWER($3) AND id <> $4 LIMIT 1`,
                        [folder.organizationId, folder.parentId, name, kid.id],
                    );
                    if (!rows.length) break;
                    name = `${String(kid.name).slice(0, MAX_NAME_LEN - 6)} (${n})`;
                }
                await q.query(
                    'UPDATE automation_folders SET parent_id = $2, name = $3, updated_at = NOW() WHERE id = $1',
                    [kid.id, folder.parentId, name],
                );
            }
            const detached = await q.query('UPDATE automations SET folder_id = NULL WHERE folder_id = $1', [id]);
            await q.query('DELETE FROM automation_folders WHERE id = $1', [id]);
            return { detached: detached.rowCount || 0, reparented: kids.length };
        });
    }

    /**
     * May an automation of `organizationId` be filed in this folder? Returns the
     * folder, or throws 404 for a folder that does not exist or belongs to
     * another organisation. `null` (the top level) is always fine.
     */
    async function requireFolderForAutomation(folderId: unknown, organizationId: string | null): Promise<Folder | null> {
        if (folderId == null || folderId === '') return null;
        const folder = await getFolderInOrg(folderId, organizationId);
        if (!folder) throw notFound();
        return folder;
    }

    return {
        listFolders, listFolderTree, getFolder, getFolderInOrg, createFolder, updateFolder, moveFolder,
        deleteFolder, requireFolderForAutomation,
    };
}

export { MAX_NAME_LEN as MAX_FOLDER_NAME_LEN };
