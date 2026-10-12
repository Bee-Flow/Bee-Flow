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
 */

'use strict';

const crypto = require('crypto');
const dbFacade = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');

// A Solution is many entities, so this is deliberately larger than one app's
// 4 MB — but bounded, because an unbounded table of multi-megabyte JSONB blobs
// is a storage problem whatever it contains.
const MAX_BLUEPRINT_BYTES = 16 * 1024 * 1024;

// A gallery is a place you choose from. A few hundred entries is a search
// problem, not a gallery.
const MAX_BLUEPRINTS_PER_ORG = 100;

// Hoeveel publicaties per project bewaard blijven. Elke rij draagt een volledig
// manifest, dus de geschiedenis is duur; twintig is genoeg om terug te kijken
// en klein genoeg om te bewaren. LET OP: dit is een cap op de rijen die NIETS
// vasthoudt — zie `_pruneReleases`, dat de vastgehouden rijen buiten de telling
// laat en de tabel dus bewust groter laat worden dan 20.
const MAX_RELEASES_PER_PROJECT = 20;

// Pipeline releases are cut far more often than gallery publications (every
// "send to UAT"), so their own, larger cap. Same rule as above: rows a stage or
// a deployment still points at are outside the count.
const MAX_PIPELINE_RELEASES_PER_PROJECT = 50;

// The most pipeline releases one listing returns; the table may hold more than
// the cap because held rows are never pruned.
const MAX_LISTED_PIPELINE_RELEASES = 200;

// Een releasenotitie is een notitie, geen bijlage. Het manifest heeft zijn eigen
// (veel ruimere) plafond; zonder een eigen grens zou een notitie dat plafond
// kunnen omzeilen door in dezelfde rij mee te liften.
const MAX_NOTES_BYTES = 64 * 1024;

// All payloads of one pipeline release together (reference rows are capped at
// 8 MB per release upstream; the KB listings are small). The store's own bound,
// so no caller can turn this table into a blob store.
const MAX_RELEASE_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** What `solution_release_payloads` may hold (D20). Mirrors the table's CHECK. */
const RELEASE_PAYLOAD_KINDS = Object.freeze(['reference_rows', 'knowledge_listing']);

const RELEASE_CHANNELS = Object.freeze(['gallery', 'pipeline']);

// A deployment in one of these states no longer needs its release row for
// itself. Everything else (including a status added later) holds the row.
const TERMINAL_DEPLOYMENT_STATUSES = Object.freeze([
    'rejected', 'succeeded', 'succeeded_with_warnings', 'failed', 'cancelled',
]);
const SUCCEEDED_DEPLOYMENT_STATUSES = Object.freeze(['succeeded', 'succeeded_with_warnings']);

// Ref prefixes the ledger knows on its own: a connection is a binding slot, not
// a manifest entity kind, so no caller's prefix table carries it.
const BUILTIN_REF_PREFIX = Object.freeze({ connection: 'cn' });
const REF_PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const REF_RE = /^([a-z][a-z0-9]{0,15})_(\d+)$/;

const MAX_REQUEST_KEY_LENGTH = 200;

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

    // ── De releasegeschiedenis van een project ──────────────────────────────
    //
    // Via runDdl (stores/lib/_ddl.js) en niet in de `exec()` hierboven: die twee
    // tabellen dateren van vóór U5, een NIEUWE tabel hoort in de luide ladder.
    // Eén falend statement wordt daar genoteerd in plaats van de hele init te
    // laten struikelen, en een statement-timeout leest niet meer als "bestond al".
    //
    // ZACHTE VERWIJZINGEN, geen FK — beide kanten op en om dezelfde reden als
    // `projects.installed_from_blueprint_id`:
    //   - `project_id` wijst naar een project dat verwijderd mag worden. De
    //     geschiedenis van wat er ooit gepubliceerd is, is geen bezit van dat
    //     project alleen; installaties elders leven ervan verder.
    //   - `blueprint_id` wijst naar een galerijrij die zijn maker mag
    //     weggooien. Een verwijderde Blueprint moet de geschiedenis NIET
    //     meenemen: de rij draagt zijn eigen manifest, dus "wat was v3" blijft
    //     beantwoordbaar, en het dangling id leest als ONBEKEND — nooit als
    //     "staat nog in de galerij".
    //
    // `version` is het versienummer van de Blueprint-serie waar deze publicatie
    // in landde, en die serie loopt per (solution_key, created_by, org). Twee
    // makers die hetzelfde project publiceren hebben dus elk hun eigen v2 —
    // daarom is (project_id, version) NIET uniek en draagt de rij `published_by`
    // en `blueprint_id` om ze uit elkaar te houden.
    //
    // De index draagt de volledige sorteersleutel van de lijst én van het
    // snoeien (`published_at DESC, id`), zodat beide op één index lopen.
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

const initDB = makeStoreInit('BlueprintStore', () => applyBlueprintSchema({
    exec: (sql) => dbFacade.exec(sql),
    runDdl,
}));

function newId() { return `bp_${crypto.randomBytes(8).toString('hex')}`; }
function newReleaseId() { return `rel_${crypto.randomBytes(8).toString('hex')}`; }

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An error a route may pass on: status, code, and a message written for people. */
function storeError(status, code, message) {
    return Object.assign(new Error(message), { status, code, expose: true });
}

/**
 * Eén queryhandvat over de client van een lopende transactie.
 *
 * Bestaat zodat `saveBlueprint` en `publishRelease` LETTERLIJK dezelfde
 * statements draaien. Een tweede kopie van de bump-logica die "ook even" in een
 * transactie past, is een tweede kopie die uit de pas gaat lopen — en juist
 * daar mag hij dat niet, want dan verschilt het versienummer dat de galerij
 * serveert van het versienummer dat de geschiedenis noteert. Het poolhandvat
 * bouwt de factory (`handle` in `makeBlueprintStore`).
 * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} client
 */
function clientHandle(client) {
    return {
        one: async (sql, params) => (await client.query(sql, params)).rows?.[0] || null,
        all: async (sql, params) => (await client.query(sql, params)).rows || [],
        run: async (sql, params) => {
            const r = await client.query(sql, params);
            return { rowCount: r?.rowCount ?? 0 };
        },
    };
}

/** True for an id this store owns. */
function isBlueprintId(id) { return typeof id === 'string' && id.startsWith('bp_'); }

function mapRow(row, { includeManifest = true } = {}) {
    if (!row) return null;
    const meta = {
        id: row.id,
        solutionKey: row.solution_key,
        version: Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
        name: row.name,
        description: row.description || '',
        icon: row.icon || null,
        createdBy: row.created_by,
        sourceProjectId: row.source_project_id || null,
        organizationId: row.organization_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (!includeManifest) return meta;
    return { ...meta, manifest: row.manifest || null };
}

/**
 * Which entity is the fat one.
 *
 * Reported rather than guessed at: the point of a size refusal is that someone
 * can act on it, and "deselect a table on the orders app" is an action where
 * "make it smaller" is not.
 */
function largestEntity(manifest) {
    const entities = manifest?.solution?.entities || {};
    let worst = null;
    for (const [kind, list] of Object.entries(entities)) {
        for (const entity of (Array.isArray(list) ? list : [])) {
            const bytes = Buffer.byteLength(JSON.stringify(entity), 'utf8');
            if (!worst || bytes > worst.bytes) {
                worst = { kind, bytes, name: entity.name || entity.title || entity.ref };
            }
        }
    }
    return worst;
}

/** Refuse a manifest over the ceiling, naming its largest part. */
function assertManifestSize(manifest) {
    const bytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
    if (bytes <= MAX_BLUEPRINT_BYTES) return;
    const worst = largestEntity(manifest);
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    throw new Error(
        worst
            ? `This Blueprint is ${mb(bytes)}, over the ${mb(MAX_BLUEPRINT_BYTES)} limit. The largest part is the ${worst.kind.replace(/s$/, '')} "${worst.name}" at ${mb(worst.bytes)}.`
            : `This Blueprint is ${mb(bytes)}, over the ${mb(MAX_BLUEPRINT_BYTES)} limit.`,
    );
}

/** Een notitie is een notitie: een plat object, en begrensd. */
function normalizeNotes(notes) {
    if (notes == null) return {};
    if (typeof notes !== 'object' || Array.isArray(notes)) {
        throw new Error('Release notes must be an object.');
    }
    let json;
    try { json = JSON.stringify(notes); } catch (_) { json = undefined; }
    if (typeof json !== 'string') throw new Error('Release notes must be plain JSON.');
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_NOTES_BYTES) {
        const kb = (n) => `${Math.round(n / 1024)} KB`;
        throw new Error(`These release notes are ${kb(bytes)}, over the ${kb(MAX_NOTES_BYTES)} limit. Shorten the note — the Blueprint itself is stored separately.`);
    }
    return notes;
}

/**
 * Wat een release-rij naar buiten toe IS.
 *
 * Uit een EXPLICIETE ALLOW-LIST opgebouwd, niet door sleutels uit de rij te
 * verwijderen: een kolom die volgend jaar aan `project_releases` wordt
 * toegevoegd reist dan niet vanzelf mee. Het manifest blijft standaard THUIS —
 * een lijst van twintig releases zou anders twintig manifesten zijn.
 *
 * `withPipeline` adds the stage fields (seq, channel, gate, contentHash), again
 * by name. `source_cut` (the version tokens read at capture) stays home.
 */
function mapReleaseRow(row, { includeManifest = false, withPipeline = false } = {}) {
    if (!row) return null;
    /** @type {Record<string, any>} */
    const meta = {
        id: row.id,
        projectId: row.project_id,
        blueprintId: row.blueprint_id,
        version: Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
        notes: isPlainObject(row.notes) ? row.notes : {},
        publishedAt: row.published_at,
        publishedBy: row.published_by,
    };
    if (withPipeline) {
        meta.seq = Number.isInteger(row.seq) && row.seq > 0 ? row.seq : null;
        meta.channel = row.channel === 'pipeline' ? 'pipeline' : 'gallery';
        meta.gate = isPlainObject(row.gate) ? row.gate : null;
        meta.contentHash = isNonEmptyString(row.content_hash) ? row.content_hash : null;
    }
    if (!includeManifest) return meta;
    return { ...meta, manifest: row.manifest || null };
}

// The columns `mapReleaseRow(…, { withPipeline: true })` reads, minus the manifest.
const PIPELINE_RELEASE_COLUMNS = `id, project_id, blueprint_id, version, notes, published_at, published_by,
                                  seq, channel, gate, content_hash`;

const STAMP_COLUMNS = `project_id, ref, kind, entity_id, install_hash, installed_version,
                       release_id, source_hash, step_id_map, retired_at, updated_at`;

/** One stamp, by name. The shape `listStamps` has always returned, plus the stage columns. */
function mapStampRow(r) {
    if (!r) return null;
    return {
        ref: r.ref,
        kind: r.kind,
        entityId: r.entity_id,
        installHash: r.install_hash,
        installedVersion: r.installed_version,
        releaseId: r.release_id ?? null,
        sourceHash: r.source_hash ?? null,
        stepIdMap: isPlainObject(r.step_id_map) ? r.step_id_map : null,
        retiredAt: r.retired_at ?? null,
        updatedAt: r.updated_at ?? null,
    };
}

/** Een tellerwaarde, of null als het er geen is. Nooit een stilzwijgende 0. */
function asCount(raw) {
    const n = typeof raw === 'number' ? raw
        : (typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * De kolommen van een galerijrij MINUS het manifest.
 *
 * Bestaat zodat een lezer die alleen de meta nodig heeft (de toegangsvraag, een
 * teller) geen meerdere megabytes JSONB door de pool sleept om hem weg te
 * gooien. `mapRow(..., { includeManifest: false })` levert al dezelfde vorm; dit
 * is dezelfde beslissing één laag lager.
 */
const META_COLUMNS = `id, organization_id, created_by, source_project_id, solution_key,
                      name, description, icon, version, created_at, updated_at`;

/**
 * Org members may install; only the creator may delete.
 *
 * ONE RULE, AND IT IS `listBlueprintsFor`'s. That query answers: an org
 * blueprint belongs to the organisation, a personal one (org NULL) to whoever
 * captured it. This predicate used to answer something wider — it returned true
 * for `createdBy === userId` BEFORE looking at the organisation at all — and the
 * gap between the two was reachable: someone who captured a Blueprint for org A
 * and has since moved to org B could no longer see it in any list, but could
 * still read and install it by id. A permission that the list and the fetch
 * disagree about is decided by whichever one the caller happens to use.
 *
 * So the creator clause now lives where the list puts it: on personal
 * Blueprints only. A creator still inside the owning org keeps access through
 * the org clause, which is the same access every colleague has.
 * @param blueprint
 * @param {{ userId?: string, organizationId?: string|null }} [opts]
 */
function canRead(blueprint, { userId, organizationId = null } = {}) {
    if (!blueprint) return false;
    return blueprint.organizationId
        ? blueprint.organizationId === organizationId
        : blueprint.createdBy === userId;
}

/**
 * The ledger's input, checked and de-duplicated: [{kind, entityId, prefix}] in
 * the caller's order (the order in which new refs are numbered).
 * @param {any[]} members
 * @param {(kind: string) => string|undefined} prefixOf
 */
function normalizeMembers(members, prefixOf) {
    const out = [];
    const seen = new Set();
    for (const m of members) {
        const kind = m?.kind;
        const entityId = m?.entityId;
        if (!isNonEmptyString(kind) || !isNonEmptyString(entityId)) {
            throw new TypeError('allocateRefs: every member needs a kind and an entityId');
        }
        const prefix = prefixOf(kind) || BUILTIN_REF_PREFIX[kind];
        if (!isNonEmptyString(prefix) || !REF_PREFIX_RE.test(prefix)) {
            throw new TypeError(`allocateRefs: no ref prefix for kind '${kind}'`);
        }
        const key = JSON.stringify([kind, entityId]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, entityId, prefix });
    }
    return out;
}

/**
 * The payloads of a pipeline release, checked. Each is
 * {ref, kind, sourceEntityId, payload, contentHash}; at most one per (ref, kind).
 * @param {unknown} payloads
 */
function normalizePayloads(payloads) {
    if (payloads == null) return [];
    if (!Array.isArray(payloads)) throw new TypeError('payloads must be an array');
    const seen = new Set();
    let bytes = 0;
    const out = payloads.map((p) => {
        if (!isNonEmptyString(p?.ref) || !RELEASE_PAYLOAD_KINDS.includes(p?.kind)
            || !isNonEmptyString(p?.sourceEntityId) || !isNonEmptyString(p?.contentHash)
            || !isPlainObject(p?.payload)) {
            throw new TypeError('A release payload needs ref, a known kind, sourceEntityId, an object payload and contentHash');
        }
        const key = `${p.kind}:${p.ref}`;
        if (seen.has(key)) throw new TypeError(`Two release payloads for ${key}`);
        seen.add(key);
        const json = JSON.stringify(p.payload);
        bytes += Buffer.byteLength(json, 'utf8');
        return { ref: p.ref, kind: p.kind, sourceEntityId: p.sourceEntityId, contentHash: p.contentHash, json };
    });
    if (bytes > MAX_RELEASE_PAYLOAD_BYTES) {
        throw storeError(413, 'release_payload_too_large',
            `The data carried with this release is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_RELEASE_PAYLOAD_BYTES / 1024 / 1024} MB limit.`);
    }
    return out;
}

/**
 * Whether the payloads stored with a release (`ref, kind, content_hash` rows)
 * are exactly the normalised incoming ones, by (ref, kind, contentHash).
 * @param {Array<{ ref: string, kind: string, content_hash: string }>} stored
 * @param {Array<{ ref: string, kind: string, contentHash: string }>} incoming
 */
function samePayloadSet(stored, incoming) {
    if (stored.length !== incoming.length) return false;
    const have = new Map(stored.map(s => [`${s.kind}:${s.ref}`, s.content_hash]));
    return incoming.every(p => have.has(`${p.kind}:${p.ref}`) && have.get(`${p.kind}:${p.ref}`) === p.contentHash);
}

const asJsonb = (v) => (v == null ? null : JSON.stringify(v));

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

    /**
     * Save a Blueprint, or bump the version of the one with the same solution_key
     * in the same organisation.
     */
    async function saveBlueprint(opts = {}) {
        await ready();
        return _saveBlueprint(handle(null), opts);
    }

    /**
     * De statements van saveBlueprint, op een pool- óf transactiehandvat.
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
        // FOR UPDATE, en dat is geen sierlijkheid: de UPDATE hieronder zet
        // `version = existing.version + 1` op een waarde die onder READ COMMITTED
        // al verouderd kan zijn. Twee gelijktijdige publicaties van hetzelfde
        // project door dezelfde maker (twee tabbladen, een herhaalde POST na een
        // trage export, de mobiele client naast de web-client) lazen anders allebei
        // v2 en schreven allebei v3 — en dan draagt de geschiedenis TWEE v3-rijen
        // waarvan er één een versie vastlegt die nooit installeerbaar is geweest.
        // Precies de toestand die de kop van `publishRelease` verbiedt, en zij
        // breekt bovendien de invariant waar beide snoeiwaarborgen op leunen:
        // (blueprint_id, version) is exact één release-rij.
        //
        // Op het TRANSACTIEHANDVAT houdt de rijvergrendeling tot de COMMIT, dus de
        // tweede publicatie leest pas verder als de eerste klaar is en telt door
        // vanaf het nieuwe nummer. Op het poolhandvat (`saveBlueprint`) draait dit
        // statement in zijn eigen impliciete transactie en valt het slot meteen weg
        // — daar verandert er dus niets, en dat is ook precies waarom publiceren
        // via `publishRelease` hoort te lopen en niet via `saveBlueprint`.
        //
        // NIET afgedekt, en dat is de eerlijke grens: twee EERSTE publicaties
        // tegelijk vinden geen rij, dus is er ook niets te vergrendelen. Dan
        // ontstaan er twee galerijrijen met elk hun eigen id en elk v1 — hinderlijk,
        // maar (blueprint_id, version) blijft daar wél uniek, dus de waarborgen
        // hierboven houden stand.
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

    // ── Publiceren: één galerijrij én één release-rij ────────────────────────

    /**
     * Publiceer dit project: bewaar (of bump) de Blueprint in de galerij ÉN noteer
     * de publicatie in de geschiedenis. Samen, of geen van beide.
     *
     * ── DE VOLGORDE, EN WELKE KANT WINT ─────────────────────────────────────
     *
     * De volgorde BINNEN de transactie ligt vast en is niet de interessante vraag:
     * de release-rij draagt `blueprint_id` en het definitieve versienummer, dus de
     * galerijrij moet eerst geschreven zijn. De interessante vraag is wat er
     * gebeurt als de tweede schrijfactie faalt, en daar wint DE RELEASE-RIJ: dan is
     * er niets gepubliceerd — geen Blueprint, en geen verbruikt versienummer.
     *
     * Waarom die kant, en niet "de Blueprint staat er dan tenminste":
     *
     *   1. DEZELFDE VORM ALS DE W2-BEVINDING. Daar werd de zichtbaarheidsvlag vóór
     *      de pin gezet, en een mislukte publicatie serveerde het ongepubliceerde
     *      werk. Hier is de galerijrij de zichtbaarheid — hij is meteen
     *      installeerbaar door de hele org — en de release-rij is de pin: het
     *      vastgelegde "dit is wat v3 was". Zichtbaar zonder pin is precies de
     *      toestand die daar fout was.
     *   2. DE BUMP VERBRUIKT EEN NUMMER. Slaagt de UPDATE en faalt de release-rij,
     *      dan serveert de galerij v3 terwijl de geschiedenis bij v2 ophoudt en de
     *      vólgende publicatie v4 wordt. v3 bestaat dan voorgoed als de versie die
     *      niemand kan terugvinden — en installaties dragen dat nummer mee in hun
     *      stempels, dus het is niet alleen een gat in een lijstje.
     *   3. DE OMGEKEERDE FOUT is met deze volgorde niet te maken: een release-rij
     *      die naar een Blueprint wijst die er niet is, kan niet ontstaan omdat het
     *      id pas bestaat nadat de INSERT/UPDATE geslaagd is — en beide committen
     *      samen. Zonder transactie zou juist die kant onherstelbaar zijn: een
     *      losse release-rij verwijst dan naar een id dat nooit heeft bestaan.
     *
     * Daarom draait het geheel in ÉÉN transactie, met exact dezelfde statements als
     * `saveBlueprint` (zie `handle`) — een tweede kopie van de bump-logica zou juist
     * hier uit de pas gaan lopen.
     *
     * HET SNOEIEN ZIT ER BEWUST IN. Publiceren is één handeling: een geschiedenis
     * die over zijn cap heen groeit omdat de DELETE stilletjes faalde, is dezelfde
     * half-afgemaakte toestand als een Blueprint zonder release-rij. Een
     * galerijpublicatie snoeit alleen het galerijkanaal; pipeline-rijen hebben
     * hun eigen cap en hun eigen waarborgen.
     *
     * @returns {Promise<{blueprint: any, release: any}>}
     * @param {{ organizationId?: string|null, createdBy?: string, sourceProjectId?: string, manifest?: any, notes?: any }} [opts]
     */
    async function publishRelease({
        organizationId = null, createdBy, sourceProjectId, manifest, notes = null,
    } = {}) {
        await ready();
        // Geweigerd VÓÓR de transactie, dus vóór elke schrijfactie: een publicatie
        // zonder project heeft geen geschiedenis om in te staan, en een Blueprint
        // opslaan die daar niet in terechtkomt is precies wat hierboven verboden is.
        if (!sourceProjectId) throw new Error('sourceProjectId is required to publish a release');
        if (!createdBy) throw new Error('createdBy is required');
        if (!manifest?.solution) throw new Error('manifest is required');
        // Ook vóór de transactie: een notitie die niet opgeslagen kan worden mag
        // geen halve publicatie achterlaten, en de weigering moet actionabel zijn.
        const safeNotes = normalizeNotes(notes);

        return db.withTransaction(async (client) => {
            const h = clientHandle(client);
            const blueprint = await _saveBlueprint(h, { organizationId, createdBy, sourceProjectId, manifest });
            // GEEN RIJ TERUG = er is geen galerijrij. Bereikbaar: alleen de maker
            // mag verwijderen, en hij mag dat doen terwijl een collega publiceert —
            // dan vindt de lookup nog een rij en raakt de UPDATE er nul. Zou de
            // release-rij dan tóch geschreven worden, dan wijst zij naar een
            // Blueprint die er niet is; precies de andere helft van de belofte
            // hierboven. Dus afbreken, en de hele publicatie draait terug.
            if (!blueprint?.id) throw new Error('The Blueprint could not be saved, so nothing was published.');
            const release = await _insertRelease(h, {
                projectId: sourceProjectId,
                blueprintId: blueprint.id,
                // Het nummer dat de galerij ná deze publicatie serveert — hetzelfde
                // nummer dat installaties in hun stempels meekrijgen.
                version: blueprint.version,
                // Het manifest ZOALS OPGESLAGEN: op het bump-pad is `solution.version`
                // herschreven, en de geschiedenis moet vastleggen wat er werkelijk is
                // gepubliceerd, niet wat de aanroeper aanbood.
                manifest: blueprint.manifest,
                notes: safeNotes,
                publishedBy: createdBy,
            });
            await _pruneReleases(h, sourceProjectId);
            return { blueprint, release };
        });
    }

    async function _insertRelease(h, { projectId, blueprintId, version, manifest, notes, publishedBy }) {
        // RETURNING zonder het manifest: het is net geschreven en de aanroeper heeft
        // het al — het door de driver terugslepen is puur overdracht.
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
     * Snoei de galerijgeschiedenis van dit project terug tot de laatste twintig.
     *
     * DRIE dingen houden deze query bij elkaar, en elk sluit een manier waarop het
     * snoeien een rij zou weghalen waar iets naar wijst:
     *
     *   1. `, id` ALS TIEBREAKER. `published_at` valt terug op NOW(), en dat is in
     *      Postgres TRANSACTIETIJD: rijen die in één transactie geschreven worden
     *      dragen dezelfde tijdstempel en hun onderlinge volgorde is dan
     *      ongedefinieerd. OFFSET over een onstabiele sortering laat op elk n een
     *      willekeurige rij vallen — niet per se de oudste. Zelfde reden, zelfde
     *      oplossing als webpage/versions.js en studioAppStore.writeVersionSnapshot.
     *   2. WAAR EEN INSTALLATIE NAAR WIJST. Een installatie wijst met
     *      `projects.installed_from_blueprint_id` naar de Blueprint en met
     *      `project_solution_entities.installed_version` naar het nummer dat zij
     *      draagt; samen zijn die twee precies één release-rij. Zo'n rij telt niet
     *      mee tegen de cap en wordt nooit verwijderd. DIT IS GEEN THEORIE: wie 25
     *      keer publiceert terwijl iemand op v1 blijft zitten, duwt v1 uit het
     *      venster van de laatste twintig — en dan zou juist de installatie die het
     *      hardst een antwoord nodig heeft ("wat is v1, en wat is er sindsdien
     *      veranderd") het niet meer kunnen krijgen. Een deels bijgewerkte
     *      installatie houdt trouwens beide nummers vast: elk stempel pint zijn
     *      eigen release-rij, dus ook de v3-rij van de ene app die nooit is
     *      vervangen.
     *
     *      ALLEEN INSTALLATIES IN DE ORGANISATIE VAN DE BRON HOUDEN VAST, en dat
     *      is een bewuste versmalling. Reden 1 — wie de rij kan bereiken: een
     *      release-rij komt uitsluitend naar buiten via `listReleases`/`getRelease`
     *      en die staan achter `requireProjectRole('owner')` op het BRONproject;
     *      een Blueprint bij id opvragen (de upgrade) loopt door `canRead`, dat
     *      org-gescoopt is. Een installatie buiten die organisatie kan de rij die
     *      zij zou vasthouden dus door geen enkele deur lezen — zij bevriest een
     *      manifest van maximaal MAX_BLUEPRINT_BYTES dat niemand kan opvragen.
     *      Reden 2 — wie de invoer bepaalt: bij een bestandsinstallatie komt zowel
     *      het beweerde Blueprint-id als `installed_version` uit een bestand dat de
     *      installateur zelf bewerkt. Zonder deze versmalling kon iemand met één
     *      doorgestuurd bestand de cap van een ander project uitzetten door
     *      installaties te maken die versies 21..300 claimen, en had de
     *      bron-organisatie geen knop om die vreemde "installaties" weg te halen.
     *      MEETELLEN doen zulke installaties nog steeds — `countInstallsFor`
     *      splitst juist op die grens — de geschiedenis van een andere organisatie
     *      bevriezen niet.
     *   3. WAT DE GALERIJ NU SERVEERT. `project_blueprints.version` is het nummer
     *      dat vandaag installeerbaar is; die rij mag nooit weg, anders serveert de
     *      galerij een versie die in de geschiedenis niet bestaat. Ook bereikbaar
     *      en niet theoretisch: de serie loopt per maker, dus twintig publicaties
     *      door collega B duwen de huidige v3 van collega A uit het venster terwijl
     *      A's Blueprint hem nog steeds aanbiedt.
     *
     * De vastgehouden rijen staan BUITEN de kandidatenlijst en tellen dus niet mee
     * tegen de twintig — dezelfde keuze als `source <> 'published'` in W2. De tabel
     * mag daardoor groter worden dan de cap; dat is de veilige kant, begrensd door
     * het aantal installaties en nooit ten koste van een rij waar iets naar wijst.
     *
     * WAT WAARBORG 2 NIET KAN ZIEN, en dat is de eerlijke grens: stempelen is
     * best-effort (install.js zegt dat met zoveel woorden), dus er bestaan
     * installaties die met `installed_from_blueprint_id` naar de Blueprint wijzen
     * en géén enkel stempel hebben. Van zo'n installatie is niet vast te stellen op
     * welke versie zij staat, dus houdt zij ook geen rij vast. Dat is de smalle
     * kant: de hele geschiedenis vasthouden omdat één installatie niet kon
     * stempelen, zou de cap voorgoed uitschakelen — en die installatie kan sowieso
     * niet worden bijgewerkt, want de upgrade draait óók op stempels.
     *
     * HET KANAAL. `AND r.channel = 'gallery'`: een pipeline-rij heeft geen
     * `blueprint_id`, dus beide NOT EXISTS-waarborgen zijn voor haar waar, en
     * zonder deze voorwaarde zou één galerijpublicatie de releases snoeien waar
     * een UAT- of PRD-stage op draait. Pipeline-rijen snoeit
     * `_prunePipelineReleases`, met eigen waarborgen.
     *
     * TENANCY. Deze query LEEST `projects` maar levert er niets van op: het
     * resultaat is een lijst id's van release-rijen van dít project, en die lijst
     * gaat naar een DELETE, niet naar een aanroeper. Geen projectnaam, geen
     * eigenaar, geen org — er ontstaat hier geen payload om te lekken. `projects`
     * is wel de tabel van een ándere store; publiceren volgt altijd op een
     * projectlookup, dus zij bestaat. Zou zij ooit niet bestaan, dan faalt dit
     * statement luid en draait de publicatie terug — nooit stilzwijgend snoeien
     * zonder waarborg 2.
     *
     * Alleen id's terug, zodat een aanroeper die wil weten wat er verdween dat kan
     * zien zonder dat de rijen zelf nog rondreizen.
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
        // Uitsluitend op de id's die deze query teruggaf. Een DELETE met een eigen
        // predicaat ("alles ouder dan") zou de drie waarborgen hierboven omzeilen.
        await h.run(`DELETE FROM project_releases WHERE id = ANY($1::text[])`, [ids]);
        return ids;
    }

    /**
     * Prune this Solution's pipeline releases back to the newest 50 that nothing
     * holds.
     *
     * A row is HELD, outside the count and never deleted, when it is:
     *   (a) the current or previous release of a stage (what runs, and what a
     *       rollback goes back to);
     *   (b) the release of a deployment that is not finished (awaiting
     *       approval, queued, running, compensating, or any status added later);
     *   (c) the release of a succeeded UAT deployment whose seq is above the PRD
     *       stage's current release: tested, and still waiting to be promoted
     *       (with no PRD stage yet, every UAT-tested release waits);
     *   (d) the release of any succeeded PRD deployment: a rollback target.
     *
     * The stage tables belong to solutionStageStore, which boots AFTER this
     * store. Without them the guards cannot be evaluated, and pruning without
     * them could delete what a stage runs, so this then prunes nothing.
     *
     * The pruned rows' payloads go in the same handle, before the rows.
     */
    async function _prunePipelineReleases(h, projectId) {
        const tables = await h.one(
            `SELECT to_regclass('solution_stages') IS NOT NULL AS stages,
                    to_regclass('solution_deployments') IS NOT NULL AS deployments`,
            [],
        );
        if (!tables?.stages || !tables?.deployments) return [];
        const doomed = await h.all(
            `SELECT r.id FROM project_releases r
              WHERE r.project_id = $1
                AND r.channel = 'pipeline'
                AND NOT EXISTS (
                    SELECT 1 FROM solution_stages s
                     WHERE s.current_release_id = r.id OR s.previous_release_id = r.id)
                AND NOT EXISTS (
                    SELECT 1 FROM solution_deployments d
                     WHERE d.release_id = r.id
                       AND d.status <> ALL($3::text[]))
                AND NOT EXISTS (
                    SELECT 1 FROM solution_deployments d
                     WHERE d.solution_id = r.project_id
                       AND d.release_id = r.id
                       AND d.status = ANY($4::text[])
                       AND (d.stage = 'prd'
                            OR (d.stage = 'uat' AND r.seq > COALESCE((
                                SELECT MAX(ps.current_release_seq) FROM solution_stages ps
                                 WHERE ps.solution_id = r.project_id AND ps.stage = 'prd'), 0))))
              ORDER BY r.seq DESC NULLS LAST, r.published_at DESC, r.id
              OFFSET $2`,
            [projectId, MAX_PIPELINE_RELEASES_PER_PROJECT,
             [...TERMINAL_DEPLOYMENT_STATUSES], [...SUCCEEDED_DEPLOYMENT_STATUSES]],
        );
        const ids = (doomed || []).map(r => r?.id).filter(id => typeof id === 'string' && id);
        if (!ids.length) return [];
        await h.run(`DELETE FROM solution_release_payloads WHERE release_id = ANY($1::text[])`, [ids]);
        await h.run(`DELETE FROM project_releases WHERE id = ANY($1::text[]) AND channel = 'pipeline'`, [ids]);
        return ids;
    }

    /**
     * De publicatiegeschiedenis van één project, nieuwste eerst — zonder manifest.
     *
     * DEZE FUNCTIE AUTORISEERT NIETS. Zij scoopt op het project-id dat zij krijgt,
     * meer niet; de aanroeper moet dat id al hebben geautoriseerd (in de
     * packaging-router is dat `requireProjectRole('owner')`). Zelfde contract als
     * `listStamps` en `listInstalledVersions`, en dezelfde stille manier om het te
     * breken: een nieuwe aanroeper die er een id in gooit dat hij niet controleerde.
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
     * Eén release, mét het manifest zoals het gepubliceerd is, and with its
     * stage fields (seq, channel, gate, contentHash).
     *
     * ALTIJD op (project, id) en nooit op id alleen: het id is de sleutel, maar het
     * project is de scope die de aanroeper heeft geautoriseerd. Een lookup op id
     * alleen zou een geraden id uit een ánder project beantwoorden.
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

    // ── Pipeline releases (Solution stages) ──────────────────────────────────

    /**
     * Cut a pipeline release of a Solution's Dev project: one immutable,
     * numbered row (`channel = 'pipeline'`, no gallery row) plus its payloads,
     * in one transaction.
     *
     * - The Dev project row is locked first (`FOR UPDATE`), so two cuts never
     *   compute the same `seq`; `uq_project_releases_seq` is the backstop.
     * - Idempotent by `requestKey` (kept in `notes.requestKey`): a replay
     *   answers the row the first call wrote, `replayed: true`.
     * - The same `contentHash` as the latest pipeline release, with the same
     *   payloads (ref, kind, contentHash), writes nothing and answers that
     *   release, `reused: true` ("no changes since Release 6"). Changed
     *   reference rows or KB listings alone still cut the next seq.
     * - `version = seq` and `published_by = createdBy`, because both columns
     *   are NOT NULL and a pipeline row belongs to no Blueprint series.
     * - The pipeline prune runs in the same transaction.
     *
     * Authorises nothing: the caller has checked that `createdBy` owns the
     * Solution. `client` joins a transaction the caller already holds.
     *
     * @param {{ projectId?: string, manifest?: any, contentHash?: string, gate?: any, sourceCut?: any,
     *   notes?: any, createdBy?: string, requestKey?: string|null, payloads?: any[], client?: any }} [opts]
     * @returns {Promise<{ release: any, reused: boolean, replayed: boolean }>}
     */
    async function cutPipelineRelease({
        projectId, manifest, contentHash, gate = null, sourceCut = null, notes = null,
        createdBy, requestKey = null, payloads = [], client = null,
    } = {}) {
        await ready();
        if (!isNonEmptyString(projectId)) throw new Error('projectId is required to cut a release');
        if (!isNonEmptyString(createdBy)) throw new Error('createdBy is required');
        if (!manifest?.solution) throw new Error('manifest is required');
        if (!isNonEmptyString(contentHash)) throw new Error('contentHash is required');
        if (gate != null && !isPlainObject(gate)) throw new TypeError('gate must be an object');
        if (sourceCut != null && !isPlainObject(sourceCut)) throw new TypeError('sourceCut must be an object');
        if (requestKey != null && (!isNonEmptyString(requestKey) || requestKey.length > MAX_REQUEST_KEY_LENGTH)) {
            throw new TypeError('requestKey must be a short string');
        }
        assertManifestSize(manifest);
        const baseNotes = normalizeNotes(notes);
        const safeNotes = requestKey ? normalizeNotes({ ...baseNotes, requestKey }) : baseNotes;
        const rows = normalizePayloads(payloads);

        return inTransaction(client, async (h) => {
            const project = await h.one(`SELECT id FROM projects WHERE id = $1 FOR UPDATE`, [projectId]);
            if (!project) throw storeError(404, 'project_not_found', 'This Solution no longer exists.');

            if (requestKey) {
                const replay = await h.one(
                    `SELECT ${PIPELINE_RELEASE_COLUMNS} FROM project_releases
                      WHERE project_id = $1 AND channel = 'pipeline' AND notes->>'requestKey' = $2
                      ORDER BY seq DESC LIMIT 1`,
                    [projectId, requestKey],
                );
                if (replay) return { release: mapReleaseRow(replay, { withPipeline: true }), reused: false, replayed: true };
            }

            const latest = await h.one(
                `SELECT ${PIPELINE_RELEASE_COLUMNS} FROM project_releases
                  WHERE project_id = $1 AND channel = 'pipeline'
                  ORDER BY seq DESC NULLS LAST, published_at DESC, id
                  LIMIT 1`,
                [projectId],
            );
            if (latest && latest.content_hash === contentHash) {
                // The content hash covers the manifest entities only; reference
                // rows and KB listings travel as payloads (D20). A changed payload
                // is a new release even when no definition changed.
                const stored = await h.all(
                    `SELECT ref, kind, content_hash FROM solution_release_payloads WHERE release_id = $1`,
                    [latest.id],
                );
                if (samePayloadSet(stored || [], rows)) {
                    return { release: mapReleaseRow(latest, { withPipeline: true }), reused: true, replayed: false };
                }
            }

            const next = await h.one(
                `SELECT COALESCE(MAX(seq), 0)::int + 1 AS seq FROM project_releases WHERE project_id = $1`,
                [projectId],
            );
            const seq = Number(next?.seq) > 0 ? Number(next.seq) : 1;
            const row = await h.one(
                `INSERT INTO project_releases
                    (id, project_id, blueprint_id, version, manifest, notes, published_by,
                     seq, channel, content_hash, gate, source_cut)
                 VALUES ($1,$2,NULL,$3,$4,$5,$6,$3,'pipeline',$7,$8,$9)
                 RETURNING ${PIPELINE_RELEASE_COLUMNS}`,
                [newReleaseId(), projectId, seq, JSON.stringify(manifest), JSON.stringify(safeNotes),
                 createdBy, contentHash, asJsonb(gate), asJsonb(sourceCut)],
            );
            for (const p of rows) {
                await h.run(
                    `INSERT INTO solution_release_payloads
                        (release_id, ref, kind, source_entity_id, payload, content_hash)
                     VALUES ($1,$2,$3,$4,$5,$6)`,
                    [row.id, p.ref, p.kind, p.sourceEntityId, p.json, p.contentHash],
                );
            }
            await _prunePipelineReleases(h, projectId);
            return { release: mapReleaseRow(row, { withPipeline: true }), reused: false, replayed: false };
        });
    }

    /**
     * A Solution's pipeline releases, newest first, without manifests.
     * Authorises nothing (same contract as `listReleases`).
     */
    async function listPipelineReleases(projectId, { limit = MAX_PIPELINE_RELEASES_PER_PROJECT, client = null } = {}) {
        await ready();
        if (!isNonEmptyString(projectId)) return [];
        const asked = Number(limit);
        const capped = Math.min(
            Number.isFinite(asked) && asked > 0 ? Math.trunc(asked) : MAX_PIPELINE_RELEASES_PER_PROJECT,
            MAX_LISTED_PIPELINE_RELEASES,
        );
        const rows = await handle(client).all(
            `SELECT ${PIPELINE_RELEASE_COLUMNS} FROM project_releases
              WHERE project_id = $1 AND channel = 'pipeline'
              ORDER BY seq DESC NULLS LAST, published_at DESC, id
              LIMIT $2`,
            [projectId, capped],
        );
        return (rows || []).map(r => mapReleaseRow(r, { withPipeline: true }));
    }

    /**
     * The payloads stored with one release (reference rows, KB listings),
     * optionally of one kind, ordered by ref. Authorises nothing: the caller has
     * read the release through `getRelease(projectId, releaseId)` first.
     */
    async function getReleasePayloads(releaseId, { kind = null, client = null } = {}) {
        await ready();
        if (!isNonEmptyString(releaseId)) return [];
        if (kind != null && !RELEASE_PAYLOAD_KINDS.includes(kind)) throw new TypeError(`Unknown payload kind '${kind}'`);
        const rows = await handle(client).all(
            `SELECT ref, kind, source_entity_id, payload, content_hash
               FROM solution_release_payloads
              WHERE release_id = $1 AND ($2::text IS NULL OR kind = $2)
              ORDER BY ref, kind`,
            [releaseId, kind],
        );
        return (rows || []).map(r => ({
            ref: r.ref,
            kind: r.kind,
            sourceEntityId: r.source_entity_id,
            payload: isPlainObject(r.payload) ? r.payload : {},
            contentHash: r.content_hash,
        }));
    }

    // ── The ref ledger ───────────────────────────────────────────────────────

    /**
     * Give every member of a Solution its stable ref: Map(entityId → ref).
     *
     * - A part that already has a ref keeps it, whatever the order of `members`.
     * - A new part gets `<prefix>_<max+1>`, where max runs over EVERY ref of
     *   that prefix the Solution ever had, so a retired ref is never handed out
     *   again (a stage still holds a stamp under it).
     * - A ledger row whose part is absent from `members` gets `retired_at`; a
     *   retired part that comes back is revived under its old ref.
     * - Retirement only touches the kinds this call speaks for: `kinds` when
     *   given, otherwise the families present in `members` (parts: every kind
     *   but 'connection'; connection slots: 'connection'). So a parts-only call
     *   (the gallery export) never retires connection slots, a connections-only
     *   call never retires parts, and an empty call retires nothing.
     * - `prefixOf(kind)` names the prefix (the manifest's REF_PREFIX); kind
     *   'connection' has the built-in prefix 'cn'.
     *
     * One transaction (or the caller's `client`), serialised per Solution by an
     * advisory lock, with the existing rows read `FOR UPDATE`.
     *
     * @param {string} solutionId
     * @param {Array<{ kind: string, entityId: string }>} members
     * @param {{ prefixOf?: (kind: string) => string|undefined, kinds?: string[]|null, client?: any }} [opts]
     * @returns {Promise<Map<string, string>>}
     */
    async function allocateRefs(solutionId, members, { prefixOf, kinds = null, client = null } = {}) {
        await ready();
        if (!isNonEmptyString(solutionId)) throw new TypeError('allocateRefs: solutionId is required');
        if (!Array.isArray(members)) throw new TypeError('allocateRefs: members must be an array');
        if (kinds != null && (!Array.isArray(kinds) || !kinds.every(isNonEmptyString))) {
            throw new TypeError('allocateRefs: kinds must be an array of kind names');
        }
        const wanted = normalizeMembers(members, typeof prefixOf === 'function' ? prefixOf : () => undefined);
        const retireParts = wanted.some(w => w.kind !== 'connection');
        const retireConnections = wanted.some(w => w.kind === 'connection');

        return inTransaction(client, async (h) => {
            await h.one(`SELECT pg_advisory_xact_lock(hashtext($1)) AS locked`, [`solution_part_refs:${solutionId}`]);
            const rows = await h.all(
                `SELECT kind, entity_id, ref, retired_at FROM solution_part_refs
                  WHERE solution_id = $1 FOR UPDATE`,
                [solutionId],
            );
            const byKey = new Map(rows.map(r => [JSON.stringify([r.kind, r.entity_id]), r]));
            const maxByPrefix = new Map();
            for (const r of rows) {
                const m = REF_RE.exec(r.ref);
                if (m) maxByPrefix.set(m[1], Math.max(maxByPrefix.get(m[1]) || 0, Number(m[2])));
            }

            const out = new Map();
            const fresh = [];
            const revived = [];
            for (const m of wanted) {
                const existing = byKey.get(JSON.stringify([m.kind, m.entityId]));
                if (existing) {
                    out.set(m.entityId, existing.ref);
                    if (existing.retired_at) revived.push(m);
                    continue;
                }
                const n = (maxByPrefix.get(m.prefix) || 0) + 1;
                maxByPrefix.set(m.prefix, n);
                const ref = `${m.prefix}_${n}`;
                fresh.push({ ...m, ref });
                out.set(m.entityId, ref);
            }

            if (fresh.length) {
                await h.run(
                    `INSERT INTO solution_part_refs (solution_id, kind, entity_id, ref)
                     SELECT $1, t.kind, t.entity_id, t.ref
                       FROM unnest($2::text[], $3::text[], $4::text[]) AS t(kind, entity_id, ref)`,
                    [solutionId, fresh.map(f => f.kind), fresh.map(f => f.entityId), fresh.map(f => f.ref)],
                );
            }
            if (revived.length) {
                await h.run(
                    `UPDATE solution_part_refs SET retired_at = NULL
                      WHERE solution_id = $1
                        AND (kind, entity_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
                    [solutionId, revived.map(r => r.kind), revived.map(r => r.entityId)],
                );
            }
            await h.run(
                `UPDATE solution_part_refs p SET retired_at = NOW()
                  WHERE p.solution_id = $1 AND p.retired_at IS NULL
                    AND CASE WHEN $4::text[] IS NOT NULL THEN p.kind = ANY($4::text[])
                             WHEN p.kind = 'connection' THEN $6::boolean
                             ELSE $5::boolean END
                    AND NOT EXISTS (
                        SELECT 1 FROM unnest($2::text[], $3::text[]) AS t(kind, entity_id)
                         WHERE t.kind = p.kind AND t.entity_id = p.entity_id)`,
                [solutionId, wanted.map(w => w.kind), wanted.map(w => w.entityId),
                 kinds, retireParts, retireConnections],
            );
            return out;
        });
    }

    /** Every ledger row of a Solution, retired ones included, in ref order per kind. */
    async function refsFor(solutionId, { client = null } = {}) {
        await ready();
        if (!isNonEmptyString(solutionId)) return [];
        const rows = await handle(client).all(
            `SELECT kind, entity_id, ref, created_at, retired_at FROM solution_part_refs
              WHERE solution_id = $1
              ORDER BY kind, length(ref), ref`,
            [solutionId],
        );
        return (rows || []).map(r => ({
            kind: r.kind,
            entityId: r.entity_id,
            ref: r.ref,
            createdAt: r.created_at,
            retiredAt: r.retired_at ?? null,
        }));
    }

    /**
     * Hoe vaak deze Blueprints OP DEZE INSTANTIE zijn geïnstalleerd: hier, en elders.
     *
     * ── Wat deze twee getallen wél zijn ────────────────────────────────────
     *
     * Projectrijen in deze database waarvan `installed_from_blueprint_id` in de
     * meegegeven lijst staat, gesplitst op organisatie: `here` is de organisatie
     * van de Blueprint zelf, `elsewhere` is al het andere OP DEZE INSTANTIE. Dat
     * tweede getal is de hele reden dat deze functie bestaat — een Blueprint wordt
     * juist gedeeld met een ander team — en tegelijk het enige antwoord in deze
     * store dat over de org-grens heen kijkt. De partiële index
     * `idx_projects_installed_from` (stores/projectStore.js) is er precies voor.
     *
     * ── De valkuil in de vergelijking ──────────────────────────────────────
     *
     * `projects.organization_id` is `TEXT DEFAULT ''` (createProject schrijft
     * `organizationId || ''`), terwijl `project_blueprints.organization_id` NULL
     * mag zijn. Een naïeve `=` tussen die twee matcht org-loze rijen NOOIT, en dan
     * telt elke persoonlijke installatie stilzwijgend als "elders". Vandaar aan
     * beide kanten een expliciete `COALESCE(..., '')`: leeg en NULL zijn hier
     * hetzelfde ding, namelijk "geen organisatie".
     *
     * ── Wat het NIET is, en waarom het scherm dat moet zeggen ───────────────
     *
     * Een ONDERGRENS, nooit een totaal: een andere instantie ziet deze database
     * niet, dus wie het bestand doorstuurt naar een eigen self-host telt hier per
     * definitie niet mee. Het scherm zegt daarom "minstens n", nooit "n".
     *
     * ── Tenancy ────────────────────────────────────────────────────────────
     *
     * DEZE FUNCTIE AUTORISEERT NIETS. Zij telt de id's die zij krijgt; de aanroeper
     * moet die al hebben geautoriseerd — zelfde contract als `listStamps`,
     * `listInstalledVersions` en `listReleases`, en dezelfde stille manier om het te
     * breken. Wat zij WEL garandeert is dat er niets anders uit kan komen dan twee
     * getallen: één COUNT-rij, geen project-id, geen naam, geen eigenaar, geen
     * organisatie, geen tijdstip. Er is hier dus geen rij om per ongeluk door te
     * geven, en geen kolom die volgend jaar aan `projects` wordt toegevoegd kan
     * meeliften. Ook geen uitsplitsing PER organisatie: bij n=1 is een aggregaat
     * over één organisatie geen aggregaat meer.
     *
     * `null` = niet te lezen. Nul installaties is een antwoord; "de telling
     * mislukte" is er geen, en die twee mogen op geen enkel scherm hetzelfde worden.
     *
     * @returns {Promise<{here:number, elsewhere:number}|null>}
     */
    async function countInstallsFor(blueprintIds, { organizationId = null } = {}) {
        await ready();
        const ids = (Array.isArray(blueprintIds) ? blueprintIds : [])
            .filter(id => typeof id === 'string' && id);
        // Geen Blueprint om op te tellen. Nul is hier een ANTWOORD en geen gat: uit
        // een id dat niet bestaat kan niemand iets geïnstalleerd hebben.
        if (!ids.length) return { here: 0, elsewhere: 0 };

        const row = await db.getOne(
            `SELECT COUNT(*) FILTER (WHERE COALESCE(organization_id, '') = COALESCE($2, ''))::int AS here,
                    COUNT(*) FILTER (WHERE COALESCE(organization_id, '') <> COALESCE($2, ''))::int AS elsewhere
               FROM projects
              WHERE installed_from_blueprint_id = ANY($1::text[])`,
            [ids, organizationId || ''],
        );
        // GEEN kale `Number(row?.here)`: dat maakt van een ontbrekende rij en van
        // NULL allebei een keurige 0, en dan is "niemand heeft dit geïnstalleerd"
        // niet meer te onderscheiden van "de telling kwam niet terug".
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
            // META_COLUMNS en niet `*`. `mapRow(..., { includeManifest: false })`
            // gooide het manifest er daarna toch uit, dus elke lezer — de galerij,
            // de toegangsvraag, de installatieteller — trok tot honderd JSONB-blobs
            // van elk maximaal MAX_BLUEPRINT_BYTES door de pool en door de heap om
            // ze weg te gooien. De kolomlijst is dezelfde beslissing één laag lager.
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

    // ── Installed-entity stamps ─────────────────────────────────────────

    /**
     * Record what an entity looked like at install time.
     *
     * The stage columns are optional here: one left out keeps what the stamp
     * already holds, so a gallery re-stamp never drops the install's step-id
     * rename map (D3).
     * @param {{ projectId: string, ref: string, kind: string, entityId: string, installHash: string,
     *   installedVersion?: number, releaseId?: string|null, sourceHash?: string|null, stepIdMap?: object|null }} row
     */
    async function stampEntity({
        projectId, ref, kind, entityId, installHash, installedVersion = 1,
        releaseId = null, sourceHash = null, stepIdMap = null,
    }) {
        await ready();
        await db.run(
            `INSERT INTO project_solution_entities
                (project_id, ref, kind, entity_id, install_hash, installed_version,
                 release_id, source_hash, step_id_map, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
             ON CONFLICT (project_id, ref) DO UPDATE
                SET entity_id = EXCLUDED.entity_id,
                    install_hash = EXCLUDED.install_hash,
                    installed_version = EXCLUDED.installed_version,
                    release_id = COALESCE(EXCLUDED.release_id, project_solution_entities.release_id),
                    source_hash = COALESCE(EXCLUDED.source_hash, project_solution_entities.source_hash),
                    step_id_map = COALESCE(EXCLUDED.step_id_map, project_solution_entities.step_id_map),
                    updated_at = NOW()`,
            [projectId, ref, kind, entityId, installHash, installedVersion,
             releaseId || null, sourceHash || null, isPlainObject(stepIdMap) ? JSON.stringify(stepIdMap) : null],
        );
    }

    /**
     * Write one stamp, on the caller's transaction client or the pool. The one
     * writer of the stage columns.
     *
     * Every given field is written. `installedVersion`, `releaseId`,
     * `sourceHash` and `stepIdMap` left `undefined` keep the stored value (a
     * new stamp starts at version 1; null clears the others); `retired: true`
     * retires the stamp (keeping the first retirement time), `false` revives
     * it, `undefined` leaves it.
     *
     * @param {any} client  a transaction client, or null for the pool
     * @param {{ projectId: string, ref: string, kind: string, entityId: string, installHash: string,
     *   installedVersion?: number, releaseId?: string|null, sourceHash?: string|null,
     *   stepIdMap?: object|null, retired?: boolean }} row
     */
    async function upsertStamp(client, row) {
        await ready();
        const { projectId, ref, kind, entityId, installHash } = row || /** @type {any} */ ({});
        for (const [name, v] of Object.entries({ projectId, ref, kind, entityId, installHash })) {
            if (!isNonEmptyString(v)) throw new TypeError(`upsertStamp: ${name} is required`);
        }
        const versionGiven = row.installedVersion !== undefined;
        const installedVersion = versionGiven ? row.installedVersion : 1;
        if (!Number.isInteger(installedVersion) || installedVersion < 1) {
            throw new TypeError('upsertStamp: installedVersion must be a positive integer');
        }
        if (row.stepIdMap != null && !isPlainObject(row.stepIdMap)) {
            throw new TypeError('upsertStamp: stepIdMap must be an object or null');
        }
        const sets = [
            'kind = EXCLUDED.kind',
            'entity_id = EXCLUDED.entity_id',
            'install_hash = EXCLUDED.install_hash',
            'updated_at = NOW()',
        ];
        if (versionGiven) sets.push('installed_version = EXCLUDED.installed_version');
        if (row.releaseId !== undefined) sets.push('release_id = EXCLUDED.release_id');
        if (row.sourceHash !== undefined) sets.push('source_hash = EXCLUDED.source_hash');
        if (row.stepIdMap !== undefined) sets.push('step_id_map = EXCLUDED.step_id_map');
        if (row.retired === true) sets.push('retired_at = COALESCE(project_solution_entities.retired_at, NOW())');
        else if (row.retired === false) sets.push('retired_at = NULL');

        const out = await handle(client).one(
            `INSERT INTO project_solution_entities
                (project_id, ref, kind, entity_id, install_hash, installed_version,
                 release_id, source_hash, step_id_map, retired_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10::boolean THEN NOW() END, NOW())
             ON CONFLICT (project_id, ref) DO UPDATE SET ${sets.join(', ')}
             RETURNING ${STAMP_COLUMNS}`,
            [projectId, ref, kind, entityId, installHash, installedVersion,
             row.releaseId || null, row.sourceHash || null, asJsonb(row.stepIdMap),
             row.retired === true],
        );
        return mapStampRow(out);
    }

    /** Every stamp for a project, keyed by bundle-local ref (retired ones included). */
    async function listStamps(projectId, { client = null } = {}) {
        await ready();
        const rows = await handle(client).all(
            `SELECT ${STAMP_COLUMNS} FROM project_solution_entities WHERE project_id = $1`, [projectId],
        );
        return new Map((rows || []).map(r => [r.ref, mapStampRow(r)]));
    }

    /**
     * The version each of these Solutions has been brought to, from its own entity
     * stamps — Map(projectId → version). One query for the whole overview.
     *
     * MAX, not MIN. An upgrade re-stamps only the entities it actually replaced, so
     * a Solution installed at v3 and upgraded to v5 with one hand-edited app left
     * alone carries both numbers. The question the overview asks is "is there
     * something newer than what this has been brought to", and that is the highest.
     * MIN would answer "yes, forever" for any Solution holding one entity the
     * upgrade planner will always skip.
     *
     * A project with no stamps is ABSENT rather than 0: never installed from a
     * Blueprint, or installed by a version of this code that could not stamp. Both
     * mean "we do not know what version this is", and the overview must render that
     * as unknown — never as "up to date".
     *
     * O4 replaces this with `projects.installed_version`; the stamps are what the
     * database can already answer today, and the shape of the answer is the same.
     */
    async function listInstalledVersions(projectIds) {
        await ready();
        const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
        if (!ids.length) return new Map();
        const rows = await db.getAll(
            `SELECT project_id, MAX(installed_version)::int AS version
               FROM project_solution_entities
              WHERE project_id = ANY($1)
              GROUP BY project_id`,
            [ids],
        );
        return new Map((rows || [])
            .filter(r => Number.isFinite(Number(r.version)))
            .map(r => [r.project_id, Number(r.version)]));
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
        publishRelease,
        listReleases,
        getRelease,
        cutPipelineRelease,
        listPipelineReleases,
        getReleasePayloads,
        allocateRefs,
        refsFor,
        listBlueprintsFor,
        getBlueprintById,
        countInstallsFor,
        deleteBlueprint,
        stampEntity,
        upsertStamp,
        listStamps,
        listInstalledVersions,
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
