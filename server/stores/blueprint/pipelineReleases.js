// @typecheck
/**
 * Pipeline releases of Solution stages: `cutPipelineRelease`,
 * `listPipelineReleases`, `getReleasePayloads`, and their own prune. Part of
 * `makeReleasesStore` (./releases.js), built over the same context.
 */

'use strict';

const {
    MAX_PIPELINE_RELEASES_PER_PROJECT,
    MAX_LISTED_PIPELINE_RELEASES,
    RELEASE_PAYLOAD_KINDS,
    TERMINAL_DEPLOYMENT_STATUSES,
    SUCCEEDED_DEPLOYMENT_STATUSES,
    MAX_REQUEST_KEY_LENGTH,
} = require('./constants');
const {
    newReleaseId,
    isNonEmptyString,
    isPlainObject,
    storeError,
    assertManifestSize,
    normalizeNotes,
    mapReleaseRow,
    PIPELINE_RELEASE_COLUMNS,
    normalizePayloads,
    samePayloadSet,
    asJsonb,
} = require('./mappers');

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
 * @param {Pick<import('./mappers').BlueprintStoreCtx, 'ready' | 'handle' | 'inTransaction'>} ctx
 */
function makePipelineReleasesStore({ ready, handle, inTransaction }) {
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

    return { cutPipelineRelease, listPipelineReleases, getReleasePayloads };
}

module.exports = { makePipelineReleasesStore, _prunePipelineReleases };
