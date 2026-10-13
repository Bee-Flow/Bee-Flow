// @typecheck
/**
 * Blueprint store schema: the DDL of project_blueprints,
 * project_solution_entities, project_releases, solution_part_refs and
 * solution_release_payloads, and the one-shot init that runs it.
 *
 * The init is built by the store (`makeBlueprintInit(dbFacade)`), which owns
 * the one instance; this module holds no state of its own.
 */

'use strict';

const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');

/**
 * The whole schema, as boot runs it: the base batch through `exec`, then the
 * ladder through `runDdl`. Both runners are parameters so the pglite test
 * applies exactly these statements instead of a copy that could drift.
 *
 * @param {{ exec: (sql: string) => Promise<unknown>, runDdl: (tag: string, statements: any[]) => Promise<unknown> }} runners
 */
async function applyBlueprintSchema({ exec, runDdl }) {

    await exec(`
        CREATE TABLE IF NOT EXISTS project_blueprints (
            id TEXT PRIMARY KEY,
            organization_id TEXT,
            created_by TEXT NOT NULL,
            source_project_id TEXT,
            solution_key TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            icon TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            manifest JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_project_blueprints_org
            ON project_blueprints(organization_id) WHERE organization_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_project_blueprints_creator
            ON project_blueprints(created_by);
        CREATE INDEX IF NOT EXISTS idx_project_blueprints_key
            ON project_blueprints(solution_key);

        -- What an installed Solution was made of, and what each entity looked
        -- like the moment it was installed.
        --
        -- PER ENTITY, not per project, and that is the whole point: upgrade
        -- replaces the entities nobody has touched and leaves the ones somebody
        -- has, so it has to be able to tell them apart one at a time. A single
        -- project-level hash would mean one hand-edited app freezes the whole
        -- Solution.
        CREATE TABLE IF NOT EXISTS project_solution_entities (
            project_id TEXT NOT NULL,
            ref TEXT NOT NULL,
            kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            install_hash TEXT NOT NULL,
            installed_version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (project_id, ref)
        );
        CREATE INDEX IF NOT EXISTS idx_project_solution_entities_project
            ON project_solution_entities(project_id);
    `);

    // ── A project's release history ──────────────────────────────────────────
    //
    // Through runDdl (stores/lib/_ddl.js) and not in the `exec()` above: those
    // two tables predate U5, a NEW table belongs in the loud ladder. One failing
    // statement is recorded there instead of tripping the whole init, and a
    // statement timeout no longer reads as "already existed".
    //
    // SOFT REFERENCES, no FK — in both directions and for the same reason as
    // `projects.installed_from_blueprint_id`:
    //   - `project_id` points at a project that may be deleted. The history of
    //     what was ever published is not owned by that project alone;
    //     installations elsewhere live on from it.
    //   - `blueprint_id` points at a gallery row its creator may throw away. A
    //     deleted Blueprint must NOT take the history with it: the row carries
    //     its own manifest, so "what was v3" stays answerable, and the dangling
    //     id reads as UNKNOWN — never as "still in the gallery".
    //
    // `version` is the version number of the Blueprint series this publication
    // landed in, and that series runs per (solution_key, created_by, org). Two
    // creators publishing the same project therefore each have their own v2 —
    // which is why (project_id, version) is NOT unique and the row carries
    // `published_by` and `blueprint_id` to tell them apart.
    //
    // The index carries the full sort key of the listing and of the prune
    // (`published_at DESC, id`), so both run on one index.
    //
    // Solution stages (design 1.1 B): the ref ledger, the pipeline columns on
    // the release table (a pipeline row has no gallery row, hence blueprint_id
    // may be NULL), the stage columns on the stamps, and the payload table for
    // content that must never ride in a manifest (D20). No `desired_active`:
    // a deploy never changes whether an existing part runs (D22).
    await runDdl('blueprintStore', [
        `CREATE TABLE IF NOT EXISTS project_releases (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            blueprint_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            manifest JSONB NOT NULL,
            notes JSONB NOT NULL DEFAULT '{}'::jsonb,
            published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            published_by TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_project_releases_project
            ON project_releases(project_id, published_at DESC, id)`,
        `CREATE INDEX IF NOT EXISTS idx_project_releases_blueprint
            ON project_releases(blueprint_id, version)`,

        `CREATE TABLE IF NOT EXISTS solution_part_refs (
            solution_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            ref TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            retired_at TIMESTAMPTZ,
            PRIMARY KEY (solution_id, kind, entity_id)
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_solution_part_refs_ref
            ON solution_part_refs(solution_id, ref)`,

        `ALTER TABLE project_releases ALTER COLUMN blueprint_id DROP NOT NULL`,
        `ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS seq INTEGER`,
        `ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'gallery'
            CONSTRAINT project_releases_channel_chk CHECK (channel IN ('gallery','pipeline'))`,
        `ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS content_hash TEXT`,
        `ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS gate JSONB`,
        `ALTER TABLE project_releases ADD COLUMN IF NOT EXISTS source_cut JSONB`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_releases_seq
            ON project_releases(project_id, seq) WHERE seq IS NOT NULL`,

        `ALTER TABLE project_solution_entities ADD COLUMN IF NOT EXISTS release_id TEXT`,
        `ALTER TABLE project_solution_entities ADD COLUMN IF NOT EXISTS source_hash TEXT`,
        `ALTER TABLE project_solution_entities ADD COLUMN IF NOT EXISTS step_id_map JSONB`,
        `ALTER TABLE project_solution_entities ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ`,
        `ALTER TABLE project_solution_entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,

        `CREATE TABLE IF NOT EXISTS solution_release_payloads (
            release_id TEXT NOT NULL,
            ref TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('reference_rows','knowledge_listing')),
            source_entity_id TEXT NOT NULL,
            payload JSONB NOT NULL,
            content_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (release_id, ref, kind)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_solution_release_payloads_source
            ON solution_release_payloads(source_entity_id)`,
    ]);
}

/**
 * The store's schema init over a db.js-shaped facade: `applyBlueprintSchema`
 * with the facade's `exec` and the loud `runDdl` ladder, run once.
 * @param {{ exec: (sql: string) => Promise<unknown> }} dbFacade
 */
function makeBlueprintInit(dbFacade) {
    return makeStoreInit('BlueprintStore', () => applyBlueprintSchema({
        exec: (sql) => dbFacade.exec(sql),
        runDdl,
    }));
}

module.exports = { applyBlueprintSchema, makeBlueprintInit };
