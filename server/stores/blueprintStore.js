// @typecheck
/**
 * Blueprint Store — Blueprints captured from a live Solution.
 *
 * The other half of packaging. A Blueprint can always be downloaded as a file
 * and handed to someone; this table is for the case where it should not have to
 * leave the instance at all — one team packages a Solution and another team in
 * the same organisation installs it, without a file passing through anybody's
 * downloads folder.
 *
 * Mirrors studioAppTemplateStore one level up: same visibility rule, same
 * per-org ceiling, same version-bump-on-re-save. Ids are prefixed `bp_`, so
 * provenance is unambiguous in a log line and in a project's stamp.
 *
 * VISIBILITY is the organisation. A Blueprint belongs to the org of the project
 * it came from, and any member of that org may install it. One captured from a
 * project with no organisation is private to its creator.
 *
 * VERSIONS. Re-saving under the same `solution_key` bumps the version rather
 * than silently overwriting, because installed Solutions carry the version they
 * came from and an upgrade path needs to be able to tell "newer" from
 * "different". Same contract captured app templates already have.
 *
 * THE CEILING is explicit and its message names the offender. "The Blueprint is
 * 6 MB" is not actionable; "the orders app is 5 MB of it" is — and a Solution
 * is N apps plus N automations plus webpage sources, so it reaches a ceiling far
 * more easily than a single app ever did.
 *
 * ── RELEASES (O4) ──────────────────────────────────────────────────────────
 *
 * `project_blueprints` holds ONE row per (solution_key, created_by, org) and
 * that row is OVERWRITTEN on every re-save. It is therefore a statement about
 * the present — "this is what the gallery serves today" — and it cannot answer
 * "what was v3". `project_releases` is the history: one immutable row per
 * publication, carrying the manifest as published and the note that went with
 * it. See `publishRelease` for why the two are written in ONE transaction, and
 * `_pruneReleases` for what the retention cap is not allowed to eat.
 *
 * ── PIPELINE RELEASES AND THE REF LEDGER (Solution stages) ─────────────────
 *
 * A release row has a `channel`. 'gallery' is the O4 history above. 'pipeline'
 * is a numbered capture of a Solution's Dev working copies (`seq` 1..n, with
 * `version = seq`) that a UAT/PRD stage deploys; it never has a gallery row
 * (`blueprint_id` NULL), never leaves the instance, and is pruned on its own
 * cap with its own guards (`_prunePipelineReleases`). Content that must never
 * ride in a manifest (reference rows, the KB document listing) is stored next
 * to it in `solution_release_payloads` and is deleted with it.
 *
 * `solution_part_refs` is the ledger that makes a ref stable: a Dev part keeps
 * its ref across captures, a part that left the Solution is retired, and a ref
 * is never handed out twice (`allocateRefs`).
 *
 * The functions are built by `makeBlueprintStore(db, { ready })` over a facade
 * with db.js's shape (`run`, `getOne`, `getAll`, `withTransaction`), so a test
 * runs them against pglite without replacing any module. The module's own
 * exports are the default instance over db.js behind the schema init.
 *
 * LAYOUT. This file composes the store; the parts live in stores/blueprint/:
 *   constants.js  ceilings, channels, payload kinds, ref patterns
 *   schema.js     applyBlueprintSchema and the init over a facade
 *   mappers.js    ids, row mappers, normalisers, canRead, the query handle
 *   gallery.js    save/list/read/delete Blueprints, countInstallsFor
 *   releases.js   gallery history and pipeline releases, with their prunes
 *   installs.js   the ref ledger and the install stamps
 * Each part is a `make…Store(ctx)` factory over the context built below.
 */

'use strict';

const dbFacade = require('../db');
const {
    MAX_BLUEPRINT_BYTES,
    MAX_BLUEPRINTS_PER_ORG,
    MAX_RELEASES_PER_PROJECT,
    MAX_PIPELINE_RELEASES_PER_PROJECT,
    MAX_NOTES_BYTES,
    MAX_RELEASE_PAYLOAD_BYTES,
    RELEASE_PAYLOAD_KINDS,
} = require('./blueprint/constants');
const { applyBlueprintSchema, makeBlueprintInit } = require('./blueprint/schema');
const { clientHandle, canRead, isBlueprintId, largestEntity } = require('./blueprint/mappers');
const { makeGalleryStore } = require('./blueprint/gallery');
const { makeReleasesStore } = require('./blueprint/releases');
const { makeInstallsStore } = require('./blueprint/installs');

const initDB = makeBlueprintInit(dbFacade);

/**
 * The store's functions over one database facade.
 *
 * @param {{
 *   run: (sql: string, params?: any[]) => Promise<any>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   withTransaction: (fn: (client: any) => Promise<any>) => Promise<any>,
 * }} db  db.js, or a facade of the same shape (pglite in the store test)
 * @param {{ ready?: () => Promise<unknown> }} [opts]  the schema init every function awaits first
 */
function makeBlueprintStore(db, { ready = async () => {} } = {}) {
    const poolHandle = {
        one: (sql, params) => db.getOne(sql, params),
        all: (sql, params) => db.getAll(sql, params),
        run: (sql, params) => db.run(sql, params),
    };
    /** The pool, or the client of a running transaction. */
    const handle = (client) => (client ? clientHandle(client) : poolHandle);
    /** Run `fn(h)` on the caller's client, or in a transaction of its own. */
    const inTransaction = (client, fn) => (client
        ? fn(clientHandle(client))
        : db.withTransaction((c) => fn(clientHandle(c))));

    const ctx = { db, ready, handle, inTransaction };
    const gallery = makeGalleryStore(ctx);
    const releases = makeReleasesStore({ ...ctx, _saveBlueprint: gallery._saveBlueprint });
    const installs = makeInstallsStore(ctx);

    return {
        saveBlueprint: gallery.saveBlueprint,
        publishRelease: releases.publishRelease,
        listReleases: releases.listReleases,
        getRelease: releases.getRelease,
        cutPipelineRelease: releases.cutPipelineRelease,
        listPipelineReleases: releases.listPipelineReleases,
        getReleasePayloads: releases.getReleasePayloads,
        allocateRefs: installs.allocateRefs,
        refsFor: installs.refsFor,
        listBlueprintsFor: gallery.listBlueprintsFor,
        getBlueprintById: gallery.getBlueprintById,
        countInstallsFor: gallery.countInstallsFor,
        deleteBlueprint: gallery.deleteBlueprint,
        stampEntity: installs.stampEntity,
        upsertStamp: installs.upsertStamp,
        listStamps: installs.listStamps,
        listInstalledVersions: installs.listInstalledVersions,
    };
}

// The instance the app uses: db.js, behind the store's schema init.
const defaultStore = makeBlueprintStore(dbFacade, { ready: initDB });

module.exports = {
    initDB,
    applyBlueprintSchema,
    makeBlueprintStore,
    ...defaultStore,
    canRead,
    isBlueprintId,
    largestEntity,
    MAX_BLUEPRINT_BYTES,
    MAX_BLUEPRINTS_PER_ORG,
    MAX_RELEASES_PER_PROJECT,
    MAX_PIPELINE_RELEASES_PER_PROJECT,
    MAX_NOTES_BYTES,
    MAX_RELEASE_PAYLOAD_BYTES,
    RELEASE_PAYLOAD_KINDS,
};
