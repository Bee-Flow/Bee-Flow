// @typecheck
/**
 * PUT /api/projects/:id/kind — which side of the split a project is on.
 *
 *   PUT /:id/kind { kind: 'workspace'|'solution' }   owner
 *     200  the project
 *     409  KIND_ALREADY_SET          its owner already decided
 *     409  KIND_HOLDS_OTHER_CONTENT  it holds items the other side refuses;
 *                                    `details.held` counts them per section
 *
 * Who may decide: the project's owner, while the kind is still NULL (a legacy
 * project) or is only the backfill's guess (`kindGuessed`,
 * migrations/project-kind-backfill-2026-09.js). The owner can correct that
 * guess once; after that the kind is theirs and set for good
 * (stores/projectStore.setProjectKind).
 *
 * What it may hide: nothing. A project that holds items the target refuses
 * is refused (projects/kindChange.js explains why a flag flip would leave
 * them filed, readable and unlisted). The owner takes them out first.
 *
 * A FACTORY router: `makeKindRouter(deps)` takes every collaborator, so its
 * test serves it with fakes and no module mocking. routes/projects.js mounts
 * it over its own project store, registry and change feed.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { HttpError, notFound } = require('../../core/http/errors');
const S = require('./schemas');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]   (minRole) => middleware named requireProjectRoleMw
 * @param {object}   [deps.store]                stores/projectStore ({ getProject, setProjectKind })
 * @param {object}   [deps.kindChange]           projects/kindChange ({ refusedContent })
 * @param {Function} [deps.recordProjectChange]  projects/changeFeed recordProjectChange
 */
function makeKindRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const store = () => deps.store || require('../../stores/projectStore');
    const kindChange = () => deps.kindChange || require('../../projects/kindChange');
    const recordProjectChange = (/** @type {any[]} */ ...a) =>
        (deps.recordProjectChange || require('../../projects/changeFeed').recordProjectChange)(...a);

    /** 409: the owner (or the backfill's corrected guess) already decided. */
    function alreadySet(/** @type {string|null} */ kind) {
        const what = kind === 'solution' ? 'a Studio Solution' : 'a collaborative project';
        return new HttpError(409, 'KIND_ALREADY_SET',
            `This is already ${what}. A project's kind is set once.`, { kind });
    }

    router.put('/:id/kind', requireRole('owner'), validate({ body: S.KindBody }), async (req, res) => {
        const { kind } = req.body;
        const project = await store().getProject(req.params.id);
        if (!project) throw notFound();
        if (project.kind !== null && project.kind !== undefined && !project.kindGuessed) {
            throw alreadySet(project.kind);
        }

        const held = await kindChange().refusedContent(project, kind);
        if (Object.keys(held).length > 0) {
            const where = kind === 'solution' ? 'a Studio Solution' : 'a collaborative project';
            throw new HttpError(409, 'KIND_HOLDS_OTHER_CONTENT',
                `This project still holds items ${where} cannot hold. Take them out first, then try again.`,
                { kind, held });
        }

        const updated = await store().setProjectKind(req.params.id, kind);
        if (!updated) {
            // Deleted, or decided in another tab, since the read above.
            const current = await store().getProject(req.params.id);
            if (!current) throw notFound();
            throw alreadySet(current.kind);
        }
        await recordProjectChange(req.params.id, req.session?.user?.id, 'kind_set', { kind });
        res.json(updated);
    });

    return router;
}

module.exports = makeKindRouter();
module.exports.makeKindRouter = makeKindRouter;
