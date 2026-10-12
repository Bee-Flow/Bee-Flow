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
 * POST /:id/documents also takes two options besides `starterId`:
 *   docType 'spreadsheet'  a spreadsheet. Its cells live in a datatable that is
 *                          made first (as Studio's startSheet does) and dropped
 *                          again when the document cannot be made. It sits behind
 *                          the Studio sheet gate (studioDocuments/sheetGate.js),
 *                          run only for this type, after the role gate and the
 *                          project checks: 403 `sheets_unavailable`, 503
 *                          `sheets_unknown`, and nothing is created.
 *   templateId             one of the CALLER's templates (their own, or shared
 *                          with them), copied into a private project document
 *                          from an explicit allow-list (docType, description,
 *                          body, css, settings without sampleValues and
 *                          sectionOverrides, plus `source`); categories, folder,
 *                          visibility and kind are never copied. A template that
 *                          is missing, not readable, not a template or a
 *                          spreadsheet is 404 `template_not_found`.
 * A spreadsheet cannot combine with starterId or templateId, nor templateId with
 * starterId: 400.
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
 * @param {object}   [deps.documents]           stores/documentStore surface ({ createDocument, getDocument })
 * @param {object}   [deps.cells]               core/documents/sheetCells surface ({ createSheetTable, dropSheetTable })
 * @param {Function} [deps.requireSheets]       the sheet gate (studioDocuments/sheetGate.makeSheetGate())
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

    /** @type {Function|null} */
    let boundSheetGate = null;
    const requireSheets = (req, res, next) => {
        if (!boundSheetGate) boundSheetGate = deps.requireSheets || require('../studioDocuments/sheetGate').makeSheetGate();
        return boundSheetGate(req, res, next);
    };
    const cells = () => deps.cells || require('../../core/documents/sheetCells');

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
        const { name, docType, starterId, templateId, locale } = req.body;
        const isSheet = docType === 'spreadsheet';
        if (templateId && starterId) throw badRequest('bad_request', 'Pass either templateId or starterId, not both.');
        if (isSheet && (templateId || starterId)) throw badRequest('bad_request', 'A spreadsheet cannot be made from a template or a starter.');
        let starter = null;
        if (starterId) {
            starter = (starters(locale) || []).find((s) => s.id === starterId) || null;
            if (!starter) throw badRequest('unknown_starter', 'starterId is not one of the document starters.');
        }
        const { project } = await loadTarget(req, 'document', 'documents');

        // Project content is a plain, private document of its owner: a starter
        // or template is a TEMPLATE in the library, and templates and team
        // sharing are the library's business, not the project's.
        // loadTarget has checked the creator belongs to the project's organisation.
        const base = { userId, name, kind: 'document', visibility: 'private', projectId: project.id, projectOrgChecked: true };

        let document;
        if (isSheet) {
            // The sheet gate, as a promise inside the handler (the Studio duplicateSheet way).
            await new Promise((resolve, reject) => {
                Promise.resolve().then(() => requireSheets(req, res, (err) => (err ? reject(err) : resolve(undefined)))).catch(reject);
            });
            const table = await cells().createSheetTable({ ownerUserId: userId, name });
            try {
                document = await documents().createDocument({ ...base, docType: 'spreadsheet', sheetTableId: table.id });
            } catch (err) {
                await cells().dropSheetTable(userId, table.id).catch(() => undefined);
                throw fromStoreError(err);
            }
        } else if (templateId) {
            // The store returns only what the caller may read; say nothing about the rest.
            const tpl = await documents().getDocument(templateId, userId);
            if (!tpl || tpl.kind !== 'template' || tpl.docType === 'spreadsheet') throw notFound('template_not_found', 'Template not found');
            // An explicit allow-list: never categories, folder, visibility or kind.
            const settings = { ...tpl.settings, source: { documentId: tpl.id, versionId: tpl.versionId } };
            delete settings.sampleValues;
            delete settings.sectionOverrides;
            try {
                document = await documents().createDocument({
                    ...base, docType: tpl.docType, description: tpl.description, bodyHtml: tpl.bodyHtml, css: tpl.css, settings,
                });
            } catch (err) {
                throw fromStoreError(err);
            }
        } else {
            try {
                document = await documents().createDocument({
                    ...base,
                    docType: docType || starter?.docType,
                    description: starter?.description,
                    bodyHtml: starter?.bodyHtml,
                    css: starter?.css,
                    settings: starter?.settings,
                });
            } catch (err) {
                throw fromStoreError(err);
            }
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
