'use strict';

const express = require('express');
const { z } = require('zod');
const { bodyOf, choice } = require('../../core/http/schemaParts');
const { validate } = require('../../core/http/validate');
const { requireAuth } = require('../../auth/permissions');
const sharing = require('../../stores/lib/documentSharing');

const ids = z.array(z.string().trim().min(1).max(200)).max(200).default([]);
const SharingBody = bodyOf({
    audience: choice(['private', 'organisation', 'restricted'], 'audience is private, organisation or restricted.'),
    sharedGroups: ids,
    sharedUserIds: ids,
    access: choice(['view', 'edit'], 'access is view or edit.').default('view'),
}, 'Sharing a document');

function makeDocumentSharingRouter({ store = sharing, auth = requireAuth, notebookGate } = {}) {
    const router = express.Router();
    const gate = notebookGate || require('../projects/notebookGate').makeNotebookGate();
    for (const [prefix, type] of [['', 'document'], ['/notebooks', 'notebook']]) {
        const middleware = type === 'notebook' ? [auth, gate] : [auth];
        router.get(`${prefix}/:id/sharing`, ...middleware, async (req, res) => {
            res.json({ sharing: await store.getSharing(type, req.params.id, req.session.user.id) });
        });
        router.get(`${prefix}/:id/sharing/principals`, ...middleware, async (req, res) => {
            res.json(await store.sharingDirectory(type, req.params.id, req.session.user.id));
        });
        router.put(`${prefix}/:id/sharing`, ...middleware, validate({ body: SharingBody }), async (req, res) => {
            res.json({ sharing: await store.setSharing(type, req.params.id, req.session.user.id, req.body) });
        });
    }
    return router;
}

module.exports = { makeDocumentSharingRouter };
