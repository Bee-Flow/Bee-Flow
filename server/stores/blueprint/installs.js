// @typecheck strict
/**
 * What an installed Solution is made of: the ref ledger (`allocateRefs`,
 * `refsFor`) that keeps a part's ref stable across captures, and the
 * per-entity install stamps (`stampEntity`, `upsertStamp`, `listStamps`,
 * `listInstalledVersions`). Built by `makeInstallsStore(ctx)` over the
 * context `makeBlueprintStore` builds.
 */

'use strict';

const { REF_RE } = require('./constants');
const {
    isNonEmptyString, isPlainObject, STAMP_COLUMNS, mapStampRow, normalizeMembers, asJsonb,
} = require('./mappers');

/** @param {import('./mappers').BlueprintStoreCtx} ctx */
function makeInstallsStore({ db, ready, handle, inTransaction }) {
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

    /**
     * Every ledger row of a Solution, retired ones included, in ref order per kind.
     * @param {string} solutionId
     */
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
        const installedVersion = row.installedVersion !== undefined ? row.installedVersion : 1;
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

    /**
     * Every stamp for a project, keyed by bundle-local ref (retired ones included).
     * @param {string} projectId
     */
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
     * @param {string[]} projectIds
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

    return {
        allocateRefs,
        refsFor,
        stampEntity,
        upsertStamp,
        listStamps,
        listInstalledVersions,
    };
}

module.exports = { makeInstallsStore };
