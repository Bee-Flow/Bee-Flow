// @typecheck
/**
 * Blueprint releases: the gallery history (`publishRelease`, `listReleases`,
 * `getRelease`, with its prune) and the pipeline releases of Solution stages
 * (`cutPipelineRelease`, `listPipelineReleases`, `getReleasePayloads`, with
 * their own prune). Built by `makeReleasesStore(ctx)` over the context
 * `makeBlueprintStore` builds, plus the gallery's `_saveBlueprint`.
 */

'use strict';

const {
    MAX_RELEASES_PER_PROJECT,
    RELEASE_CHANNELS,
} = require('./constants');
const {
    newReleaseId,
    clientHandle,
    normalizeNotes,
    mapReleaseRow,
} = require('./mappers');
const { makePipelineReleasesStore } = require('./pipelineReleases');

/** Write one gallery release row, inside the caller's handle. */
async function _insertRelease(h, { projectId, blueprintId, version, manifest, notes, publishedBy }) {
    // RETURNING without the manifest: it was just written and the caller
    // already has it; dragging it back through the driver is pure transfer.
    const row = await h.one(
        `INSERT INTO project_releases
            (id, project_id, blueprint_id, version, manifest, notes, published_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, project_id, blueprint_id, version, notes, published_at, published_by`,
        [newReleaseId(), projectId, blueprintId, version,
         JSON.stringify(manifest ?? {}), JSON.stringify(notes ?? {}), publishedBy],
    );
    return mapReleaseRow(row);
}

/**
 * Prune this project's gallery history back to the newest twenty.
 *
 * THREE things hold this query together, and each closes a way the prune
 * could remove a row something points at:
 *
 *   1. `, id` AS THE TIEBREAKER. `published_at` defaults to NOW(), which in
 *      Postgres is TRANSACTION time: rows written in one transaction carry the
 *      same timestamp and their relative order is undefined. OFFSET over an
 *      unstable sort drops an arbitrary row at each n, not necessarily the
 *      oldest. Same reason, same fix as webpage/versions.js and
 *      studioAppStore.writeVersionSnapshot.
 *   2. WHAT AN INSTALL POINTS AT. An install points at the Blueprint with
 *      `projects.installed_from_blueprint_id` and at the number it carries
 *      with `project_solution_entities.installed_version`; together those two
 *      are exactly one release row. Such a row does not count against the cap
 *      and is never deleted. THIS IS NOT THEORY: publishing 25 times while
 *      someone stays on v1 pushes v1 out of the window of the newest twenty,
 *      and then the very install that most needs an answer ("what is v1, and
 *      what changed since") could no longer get one. A partly updated install
 *      holds both numbers, by the way: every stamp pins its own release row,
 *      so also the v3 row of the one app that was never replaced.
 *
 *      ONLY INSTALLS IN THE SOURCE'S ORGANISATION HOLD ROWS, and that is a
 *      deliberate narrowing. Reason 1, who can reach the row: a release row
 *      only leaves through `listReleases`/`getRelease`, which sit behind
 *      `requireProjectRole('owner')` on the SOURCE project; fetching a
 *      Blueprint by id (the upgrade) goes through `canRead`, which is
 *      org-scoped. An install outside that organisation can therefore read the
 *      row it would hold through no door at all; it would freeze a manifest of
 *      up to MAX_BLUEPRINT_BYTES that nobody can fetch. Reason 2, who decides
 *      the input: on a file install both the claimed Blueprint id and
 *      `installed_version` come from a file the installer edits. Without this
 *      narrowing, one forwarded file could switch off another project's cap by
 *      creating installs that claim versions 21..300, and the source
 *      organisation would have no button to remove those foreign "installs".
 *      Such installs still COUNT (`countInstallsFor` splits exactly on that
 *      line); they do not freeze another organisation's history.
 *   3. WHAT THE GALLERY SERVES NOW. `project_blueprints.version` is the number
 *      installable today; that row may never go, or the gallery serves a
 *      version that does not exist in the history. Also reachable and not
 *      theoretical: the series runs per maker, so twenty publishes by
 *      colleague B push colleague A's current v3 out of the window while A's
 *      Blueprint still offers it.
 *
 * The held rows sit OUTSIDE the candidate list and so do not count against the
 * twenty: the same choice as `source <> 'published'` in W2. The table may grow
 * beyond the cap because of that; that is the safe side, bounded by the number
 * of installs and never at the cost of a row something points at.
 *
 * WHAT GUARD 2 CANNOT SEE, and that is the honest limit: stamping is
 * best-effort (install.js says so in as many words), so there are installs
 * that point at the Blueprint with `installed_from_blueprint_id` and carry no
 * stamp at all. For such an install it cannot be established which version it
 * is on, so it holds no row either. That is the narrow side: holding the whole
 * history because one install could not stamp would switch the cap off for
 * good, and that install cannot be updated anyway, because the upgrade runs on
 * stamps too.
 *
 * THE CHANNEL. `AND r.channel = 'gallery'`: a pipeline row has no
 * `blueprint_id`, so both NOT EXISTS guards are true for it, and without this
 * condition one gallery publish would prune the releases a UAT or PRD stage
 * runs on. `_prunePipelineReleases` prunes pipeline rows, with guards of its
 * own.
 *
 * TENANCY. This query READS `projects` but returns nothing of it: the result is
 * a list of ids of this project's release rows, and that list goes to a
 * DELETE, not to a caller. No project name, no owner, no org: no payload is
 * created here that could leak. `projects` is another store's table;
 * publishing always follows a project lookup, so it exists. Should it ever not
 * exist, this statement fails loudly and the publish rolls back: never a quiet
 * prune without guard 2.
 *
 * Only ids come back, so a caller that wants to know what went can see it
 * without the rows themselves travelling any further.
 */
async function _pruneReleases(h, projectId) {
    const doomed = await h.all(
        `SELECT id FROM project_releases r
          WHERE r.project_id = $1
            AND NOT EXISTS (
                SELECT 1 FROM project_blueprints b
                 WHERE b.id = r.blueprint_id AND b.version = r.version)
            AND NOT EXISTS (
                SELECT 1 FROM projects p
                  JOIN project_solution_entities e ON e.project_id = p.id
                  JOIN projects src ON src.id = r.project_id
                 WHERE p.installed_from_blueprint_id = r.blueprint_id
                   AND e.installed_version = r.version
                   AND COALESCE(p.organization_id, '') = COALESCE(src.organization_id, ''))
            AND r.channel = 'gallery'
          ORDER BY r.published_at DESC, r.id
          OFFSET $2`,
        [projectId, MAX_RELEASES_PER_PROJECT],
    );
    const ids = (doomed || []).map(r => r?.id).filter(id => typeof id === 'string' && id);
    if (!ids.length) return [];
    // Only the ids this query returned. A DELETE with a predicate of its own
    // ("everything older than") would bypass the three guards above.
    await h.run(`DELETE FROM project_releases WHERE id = ANY($1::text[])`, [ids]);
    return ids;
}

/**
 * @param {import('./mappers').BlueprintStoreCtx & {
 *   _saveBlueprint: (h: import('./mappers').QueryHandle, opts: any) => Promise<any>,
 * }} ctx
 */
function makeReleasesStore({ db, ready, handle, inTransaction, _saveBlueprint }) {
    // ── Publiceren: één galerijrij én één release-rij ────────────────────────

    /**
     * Publish this project: store (or bump) the Blueprint in the gallery AND record
     * the publication in the history. Together, or neither.
     *
     * ── THE ORDER, AND WHICH SIDE WINS ─────────────────────────────────────
     *
     * The order WITHIN the transaction is fixed and is not the interesting question:
     * the release row carries `blueprint_id` and the definitive version number, so the
     * gallery row must be written first. The interesting question is what
     * happens if the second write fails, and there THE RELEASE ROW WINS: then
     * nothing has been published — no Blueprint, and no consumed version number.
     *
     * Why that side, and not "the Blueprint is at least there":
     *
     *   1. THE SAME SHAPE AS THE W2 FINDING. There the visibility flag was set before
     *      the pin, and a failed publication served unpublished work. Here the
     *      gallery row is the visibility — it is installable by the whole
     *      org at once — and the release row is the pin: the recorded "this is what v3
     *      was". Visible without a pin is exactly the state that was wrong there.
     *   2. THE BUMP CONSUMES A NUMBER. If the UPDATE succeeds and the release row fails,
     *      then the gallery serves v3 while the history stops at v2 and the
     *      next publication becomes v4. v3 then exists forever as the version that
     *      nobody can find — and installations carry that number in their stamps, so it is
     *      not just a gap in a list.
     *   3. THE REVERSE FAILURE cannot occur with this order: a release row that
     *      points to a Blueprint that does not exist cannot arise, because the id only
     *      exists after the INSERT/UPDATE has succeeded — and both commit
     *      together. Without a transaction exactly that side would be irreparable: a
     *      loose release row then refers to an id that never existed.
     *
     * That is why the whole thing runs in ONE transaction, with exactly the same statements as
     * `saveBlueprint` (see `handle`) — a second copy of the bump logic would be
     * precisely what drifts out of step here.
     *
     * THE PRUNING IS DELIBERATELY IN IT. Publishing is one act: a history that grows
     * beyond its cap because the DELETE silently failed is the same half-finished
     * state as a Blueprint without a release row. A gallery publication prunes only the gallery
     * channel; pipeline rows have their own cap and their own guarantees.
     *
     * @returns {Promise<{blueprint: any, release: any}>}
     * @param {{ organizationId?: string|null, createdBy?: string, sourceProjectId?: string, manifest?: any, notes?: any }} [opts]
     */
    async function publishRelease({
        organizationId = null, createdBy, sourceProjectId, manifest, notes = null,
    } = {}) {
        await ready();
        // Refused BEFORE the transaction, so before any write: a publication
        // without a project has no history to be recorded in, and saving a Blueprint that
        // does not end up there is exactly what is forbidden above.
        if (!sourceProjectId) throw new Error('sourceProjectId is required to publish a release');
        if (!createdBy) throw new Error('createdBy is required');
        if (!manifest?.solution) throw new Error('manifest is required');
        // Also before the transaction: a note that cannot be stored must not
        // leave behind a half publication, and the refusal must be actionable.
        const safeNotes = normalizeNotes(notes);

        return db.withTransaction(async (client) => {
            const h = clientHandle(client);
            const blueprint = await _saveBlueprint(h, { organizationId, createdBy, sourceProjectId, manifest });
            // NO ROW BACK = there is no gallery row. Reachable: only the creator
            // may delete, and they may do so while a colleague is publishing —
            // then the lookup still finds a row and the UPDATE touches zero. Were the
            // release row then written anyway, it would point to a
            // Blueprint that does not exist; exactly the other half of the promise
            // above. So abort, and the whole publication rolls back.
            if (!blueprint?.id) throw new Error('The Blueprint could not be saved, so nothing was published.');
            const release = await _insertRelease(h, {
                projectId: sourceProjectId,
                blueprintId: blueprint.id,
                // The number that the gallery serves AFTER this publication — the same
                // number that installations carry in their stamps.
                version: blueprint.version,
                // The manifest AS STORED: on the bump path `solution.version` has been
                // rewritten, and the history must record what was actually
                // published, not what the caller offered.
                manifest: blueprint.manifest,
                notes: safeNotes,
                publishedBy: createdBy,
            });
            await _pruneReleases(h, sourceProjectId);
            return { blueprint, release };
        });
    }

    /**
     * The publication history of one project, newest first — without manifest.
     *
     * THIS FUNCTION AUTHORISES NOTHING. It scopes only on the project id it receives,
     * nothing more; the caller must already have authorised that id (in the
     * packaging router that is `requireProjectRole('owner')`). Same contract as
     * `listStamps` and `listInstalledVersions`, and the same silent way to
     * break it: a new caller that throws in an id it did not check.
     *
     * One channel at a time, 'gallery' by default, so the Versions tab and the
     * installs counter never see a pipeline row (`listPipelineReleases` is the
     * reader for those).
     */
    async function listReleases(projectId, { limit = MAX_RELEASES_PER_PROJECT, channel = 'gallery' } = {}) {
        await ready();
        if (!RELEASE_CHANNELS.includes(channel)) throw new TypeError(`Unknown release channel '${channel}'`);
        if (typeof projectId !== 'string' || !projectId) return [];
        const asked = Number(limit);
        const capped = Math.min(Number.isFinite(asked) && asked > 0 ? Math.trunc(asked) : MAX_RELEASES_PER_PROJECT,
            MAX_RELEASES_PER_PROJECT);
        const rows = await db.getAll(
            `SELECT id, project_id, blueprint_id, version, notes, published_at, published_by
               FROM project_releases
              WHERE project_id = $1 AND channel = $3
              ORDER BY published_at DESC, id
              LIMIT $2`,
            [projectId, capped, channel],
        );
        return (rows || []).map(r => mapReleaseRow(r));
    }

    /**
     * One release, with the manifest as it was published, and with its
     * stage fields (seq, channel, gate, contentHash).
     *
     * ALWAYS on (project, id) and never on id alone: the id is the key, but the project is the
     * scope that the caller has authorised. A lookup on id alone would answer a
     * guessed id from a DIFFERENT project.
     */
    async function getRelease(projectId, releaseId, { client = null } = {}) {
        await ready();
        if (typeof projectId !== 'string' || !projectId) return null;
        if (typeof releaseId !== 'string' || !releaseId) return null;
        const row = await handle(client).one(
            `SELECT id, project_id, blueprint_id, version, manifest, notes, published_at, published_by,
                    seq, channel, gate, content_hash
               FROM project_releases
              WHERE id = $1 AND project_id = $2`,
            [releaseId, projectId],
        );
        return mapReleaseRow(row, { includeManifest: true, withPipeline: true });
    }

    return {
        publishRelease,
        listReleases,
        getRelease,
        // Pipeline releases of Solution stages (./pipelineReleases.js).
        ...makePipelineReleasesStore({ ready, handle, inTransaction }),
    };
}

module.exports = { makeReleasesStore };
