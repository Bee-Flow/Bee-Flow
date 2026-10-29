// @typecheck strict
/**
 * What is filed into a project, and how those pieces are wired together.
 *
 *   GET  /:id/resources           everything filed into this project       (viewer+)
 *   PUT  /:id/resources           file a resource in, or take it out       (editor+ AND owner of the resource)
 *   POST /:id/resources/related   what else comes along when these are added (editor+)
 *   GET  /:id/graph               how the pieces of a Solution are wired   (viewer+)
 *   GET  /:id/completeness        what needs a person before publishing    (viewer+)
 *
 * Moved here unchanged from routes/projects.js. A FACTORY router:
 * `makeResourcesRouter(deps)` takes the registry, the stores, the filing
 * service and the graph loader, so routes/projects.js mounts it over the same
 * handles its route tests replace (routes/projects.resources.test.js,
 * routes/projects.graph.test.js), at the same place in the route table
 * (routes/projects.routetable.test.js).
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { HttpError, notFound } = require('../../core/http/errors');
const S = require('./schemas');
const { findRelatedParts } = require('../../projects/relatedParts');

/**
 * @param {object} deps
 * @param {import('./roleGate').ProjectRoleGate} deps.requireProjectRole  middleware named requireProjectRoleMw
 * @param {any} deps.projectStore  stores/projectStore; its row's kind (string) does not fit sectionsAllowedIn
 * @param {typeof import('../../projects/membership')} deps.membership  the kind registry
 * @param {ReturnType<typeof import('../../projects/itemFiling').makeItemFiling>} deps.itemFiling
 * @param {(projectId: string) => ReturnType<typeof import('../../projects/graphForProject').buildGraphForProject>} deps.buildGraphForProject
 * @param {Function} deps.completeness  () => projects/completeness, loaded on first use (its inferred types reject the graph)
 * @param {(req: import('express').Request) => string | undefined} deps.getUserId  the caller's user id
 * @param {(req: import('express').Request) => Promise<string[]>} deps.getUserGroups  the caller's group ids
 */
function makeResourcesRouter(deps) {
    const router = express.Router();
    const {
        projectStore, membership, itemFiling, buildGraphForProject, completeness, getUserId, getUserGroups,
    } = deps;
    // Every route here runs behind the project role gate, which guarantees the session user.
    const callerId = (/** @type {import('express').Request} */ req) => /** @type {string} */ (getUserId(req));
    const requireRole = deps.requireProjectRole;

    /**
     * The sections the resources listing shows for a project of this kind, or
     * null for "every section". The registry (projects/membership.js) decides
     * which kinds each container holds; an older registry without that answer
     * keeps the listing as it was.
     * @param {'workspace'|'solution'|null} containerKind
     * @returns {Set<string>|null}
     */
    function sectionsAllowedIn(containerKind) {
        if (typeof membership.sectionsFor !== 'function') return null;
        const sections = /** @type {Array<string | { section?: string }>} */ (membership.sectionsFor(containerKind));
        if (!Array.isArray(sections)) return null;
        return new Set(sections.flatMap((entry) => {
            const section = typeof entry === 'string' ? entry : entry?.section;
            return section ? [section] : [];
        }));

    }

    /**
     * May a resource of `kind` be filed into a project of `containerKind`?
     * Same registry, same fallback.
     * @param {string} kind
     * @param {string|null|undefined} containerKind
     */
    function kindAllowedIn(kind, containerKind) {
        if (typeof membership.isAllowedIn !== 'function') return true;
        return membership.isAllowedIn(kind, containerKind) !== false;
    }

    // ── Project resources: notebooks, apps, automations, webpages, approvals ──
    //
    // One project, one place to see everything in it. Each resource keeps working
    // standalone (project_id NULL); membership is additive, never a move that takes
    // something away from its owner.
    //
    // The set of kinds lives in projects/membership.js, not here: the listing, the
    // file-in/out switch below and the delete-time detacher all read from it, and
    // the last time those three were maintained by hand they drifted far enough
    // apart that a shipped column was never created at all.

    // GET /:id/resources — everything filed into this project (viewer+)
    router.get('/:id/resources', requireRole('viewer'), async (req, res) => {
        const projectId = req.params.id;
        const project = await projectStore.getProject(projectId);
        if (!project) throw notFound();
        // Only the sections this kind of project holds: a Solution has no
        // meetings, a collaborative project no automations. A legacy project
        // (kind null) shows every section.
        const allowed = sectionsAllowedIn(project.kind);
        // Independently, so one unavailable store degrades that section rather than
        // blanking the whole project page.
        const load = async (/** @type {string} */ label, /** @type {() => Promise<unknown>} */ fn) => {
            try { return await fn(); } catch (err) {
                log.warn(`[Projects] could not list ${label}:`, err.message);
                return null;   // null = "unavailable", distinct from [] = "none"
            }
        };

        // Approvals are listed against the caller, not the project — the registry
        // header explains why they alone stay viewer-scoped.
        const viewer = { userId: callerId(req), groupIds: await getUserGroups(req) };

        const kinds = membership.listKinds().filter(k => !allowed || allowed.has(k.section));
        const sections = await Promise.all(
            kinds.map(k => load(k.section, () => k.list(projectId, viewer))),
        );

        /** @type {Record<string, unknown>} */
        const body = { role: req.projectRole, kind: project.kind };
        kinds.forEach((k, i) => { body[k.section] = sections[i]; });
        res.json(body);
    });

    /**
     * PUT /:id/resources — file a resource into this project, or take it out.
     *
     * Body: { kind, id, attach: boolean } — kind being any registered MOVABLE kind
     * (see projects/membership.js). Approvals are not movable: they are stamped
     * with their project when they are created and never re-filed.
     *
     * Requires editor on the project AND ownership of the resource. Ownership is
     * enforced by the stores (each setter matches on user_id), so a member cannot
     * pull a colleague's notebook into a project, and cannot push one out either.
     */
    router.put('/:id/resources', requireRole('editor'), validate({ body: S.ResourceBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof S.ResourceBody>, import('qs').ParsedQs>} */ req, res) => {
        try {
            const userId = callerId(req);
            const { kind, id, attach = true } = req.body || {};
            if (!kind || !id) return res.status(400).json({ error: 'kind and id are required' });

            const entry = membership.getKind(kind);
            // A kind with no setProject is not movable by design (approvals are
            // stamped at INSERT and never re-filed), so it is rejected here rather
            // than reaching a stub that throws.
            if (!entry || typeof entry.setProject !== 'function') {
                const movable = membership.movableKinds().map(k => k.kind).join(', ');
                return res.status(400).json({ error: `kind must be one of: ${movable}` });
            }

            const project = await projectStore.getProject(req.params.id);
            if (!project) return res.status(404).json({ error: 'Not found' });
            // Filing IN must fit the container (no automations in a collaborative
            // project, no documents in a Solution). Taking something OUT is always
            // allowed: that is how a project classified after the fact is tidied.
            if (attach && !kindAllowedIn(kind, project.kind)) {
                // `kind` is a registered kind by now (checked above), never free text.
                const label = kind.replace(/_/g, ' ');
                return res.status(400).json({
                    error: project.kind === 'solution'
                        ? `A Studio Solution does not hold items of kind "${label}"; they belong in a project.`
                        : `A project does not hold items of kind "${label}"; they belong in a Studio Solution.`,
                    code: 'KIND_NOT_ALLOWED',
                });
            }

            // The move itself, the feed entry of every project it touched, and
            // the co-editing state, comment threads and compliance signal that
            // belong to the project an item leaves (projects/itemFiling.js).
            const ok = await itemFiling.fileItem({ entry, kind, id, userId, projectId: req.params.id, attach, req });
            if (!ok) return res.status(404).json({ error: 'Not found, or not yours to move' });
            res.json({ success: true });
        } catch (err) {
            // A refusal a kind states DELIBERATELY (a lost race on the project row,
            // a cap it would exceed) carries its own status and a message written
            // to be read. Anything else is a 500 with the detail kept in the log:
            // a raw err.message can carry SQL text, column names and constraint
            // names, which is why only errors that opted in are surfaced.
            const status = Number(err?.status);
            if (Number.isInteger(status) && status >= 400 && status < 500) {
                return res.status(status).json({ error: err.message, code: err.code || undefined });
            }
            throw err;
        }
    });

    /**
     * POST /:id/resources/related — what else comes along when these are added.
     *
     * Body: { items: [{ kind, id }] }, the parts about to be filed. Answers the
     * transitive set of parts they USE (projects/relatedParts.js), each with who
     * needs it and whether it can be filed here. A POST because the list can be
     * long; it changes nothing. Editor, like the PUT it prepares: the answer names
     * parts of the caller only, but it is only worth asking by someone who can add.
     */
    router.post('/:id/resources/related', requireRole('editor'), validate({ body: S.RelatedBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof S.RelatedBody>, import('qs').ParsedQs>} */ req, res) => {
        const project = await projectStore.getProject(req.params.id);
        if (!project) throw notFound();
        for (const { kind } of req.body.items) {
            const entry = membership.getKind(kind);
            if (!entry || typeof entry.setProject !== 'function') {
                const movable = membership.movableKinds().map(k => k.kind).join(', ');
                throw new HttpError(400, 'INVALID_KIND', `kind must be one of: ${movable}`);
            }
            if (!kindAllowedIn(kind, project.kind)) {
                throw new HttpError(400, 'KIND_NOT_ALLOWED', `A ${project.kind === 'solution' ? 'Studio Solution' : 'project'} does not hold items of kind "${kind.replace(/_/g, ' ')}".`);
            }
        }
        res.json(await findRelatedParts({ project, userId: callerId(req), req, items: req.body.items }));
    });

    /**
     * GET /:id/graph — how the pieces of this Solution are wired to each other.
     *
     * Viewer+, because it says nothing the Content tab does not already list — it
     * only draws the lines between those entries. The reading is done by
     * buildGraphForProject() from routes/projects.js (projects/graphForProject.js), which
     * GET /:id/completeness shares.
     *
     * Three loading decisions worth stating:
     *
     *  1. EVERY automation KIND, not just top-level ones. A `call_block` pointing
     *     at a reusable Step that IS in this project would otherwise be reported as
     *     an external dependency, purely because the listing query filters it out.
     *  2. FULL app definitions, one query each. listProjectApps returns meta only,
     *     and the wiring lives in the definition. N is a project's worth of apps.
     *  3. TWO PASSES, so "outside this project" can be told apart from "gone".
     *     The first pass names the references it could not place; only those ids
     *     are looked up, and the second pass says which exist. Reporting an automation
     *     as deleted when the truth is "I did not check" is the worse error, and
     *     the graph refuses to do it — see PROBLEM.UNRESOLVED.
     *  4. THE SECOND PASS IS FOR AUTOMATIONS ONLY, and deliberately so. A datatable
     *     is scope-addressed: answering "does this id exist anywhere" would mean
     *     naming a tenant to look in, and guessing one is worse than not knowing.
     *     A knowledge base could be looked up, and is not: the only thing the
     *     answer changes is whether the sentence says "gone" or "not in this
     *     project", and buying that wording with an existence oracle over another
     *     tenant's ids is a bad trade. A skill is never a project member at all.
     *     All three stay UNRESOLVED, which is the honest word for them and still
     *     counts as a dependency.
     *  5. AGENT CONFIGS ARE LOADED IN FULL, and never leave the server. The wiring
     *     (`knowledge_base_ids`, `attachedSkillIds`) lives in the config, which the
     *     Content-tab listing deliberately does not carry. Only the EDGES reach the
     *     client — ids the caller can already see in this project, never the
     *     agent's instructions or its tool grants.
     */
    router.get('/:id/graph', requireRole('viewer'), async (req, res) => {
        const { graph } = await buildGraphForProject(req.params.id);
        res.json({ ...graph, role: req.projectRole });
    });

    /**
     * GET /:id/completeness — "Te controleren": everything in this Solution that
     * needs a person, and the one verdict the publish button reads.
     *
     * Viewer+, like the graph it is built on: it names the same objects the Content
     * listing already shows and adds the validators' own sentences about them.
     *
     * THE FAILURE PATH IS THE CONTRACT. A 500 here must be read by the client as
     * "blocked", never as "no findings" — an empty list is what a clean Solution
     * and an unreachable database look like from the outside, and only one of them
     * may publish. The 200 path says so explicitly (`blocked`, `complete`,
     * `unavailable`); the 500 path carries `blocked: true` for the same reason, so
     * a client that renders the body without checking the status still fails shut.
     */
    router.get('/:id/completeness', requireRole('viewer'), async (req, res) => {
        try {
            const { graph, members, unavailable } = await buildGraphForProject(req.params.id);
            const { collectCompleteness } = completeness();
            const result = await collectCompleteness({ graph, ...members, unavailable });
            res.json({ ...result, role: req.projectRole });
        } catch (err) {
            log.error('[Projects] Completeness error:', err.message);
            throw new HttpError(500, 'completeness_failed', 'Request failed', {
                blocked: true, complete: false, findings: [], unavailable: ['all'],
            });
        }
    });

    return router;
}

module.exports = { makeResourcesRouter };
