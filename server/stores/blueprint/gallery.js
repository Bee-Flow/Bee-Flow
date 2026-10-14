// @typecheck
/**
 * The Blueprint gallery: save (or version-bump) a Blueprint, list and read
 * the ones a caller may install, count installs, delete. Built by
 * `makeGalleryStore(ctx)` over the context `makeBlueprintStore` builds;
 * `_saveBlueprint` is also handed to the releases module, so a publication
 * runs literally the same statements inside its transaction.
 */

'use strict';

const { MAX_BLUEPRINTS_PER_ORG } = require('./constants');
const { newId, mapRow, assertManifestSize, asCount, META_COLUMNS } = require('./mappers');

/** @param {import('./mappers').BlueprintStoreCtx} ctx */
function makeGalleryStore({ db, ready, handle }) {
    /**
     * Save a Blueprint, or bump the version of the one with the same solution_key
     * in the same organisation.
     */
    async function saveBlueprint(opts = {}) {
        await ready();
        return _saveBlueprint(handle(null), opts);
    }

    /**
     * The statements of saveBlueprint, on a pool OR a transaction handle.
     * @param h
     * @param {{ organizationId?: string|null, createdBy?: string, sourceProjectId?: string|null, manifest?: any }} [opts]
     */
    async function _saveBlueprint(h, {
        organizationId = null, createdBy, sourceProjectId = null, manifest,
    } = {}) {
        if (!createdBy) throw new Error('createdBy is required');
        if (!manifest?.solution) throw new Error('manifest is required');
        assertManifestSize(manifest);

        const solutionKey = manifest.solution.key;
        // FOR UPDATE, and that is no ornament: the UPDATE below sets
        // `version = existing.version + 1` from a value that under READ COMMITTED
        // may already be stale. Two concurrent publications of the same project
        // by the same creator (two tabs, a repeated POST after a slow export,
        // the mobile client next to the web client) would otherwise both read
        // v2 and both write v3 — and then the history carries TWO v3 rows, one
        // of which records a version that was never installable. Exactly the
        // state the head of `publishRelease` forbids, and it also breaks the
        // invariant both prune guards lean on: (blueprint_id, version) is
        // exactly one release row.
        //
        // On the TRANSACTION HANDLE the row lock holds until COMMIT, so the
        // second publication reads on only once the first is done and counts on
        // from the new number. On the pool handle (`saveBlueprint`) this
        // statement runs in its own implicit transaction and the lock drops at
        // once — so nothing changes there, and that is exactly why publishing
        // belongs in `publishRelease` and not in `saveBlueprint`.
        //
        // NOT covered, and that is the honest limit: two FIRST publications at
        // the same time find no row, so there is nothing to lock. Then two
        // gallery rows appear, each with its own id and each v1 — annoying, but
        // (blueprint_id, version) does stay unique there, so the guards above
        // hold.
        const existing = await h.one(
            `SELECT id, version FROM project_blueprints
              WHERE solution_key = $1 AND created_by = $2
                AND (organization_id IS NOT DISTINCT FROM $3)
              FOR UPDATE`,
            [solutionKey, createdBy, organizationId],
        );

        if (existing) {
            const version = existing.version + 1;
            const bumped = { ...manifest, solution: { ...manifest.solution, version } };
            const row = await h.one(
                `UPDATE project_blueprints
                    SET manifest = $1, version = $2, name = $3, description = $4, icon = $5, updated_at = NOW()
                  WHERE id = $6 RETURNING *`,
                [JSON.stringify(bumped), version, manifest.solution.name || 'Solution',
                 manifest.solution.description || '', manifest.solution.icon || null, existing.id],
            );
            return mapRow(row);
        }

        const scope = organizationId
            ? await h.one(`SELECT COUNT(*)::int AS n FROM project_blueprints WHERE organization_id = $1`, [organizationId])
            : await h.one(`SELECT COUNT(*)::int AS n FROM project_blueprints WHERE created_by = $1 AND organization_id IS NULL`, [createdBy]);
        if ((scope?.n || 0) >= MAX_BLUEPRINTS_PER_ORG) {
            throw new Error(`There are already ${MAX_BLUEPRINTS_PER_ORG} Blueprints here. Delete one before saving another.`);
        }

        const row = await h.one(
            `INSERT INTO project_blueprints
                (id, organization_id, created_by, source_project_id, solution_key, name, description, icon, version, manifest)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [newId(), organizationId, createdBy, sourceProjectId, solutionKey,
             manifest.solution.name || 'Solution', manifest.solution.description || '',
             manifest.solution.icon || null, manifest.solution.version || 1, JSON.stringify(manifest)],
        );
        return mapRow(row);
    }

    /**
     * How often these Blueprints were installed ON THIS INSTANCE: here, and elsewhere.
     *
     * ── What these two numbers ARE ──────────────────────────────────────────
     *
     * Project rows in this database whose `installed_from_blueprint_id` is in
     * the given list, split by organisation: `here` is the Blueprint's own
     * organisation, `elsewhere` is everything else ON THIS INSTANCE. That second
     * number is the whole reason this function exists — a Blueprint is shared
     * with another team on purpose — and at the same time the only answer in
     * this store that looks across the org boundary. The partial index
     * `idx_projects_installed_from` (stores/projectStore.js) exists for it.
     *
     * ── The trap in the comparison ──────────────────────────────────────────
     *
     * `projects.organization_id` is `TEXT DEFAULT ''` (createProject writes
     * `organizationId || ''`), while `project_blueprints.organization_id` may be
     * NULL. A naive `=` between the two NEVER matches org-less rows, and then
     * every personal installation silently counts as "elsewhere". Hence an
     * explicit `COALESCE(..., '')` on both sides: empty and NULL are the same
     * thing here, namely "no organisation".
     *
     * ── What it is NOT, and why the screen must say so ──────────────────────
     *
     * A LOWER BOUND, never a total: another instance cannot see this database,
     * so whoever forwards the file to a self-host of their own is by definition
     * not counted here. The screen therefore says "at least n", never "n".
     *
     * ── Tenancy ─────────────────────────────────────────────────────────────
     *
     * THIS FUNCTION AUTHORISES NOTHING. It counts the ids it is given; the
     * caller must already have authorised them — same contract as `listStamps`,
     * `listInstalledVersions` and `listReleases`, and the same silent way to
     * break it. What it DOES guarantee is that nothing but two numbers can come
     * out: one COUNT row, no project id, no name, no owner, no organisation, no
     * timestamp. So there is no row to pass on by accident, and no column added
     * to `projects` next year can ride along. No breakdown PER organisation
     * either: at n=1 an aggregate over one organisation is no aggregate any more.
     *
     * `null` = unreadable. Zero installations is an answer; "the count failed"
     * is not, and the two must never look the same on any screen.
     *
     * @returns {Promise<{here:number, elsewhere:number}|null>}
     */
    async function countInstallsFor(blueprintIds, { organizationId = null } = {}) {
        await ready();
        const ids = (Array.isArray(blueprintIds) ? blueprintIds : [])
            .filter(id => typeof id === 'string' && id);
        // No Blueprint to count. Zero is an ANSWER here, not a gap: nobody can
        // have installed anything from an id that does not exist.
        if (!ids.length) return { here: 0, elsewhere: 0 };

        const row = await db.getOne(
            `SELECT COUNT(*) FILTER (WHERE COALESCE(organization_id, '') = COALESCE($2, ''))::int AS here,
                    COUNT(*) FILTER (WHERE COALESCE(organization_id, '') <> COALESCE($2, ''))::int AS elsewhere
               FROM projects
              WHERE installed_from_blueprint_id = ANY($1::text[])`,
            [ids, organizationId || ''],
        );
        // NO bare `Number(row?.here)`: that turns a missing row and NULL both
        // into a tidy 0, and then "nobody installed this" can no longer be told
        // apart from "the count did not come back".
        const here = asCount(row?.here);
        const elsewhere = asCount(row?.elsewhere);
        return here === null || elsewhere === null ? null : { here, elsewhere };
    }

    /**
     * Blueprints this caller may install — meta only, never the manifests.
     * @param {{ userId?: string, organizationId?: string|null }} [opts]
     */
    async function listBlueprintsFor({ userId, organizationId = null } = {}) {
        await ready();
        const rows = await db.getAll(
            // META_COLUMNS and not `*`. `mapRow(..., { includeManifest: false })`
            // threw the manifest away afterwards anyway, so every reader — the
            // gallery, the access question, the install counter — pulled up to a
            // hundred JSONB blobs of up to MAX_BLUEPRINT_BYTES each through the
            // pool and the heap only to discard them. The column list is the same
            // decision one layer down.
            `SELECT ${META_COLUMNS} FROM project_blueprints
              WHERE (organization_id IS NOT NULL AND organization_id = $2)
                 OR (organization_id IS NULL AND created_by = $1)
              ORDER BY updated_at DESC`,
            [userId, organizationId],
        );
        return rows.map(r => mapRow(r, { includeManifest: false }));
    }

    async function getBlueprintById(id, { includeManifest = true } = {}) {
        await ready();
        const row = await db.getOne(
            `SELECT ${includeManifest ? '*' : META_COLUMNS} FROM project_blueprints WHERE id = $1`,
            [id],
        );
        return mapRow(row, { includeManifest });
    }

    async function deleteBlueprint(id, userId) {
        await ready();
        const { rowCount } = await db.run(
            `DELETE FROM project_blueprints WHERE id = $1 AND created_by = $2`, [id, userId],
        );
        return rowCount > 0;
    }

    return {
        saveBlueprint,
        _saveBlueprint,
        listBlueprintsFor,
        getBlueprintById,
        countInstallsFor,
        deleteBlueprint,
    };
}

module.exports = { makeGalleryStore };
