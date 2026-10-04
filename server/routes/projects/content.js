/**
 * Project content routes — a new document or notebook, made inside a project.
 *
 *   POST /:id/documents   editor   a document owned by the caller, filed here
 *   POST /:id/notebooks   editor   a notebook owned by the caller, filed here
 *
 * What is already in a project is listed by GET /:id/resources, and an existing
 * document, meeting note or notebook is filed in or taken out with
 * PUT /:id/resources; both read projects/membership.js. A meeting note is filed
 * at upload time instead: POST /api/transcriptions takes an optional projectId.
 *
 * Whatever is made here is the CALLER's, exactly as if they had made it in
 * their own library and filed it: they alone may delete it, and the project
 * owner may take it out of the project again. Only a collaborative workspace
 * (or a legacy project that is not classified yet) holds documents; a Studio
 * Solution is refused with 409, as membership.isAllowedIn says.
 *
 * A notebook made here is a notebook all the same, opened only through
 * /api/notebooks: the same module, capability, feature and `use_notebooks`
 * gates stand in front of its create (routes/projects/notebookGate.js), after
 * the role gate so a non-member still reads a 404. A refusal is 403
 * `notebooks_unavailable`, and nothing is created.
 *
 * A FACTORY router: `makeContentRouter(deps)` takes every collaborator, so its
 * test serves it with fakes and no module mocking; the default export is
 * `makeContentRouter()` over the real modules, for routes/projects.js to mount
 * (`router.use('/', require('./projects/content'))`) behind the /api/projects
 * mount's session and licence gates. Every `/:id…` route starts with
 * `requireProjectRole`: 404 for somebody who is not a member (a project's
 * existence is not probeable), 403 for a role that is too low.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { HttpError, badRequest, conflict, notFound } = require('../../core/http/errors');
const S = require('./contentSchemas');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => middleware named requireProjectRoleMw
 * @param {Function} [deps.getProject]          (id) => project | null
 * @param {Function} [deps.getUser]             (id) => user | null (its organizationId)
 * @param {object}   [deps.documents]           stores/documentStore surface ({ createDocument })
 * @param {object}   [deps.notebooks]           stores/notebookStore surface ({ createNotebook })
 * @param {Function} [deps.starters]            (locale) => document starters
 * @param {object}   [deps.membership]          projects/membership surface ({ isAllowedIn })
 * @param {object}   [deps.changeFeed]          projects/changeFeed surface ({ recordItemCreated })
 * @param {Function} [deps.createLimiter]       rate-limit middleware for the two creates
 * @param {Function} [deps.requireNotebooks]    the notebooks gates (notebookGate.makeNotebookGate())
 */
function makeContentRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });

    // The real gate is required on first use, so loading this file does not
    // load the auth and user stores with it.
    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const getProject = (id) => (deps.getProject || require('../../stores/projectStore').getProject)(id);
    const getUser = (id) => (deps.getUser || require('../../stores/userStore').getUser)(id);
    const documents = () => deps.documents || require('../../stores/documentStore');
    const notebooks = () => deps.notebooks || require('../../stores/notebookStore');
    const starters = (locale) => (deps.starters || require('../../core/documents/documentStarters').starters)(locale);
    const membership = () => deps.membership || require('../../projects/membership');
    const orgOf = () => deps.projectOrg || require('../../projects/projectOrg');
    const changeFeed = () => deps.changeFeed || require('../../projects/changeFeed');

    // Creating is cheap per call but not free (a document composes its house
    // style and writes a first revision). Named, so the ceiling holds across
    // replicas when Redis is there.
    const createLimiter = deps.createLimiter || require('../../utils/perUserRateLimit')
        .perUserRateLimit({ windowMs: 60_000, max: 30, name: 'project-content-create' });

    const requireNotebooks = deps.requireNotebooks || require('./notebookGate').makeNotebookGate();

    const userIdOf = (req) => req.session?.user?.id;

    /**
     * The project behind a passed role gate, checked to be a container that
     * holds `kind`, and in the creator's own organisation (what is made here is
     * the creator's, and its organisation is theirs; the two must be the same
     * or the project would hold another tenant's item).
     */
    async function loadTarget(req, kind, noun) {
        const project = await getProject(req.params.id);
        // The role gate passed a moment ago; the project can still vanish mid-request.
        if (!project) throw notFound('not_found', 'Not found');
        if (!membership().isAllowedIn(kind, project.kind ?? null)) {
            throw conflict('KIND_NOT_ALLOWED', `A Studio Solution holds no ${noun}. Create it in a project instead.`);
        }
        const user = await getUser(userIdOf(req));
        const { projectOrgOf, belongsToProjectOrg } = orgOf();
        if (!await belongsToProjectOrg(userIdOf(req), await projectOrgOf(project))) {
            throw conflict('project_org_mismatch', `This project belongs to another organization, so a ${kind} you create cannot be filed in it.`);
        }
        return { project, user };
    }

    /**
     * One "created" entry in the project's feed: the audit row and its live
     * event in one transaction (projects/changeFeed.recordItemCreated), ids
     * only. Never a `resource_added` next to it: the item was made here, not
     * filed from elsewhere, and two rows would count it twice in "since your
     * last visit". After the item exists, so best-effort: the recorder never
     * throws (it logs), because failing the request here would make the
     * client retry and create a second one.
     */
    async function recordCreated(projectId, actorId, itemType, itemId) {
        await changeFeed().recordItemCreated({ projectId, itemType, itemId, actorId });
    }

    /**
     * A refusal the document store states on purpose (a cap, an organisation
     * mismatch, house styling that is briefly unavailable) carries a status
     * and a sentence; anything else stays a generic 500.
     */
    function fromStoreError(err) {
        const status = Number(err?.status);
        if (Number.isInteger(status) && status >= 400 && status < 600 && status !== 500) {
            return new HttpError(status, err.errorClass || err.code || 'document_invalid', err.message);
        }
        return err;
    }

    // ── Documents ─────────────────────────────────────────────────────

    router.post('/:id/documents', requireRole('editor'), createLimiter, validate({ body: S.NewDocumentBody }), async (req, res) => {
        const userId = userIdOf(req);
        const { name, docType, starterId, locale } = req.body;
        let starter = null;
        if (starterId) {
            starter = (starters(locale) || []).find((s) => s.id === starterId) || null;
            if (!starter) throw badRequest('unknown_starter', 'starterId is not one of the document starters.');
        }
        const { project } = await loadTarget(req, 'document', 'documents');

        let document;
        try {
            document = await documents().createDocument({
                userId,
                name,
                docType: docType || starter?.docType,
                description: starter?.description,
                bodyHtml: starter?.bodyHtml,
                css: starter?.css,
                settings: starter?.settings,
                // Project content is a plain, private document of its owner: a
                // starter is a TEMPLATE in the library, and templates and team
                // sharing are the library's business, not the project's.
                kind: 'document',
                visibility: 'private',
                projectId: project.id,
                // loadTarget has checked the creator belongs to the project's organisation.
                projectOrgChecked: true,
            });
        } catch (err) {
            throw fromStoreError(err);
        }

        await recordCreated(project.id, userId, 'document', document.id);
        res.status(201).json({ document });
    });

    // ── Notebooks ─────────────────────────────────────────────────────

    router.post('/:id/notebooks', requireRole('editor'), requireNotebooks, createLimiter, validate({ body: S.NewNotebookBody }), async (req, res) => {
        const userId = userIdOf(req);
        const { name, description } = req.body;
        const { project, user } = await loadTarget(req, 'notebook', 'notebooks');

        const notebook = await notebooks().createNotebook({
            userId,
            name,
            description: description || '',
            projectId: project.id,
            organizationId: orgOf().itemOrgFor(project, user),
        });

        await recordCreated(project.id, userId, 'notebook', notebook.id);
        res.status(201).json({ notebook });
    });

    return router;
}

module.exports = makeContentRouter();
module.exports.makeContentRouter = makeContentRouter;
