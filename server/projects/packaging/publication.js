/**
 * Publishing a Solution: the server-side gate, the release note and the
 * announcement.
 *
 * These lived in routes/projects/packaging.js. They moved here so the route
 * keeps only HTTP concerns and so the release engine can reuse them without
 * requiring a router. Every function takes its collaborators through `deps`;
 * what is not injected is required lazily, inside the call, so a test that
 * injects everything never loads a real store.
 *
 * ── The gate is the server's, not the client's ──────────────────────────────
 *
 * The Studio disabled its publish button while the completeness check
 * reported blocking findings, but the export route itself published whatever
 * it was sent. `releaseGate` runs the same aggregate (projects/completeness.js
 * over projects/graphForProject.js) on the server, and UNKNOWN BLOCKS: a graph
 * that could not be built is a blocked verdict, never a clean one.
 */

'use strict';

const defaultLog = require('../../telemetry/log');

/**
 * How long one sentence of the note may take, and how long the whole text
 * layer may take.
 *
 * Publishing must NOT wait on a model. `buildReleaseNotes` produces the exact
 * boolean diff without a single network call and then enriches it with one line
 * per changed entity; only that enrichment costs time. With CONCURRENCY 3 in
 * releaseNotes.js the worst case is roughly NOTE_DEADLINE_MS plus one hanging
 * call of NOTE_CALL_TIMEOUT_MS (the deadline is checked before each await, not
 * during one). Both are therefore well under the module defaults (15 s / 45 s):
 * a publication that stands still for half a minute reads as broken.
 */
const NOTE_CALL_TIMEOUT_MS = 6_000;
const NOTE_DEADLINE_MS = 12_000;

/**
 * The manifest the gallery serves for this project RIGHT NOW: the left-hand
 * side of the diff.
 *
 * Exactly the row `publishRelease` is about to bump: same `solution_key`, same
 * creator, same organisation. The version series runs per creator, so the
 * previous version of THIS series is the only honest comparison; the latest
 * release row of the project may be a colleague's.
 *
 * Org scoping comes from `listBlueprintsFor` (the store's one scoping query),
 * and on top of that the row must be the caller's own. Nothing found means
 * this is the first publication: everything is 'added', and no model call is
 * made because there is nothing to compare.
 */
async function previousPublishedManifest({ store, project, userId }) {
    const readable = await store.listBlueprintsFor({
        userId, organizationId: project.organizationId || null,
    });
    const mine = (readable || []).find(b => b?.solutionKey === `sol_${project.id}` && b?.createdBy === userId);
    if (!mine?.id) return null;
    const full = await store.getBlueprintById(mine.id);
    return full?.manifest || null;
}

/**
 * The note for this publication, or null.
 *
 * Two layers (see ./releaseNotes.js): the EXACT diff per entity, which touches
 * no network and cannot fall over, plus one sentence per changed entity when a
 * model is available. When the second layer fails the first one stays; when
 * everything fails the note is null and the release publishes without one —
 * NEVER a refused publication because of a note.
 *
 * That is also why the size check at the end exists: `publishRelease` THROWS
 * on a note above `MAX_NOTES_BYTES`. `releaseNotesPayload` shrinks to fit, but
 * to ITS own limit; should the store's limit ever drop below that, a
 * publication would fail on a side issue. So the payload is measured against
 * the store's real constant here, not against a copy.
 *
 * The note comes from the SERVER, never from the request: a diff is the
 * server's statement about two manifests, and a client-supplied one could mark
 * a changed entity as 'unchanged'.
 *
 * @param {{store:object, project:object, userId:string, manifest:object}} input
 * @param {{releaseNotes?:{buildReleaseNotes:Function, releaseNotesPayload:Function}, log?:object}} [deps]
 */
async function releaseNotesFor({ store, project, userId, manifest }, deps = {}) {
    const log = deps.log || defaultLog;
    try {
        const previousManifest = await previousPublishedManifest({ store, project, userId });
        const { buildReleaseNotes, releaseNotesPayload } = deps.releaseNotes || require('./releaseNotes');
        const notes = await buildReleaseNotes({
            previousManifest,
            manifest,
            // Whose model. Without a user releaseNotes.js makes no call; here
            // there always is one, because the route sits behind a session.
            userOrgId: project.organizationId || null,
            userId,
            timeoutMs: NOTE_CALL_TIMEOUT_MS,
            deadlineMs: NOTE_DEADLINE_MS,
        });
        const payload = releaseNotesPayload(notes);
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > store.MAX_NOTES_BYTES) {
            log.warn('[Projects] release notes did not fit; publishing without them');
            return null;
        }
        return payload;
    } catch (err) {
        // A note is a side issue. Publishing is not.
        log.warn('[Projects] could not build release notes:', err.message);
        return null;
    }
}

/**
 * Say that something was published. A POKE, NOT AN ANSWER.
 *
 * The Studio screens (SolutionDetail.jsx) refresh their gallery list and their
 * release history on `blueprint.published`; both are ORG-SCOPED reads that
 * decide for themselves what the reader may see. So this event carries no
 * Blueprint id, no version number and no name: a project member outside the
 * Blueprint's organisation would otherwise see a version number through the
 * activity stream that the gallery list withholds from them.
 *
 * Both halves: `logActivity` for the polling fallback (project_activity), and
 * `emitProjectEvent` for the live stream. Neither may fail a publication that
 * has already been committed, hence the own try.
 *
 * @param {{projectStore?:object, projectFeed?:object, log?:object}} [deps]
 */
async function announcePublication(projectId, actorId, deps = {}) {
    const log = deps.log || defaultLog;
    try {
        const projectStore = deps.projectStore || require('../../stores/projectStore');
        const projectFeed = deps.projectFeed || require('../../core/projectFeed');
        await projectStore.logActivity(projectId, actorId, 'blueprint.published', {});
        await projectFeed.emitProjectEvent(projectId, { kind: 'blueprint.published', actorId });
    } catch (err) {
        log.warn('[Projects] could not announce a publication:', err.message);
    }
}

/** The verdict a gate that could not run gives: blocked, and saying why. */
const UNKNOWN_VERDICT = Object.freeze({ blocked: true, complete: false, findings: [], unavailable: ['all'] });

/**
 * The publish gate: the completeness aggregate over the project's graph.
 *
 * Never throws. A graph or an aggregate that cannot be computed is a BLOCKED
 * verdict with `unavailable: ['all']` — the same answer GET /:id/completeness
 * gives on its failure path — because "could not check" must never publish.
 *
 * @param {{id:string}} project
 * @param {{buildGraphForProject?:Function, collectCompleteness?:Function, log?:object}} [deps]
 * @returns {Promise<{blocked:boolean, complete:boolean, findings:object[], unavailable:string[]}>}
 */
async function releaseGate(project, deps = {}) {
    const log = deps.log || defaultLog;
    try {
        const buildGraph = deps.buildGraphForProject || require('../graphForProject').buildGraphForProject;
        const collect = deps.collectCompleteness || require('../completeness').collectCompleteness;
        const { graph, members, unavailable } = await buildGraph(project.id);
        const verdict = await collect({ graph, ...members, unavailable });
        return {
            // Anything but an explicit `false` blocks.
            blocked: verdict?.blocked !== false,
            complete: verdict?.complete === true,
            findings: Array.isArray(verdict?.findings) ? verdict.findings : [],
            unavailable: Array.isArray(verdict?.unavailable) ? verdict.unavailable : [],
        };
    } catch (err) {
        log.warn('[Projects] publish gate could not be computed:', err.message);
        return { ...UNKNOWN_VERDICT, unavailable: [...UNKNOWN_VERDICT.unavailable] };
    }
}

/**
 * The gate's verdict as it rides along with a plain DOWNLOAD.
 *
 * The downloaded body is saved as the Blueprint file, and that file travels to
 * other organisations. So each finding is rebuilt from an ALLOW-LIST: what was
 * found and about which object by title, never the object's id, its path or
 * its deep link into this instance.
 *
 * And never the producer's `message`. That sentence is free text written for
 * the screen of THIS instance, and it interpolates ids: a graph problem reads
 * "depends on an automation outside this project (aut_…)", and core/findings
 * `fromLegacy` has already dropped the `targetId` that would let it be
 * redacted the way capture.js `reportForFile` does. An allow-list of fields
 * cannot vouch for what is inside a sentence, so the sentence stays home; the
 * `code` says what was found and the receiver words it.
 */
function checksForDownload(verdict) {
    const text = (v) => (typeof v === 'string' && v ? v : null);
    return {
        blocked: verdict.blocked === true,
        complete: verdict.complete === true,
        unavailable: [...(verdict.unavailable || [])],
        findings: (verdict.findings || []).map(f => ({
            code: text(f?.code),
            severity: text(f?.severity),
            blockedAt: text(f?.blockedAt),
            kind: text(f?.kind),
            title: text(f?.targetRef?.title),
            remediation: text(f?.remediation),
        })),
    };
}

/**
 * Does this manifest say it is a pipeline release (Solution stages)?
 *
 * A pipeline release never leaves the instance (design D20): it is not a
 * Blueprint, may carry same-controller details a gallery export drops, and is
 * deployed to a stage only through the stage engine. Such a manifest is
 * therefore refused as an install or upgrade source.
 *
 * Two markers. `channel: 'pipeline'` is the explicit one. The one a pipeline
 * capture actually writes today is `solution.slots` / `solution.variables`:
 * manifest.js `buildManifest` sets them only for a pipeline release ("a
 * gallery file is exactly what it was before they existed"), so either
 * section being an array identifies one.
 */
function isPipelineManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return false;
    if (manifest.channel === 'pipeline') return true;
    const solution = manifest.solution;
    if (!solution || typeof solution !== 'object') return false;
    return Array.isArray(solution.slots) || Array.isArray(solution.variables);
}

module.exports = {
    releaseNotesFor,
    previousPublishedManifest,
    announcePublication,
    releaseGate,
    checksForDownload,
    isPipelineManifest,
    NOTE_CALL_TIMEOUT_MS,
    NOTE_DEADLINE_MS,
};
